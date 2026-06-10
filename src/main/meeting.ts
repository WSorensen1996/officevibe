/**
 * Meetings — the main-process core of the meeting suite (record + live transcript
 * persistence; the analysis driver arrives in a later phase and lives here too).
 *
 * On-disk layout, one folder per meeting under the active project root:
 *   meetings/<meetingId>/
 *     metadata.json     identity + lifecycle (atomic writes; crash-safe)
 *     recording.webm    grown by appendFileSync per ~2s MediaRecorder chunk, so a
 *                       crash mid-meeting loses at most the last chunk
 *     transcript.jsonl  append-only {t0,t1,source,text} rows — never rotated, it IS
 *                       the meeting record
 *     frames/*.jpg      periodic screen captures for the analyst to Read
 *     insights.jsonl    analyst meeting-insight rows (Phase 4)
 *     summary.md        written by the analyst at wrap-up (Phase 5)
 *
 * Electron-free (constructor-injected root + emit) so it unit-tests like
 * ProjectManager/atomicJson.
 */
import {
  existsSync, mkdirSync, appendFileSync, readFileSync, readdirSync, statSync
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { atomicWriteJson } from './atomicJson';

export interface MeetingSources {
  mic: boolean;
  systemAudio: boolean;
  /** Human-readable device label (e.g. "Monitor of Built-in Audio") for the record. */
  systemAudioDeviceLabel?: string;
  screen: boolean;
}

export interface MeetingMeta {
  id: string;
  title: string;
  startedAt: string;             // ISO
  endedAt?: string;              // ISO — set on stop
  durationSec?: number;
  status: 'recording' | 'ended' | 'interrupted';
  sources: MeetingSources;
  language: string;              // 'auto' | 'en' | 'da' | …
  model: string;                 // whisper model id used for live transcription
  hasSummary?: boolean;
  hasRecording?: boolean;
  /** Bytes of recording.webm at last read — display-only. */
  recordingBytes?: number;
  segmentCount?: number;
}

export interface TranscriptSegment {
  /** Seconds since meeting start. */
  t0: number;
  t1: number;
  source: 'mic' | 'system';
  text: string;
}

/** One analyst insight, ingested from a {type:"meeting-insight"} outbox file. */
export interface MeetingInsight {
  ts: string;
  by: string;
  meetingId: string;
  kind: 'recommendation' | 'proposal' | 'action-item' | 'note' | 'question';
  text: string;
  quote?: string;
  suggestedTask?: { title: string; description?: string };
}

const MEETING_ID_RE = /^m-[A-Za-z0-9-]{4,120}$/;
const INSIGHT_KINDS = ['recommendation', 'proposal', 'action-item', 'note', 'question'] as const;

/** The analyst's fixed hive id (PTY = `pty-analyst`); the renderer spawns it
 *  lazily on first meeting start. */
export const ANALYST_AGENT_ID = 'analyst';

/** Filesystem- and sort-safe timestamp (matches project.ts's stamp()). */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function shortRand(): string {
  return randomBytes(4).toString('hex');
}

export class MeetingManager {
  /**
   * @param getRoot Lazily resolve the active project root (meetings live inside it).
   * @param emit    Renderer event sink (main sets it to webContents.send); no-op in tests.
   */
  constructor(
    private getRoot: () => string | null,
    private emit?: (channel: string, payload: unknown) => void
  ) {}

  /** The meeting currently being recorded (at most one at a time), or null. */
  private activeId: string | null = null;

  /** Phase-4 hook: the analysis driver subscribes to fresh transcript segments. */
  private transcriptListener: ((meetingId: string, segments: TranscriptSegment[]) => void) | null = null;
  setTranscriptListener(fn: ((meetingId: string, segments: TranscriptSegment[]) => void) | null): void {
    this.transcriptListener = fn;
  }

  // — paths —
  private meetingsDir(): string | null {
    const root = this.getRoot();
    return root ? join(root, 'meetings') : null;
  }
  /** Validated absolute dir for a meeting id; null when the id is malformed (the
   *  id regex is the path-traversal guard — no separators/dots can pass it). */
  meetingDir(id: string): string | null {
    const dir = this.meetingsDir();
    if (!dir || !MEETING_ID_RE.test(id)) return null;
    return join(dir, id);
  }
  enabled(): boolean {
    return this.getRoot() !== null;
  }
  activeMeetingId(): string | null {
    return this.activeId;
  }

  // — lifecycle —

  start(opts: { title?: string; sources: MeetingSources; language: string; model: string }):
    { ok: true; meta: MeetingMeta } | { ok: false; error: string } {
    const dirRoot = this.meetingsDir();
    if (!dirRoot) return { ok: false, error: 'no active project' };
    if (this.activeId) return { ok: false, error: `meeting ${this.activeId} is already recording` };
    const id = `m-${stamp()}-${shortRand()}`;
    const dir = this.meetingDir(id)!;
    try {
      mkdirSync(join(dir, 'frames'), { recursive: true });
      const meta: MeetingMeta = {
        id,
        title: (opts.title ?? '').trim().slice(0, 120) || `Meeting ${new Date().toLocaleString()}`,
        startedAt: new Date().toISOString(),
        status: 'recording',
        sources: {
          mic: !!opts.sources?.mic,
          systemAudio: !!opts.sources?.systemAudio,
          systemAudioDeviceLabel: typeof opts.sources?.systemAudioDeviceLabel === 'string'
            ? opts.sources.systemAudioDeviceLabel.slice(0, 120) : undefined,
          screen: !!opts.sources?.screen
        },
        language: String(opts.language ?? 'auto').slice(0, 16),
        model: String(opts.model ?? 'whisper-base').slice(0, 60)
      };
      atomicWriteJson(join(dir, 'metadata.json'), meta);
      this.activeId = id;
      this.emitState(meta);
      return { ok: true, meta };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Append one MediaRecorder chunk to recording.webm. Hot path (every ~2s): plain
   *  appendFileSync keeps the file decodable up to the last complete cluster even
   *  after a hard crash. */
  appendChunk(id: string, data: Uint8Array): { ok: boolean; error?: string } {
    const dir = this.meetingDir(id);
    if (!dir || !existsSync(dir)) return { ok: false, error: 'unknown meeting' };
    try {
      appendFileSync(join(dir, 'recording.webm'), data);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Persist one screen frame (JPEG) named by its offset from meeting start, so a
   *  directory listing is also the visual timeline. Returns the absolute path —
   *  the analysis driver hands these to the analyst to Read. */
  writeFrame(id: string, elapsedMs: number, data: Uint8Array): { ok: true; path: string } | { ok: false; error: string } {
    const dir = this.meetingDir(id);
    if (!dir || !existsSync(dir)) return { ok: false, error: 'unknown meeting' };
    const sec = Math.max(0, Math.floor((Number(elapsedMs) || 0) / 1000));
    const name = `frame-${String(sec).padStart(6, '0')}.jpg`;
    try {
      const p = join(dir, 'frames', name);
      mkdirSync(join(dir, 'frames'), { recursive: true });
      appendFileSync(p, data, { flag: 'w' }); // overwrite same-second frames
      return { ok: true, path: p };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Append finalized transcript segments (renderer-transcribed) to the meeting's
   *  jsonl, notify the analysis driver, and push them to the renderer feed. */
  appendTranscript(id: string, segments: TranscriptSegment[]): { ok: boolean; error?: string } {
    const dir = this.meetingDir(id);
    if (!dir || !existsSync(dir)) return { ok: false, error: 'unknown meeting' };
    const clean = (Array.isArray(segments) ? segments : [])
      .filter((s) => s && typeof s.text === 'string' && s.text.trim())
      .map((s) => ({
        t0: Math.max(0, Number(s.t0) || 0),
        t1: Math.max(0, Number(s.t1) || 0),
        source: s.source === 'system' ? 'system' as const : 'mic' as const,
        text: s.text.trim().slice(0, 4000)
      }));
    if (clean.length === 0) return { ok: true };
    try {
      appendFileSync(
        join(dir, 'transcript.jsonl'),
        clean.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf8'
      );
      this.emit?.('meeting:transcript', { meetingId: id, segments: clean });
      try { this.transcriptListener?.(id, clean); } catch { /* driver hiccup — never block the feed */ }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  stop(id: string, durationSec?: number): { ok: boolean; error?: string } {
    const dir = this.meetingDir(id);
    if (!dir || !existsSync(dir)) return { ok: false, error: 'unknown meeting' };
    const meta = this.readMeta(dir);
    if (!meta) return { ok: false, error: 'missing metadata' };
    meta.status = 'ended';
    meta.endedAt = new Date().toISOString();
    meta.durationSec = typeof durationSec === 'number' && durationSec >= 0
      ? Math.round(durationSec)
      : Math.max(0, Math.round((Date.parse(meta.endedAt) - Date.parse(meta.startedAt)) / 1000));
    try {
      atomicWriteJson(join(dir, 'metadata.json'), meta);
      if (this.activeId === id) this.activeId = null;
      this.emitState(meta);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** Boot-time janitor: any meeting still marked 'recording' that is NOT the live
   *  one was cut short by a crash/quit — flip it to 'interrupted' so the history
   *  view is honest. Returns how many were repaired. */
  scanForOrphans(): number {
    const dirRoot = this.meetingsDir();
    if (!dirRoot || !existsSync(dirRoot)) return 0;
    let repaired = 0;
    for (const id of readdirSync(dirRoot)) {
      if (!MEETING_ID_RE.test(id) || id === this.activeId) continue;
      const dir = join(dirRoot, id);
      const meta = this.readMeta(dir);
      if (!meta || meta.status !== 'recording') continue;
      meta.status = 'interrupted';
      meta.endedAt = meta.endedAt ?? new Date().toISOString();
      try { atomicWriteJson(join(dir, 'metadata.json'), meta); repaired++; } catch { /* skip */ }
    }
    return repaired;
  }

  // — reads (IPC/UI) —

  list(): MeetingMeta[] {
    const dirRoot = this.meetingsDir();
    if (!dirRoot || !existsSync(dirRoot)) return [];
    const out: MeetingMeta[] = [];
    for (const id of readdirSync(dirRoot)) {
      if (!MEETING_ID_RE.test(id)) continue;
      const dir = join(dirRoot, id);
      const meta = this.readMeta(dir);
      if (!meta) continue;
      out.push(this.decorate(dir, meta));
    }
    return out.sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  read(id: string): { ok: true; meta: MeetingMeta; transcript: TranscriptSegment[]; insights: MeetingInsight[]; summaryMd: string | null; recordingPath: string | null } | { ok: false; error: string } {
    const dir = this.meetingDir(id);
    if (!dir || !existsSync(dir)) return { ok: false, error: 'unknown meeting' };
    const meta = this.readMeta(dir);
    if (!meta) return { ok: false, error: 'missing metadata' };
    const recording = join(dir, 'recording.webm');
    return {
      ok: true,
      meta: this.decorate(dir, meta),
      transcript: this.readJsonl<TranscriptSegment>(join(dir, 'transcript.jsonl')),
      insights: this.readJsonl<MeetingInsight>(join(dir, 'insights.jsonl')),
      summaryMd: existsSync(join(dir, 'summary.md'))
        ? readFileSync(join(dir, 'summary.md'), 'utf8')
        : null,
      recordingPath: existsSync(recording) ? recording : null
    };
  }

  /** Ingest a validated analyst insight (Phase 4 wires routeOnce → here). Exposed
   *  now so tests can cover the validation early. */
  ingestInsight(by: string, raw: {
    meetingId?: unknown; kind?: unknown; text?: unknown; quote?: unknown;
    suggestedTask?: { title?: unknown; description?: unknown } | null;
  }): { ok: boolean; error?: string } {
    const meetingId = typeof raw.meetingId === 'string' ? raw.meetingId : '';
    const dir = this.meetingDir(meetingId);
    if (!dir || !existsSync(dir)) return { ok: false, error: 'unknown meeting' };
    const text = typeof raw.text === 'string' ? raw.text.trim().slice(0, 2000) : '';
    if (!text) return { ok: false, error: 'empty insight text' };
    const kind = (INSIGHT_KINDS as readonly string[]).includes(raw.kind as string)
      ? raw.kind as MeetingInsight['kind'] : 'note';
    const st = raw.suggestedTask;
    const suggestedTask = st && typeof st.title === 'string' && st.title.trim()
      ? {
          title: st.title.trim().slice(0, 120),
          description: typeof st.description === 'string' ? st.description.trim().slice(0, 2000) : undefined
        }
      : undefined;
    const insight: MeetingInsight = {
      ts: new Date().toISOString(),
      by,
      meetingId,
      kind,
      text,
      quote: typeof raw.quote === 'string' ? raw.quote.trim().slice(0, 600) || undefined : undefined,
      suggestedTask
    };
    try {
      appendFileSync(join(dir, 'insights.jsonl'), JSON.stringify(insight) + '\n', 'utf8');
      this.emit?.('meeting:insight', insight);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  // — helpers —

  private emitState(meta: MeetingMeta): void {
    this.emit?.('meeting:state', meta);
  }

  private readMeta(dir: string): MeetingMeta | null {
    try {
      const meta = JSON.parse(readFileSync(join(dir, 'metadata.json'), 'utf8')) as MeetingMeta;
      return meta && typeof meta === 'object' && typeof meta.id === 'string' ? meta : null;
    } catch {
      return null;
    }
  }

  /** Cheap display-only enrichments computed at read time (never persisted hot). */
  private decorate(dir: string, meta: MeetingMeta): MeetingMeta {
    let recordingBytes: number | undefined;
    try { recordingBytes = statSync(join(dir, 'recording.webm')).size; } catch { /* none yet */ }
    let segmentCount: number | undefined;
    try {
      const raw = readFileSync(join(dir, 'transcript.jsonl'), 'utf8');
      segmentCount = raw ? raw.trim().split('\n').filter(Boolean).length : 0;
    } catch { /* none yet */ }
    return {
      ...meta,
      hasRecording: recordingBytes != null && recordingBytes > 0,
      hasSummary: existsSync(join(dir, 'summary.md')),
      recordingBytes,
      segmentCount
    };
  }

  private readJsonl<T>(p: string): T[] {
    if (!existsSync(p)) return [];
    try {
      return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
        .map((l) => { try { return JSON.parse(l) as T; } catch { return null; } })
        .filter((x): x is T => x !== null);
    } catch {
      return [];
    }
  }
}

// ─── MeetingAnalysisDriver ────────────────────────────────────────────────────

/** What the driver needs from the outside world — injected (like ProjectManager's
 *  emit) so this stays electron-free and unit-testable. */
export interface AnalysisDriverDeps {
  manager: MeetingManager;
  /** hive.send — drops the tick into the analyst's inbox (the wake-nudge loop and
   *  the Stop-hook drain take it from there). */
  send: (partial: { to: string; act: 'inform'; subject: string; body: string }, from: string) => void;
  getConfig: () => { meetingAnalysisIntervalSec?: number; curatorUsageCeilingPercent?: number };
  /** PTY liveness for `pty-analyst`. Checked BEFORE every send: routeMessage
   *  reroutes mail for a dead agent to god, so ticking a dead analyst would spam
   *  Michael's inbox once a minute. */
  isAnalystLive: () => boolean;
  getUsage: () => { fiveHour: { usedPercent: number } | null } | null;
  emit?: (channel: string, payload: unknown) => void;
}

/** Don't bother the analyst until at least this much new transcript accumulated
 *  (forced through after two quiet ticks so slow meetings still get analyzed). */
const MIN_TICK_CHARS = 200;
/** Per-tick transcript budget (chars) — the analyst gets the NEWEST lines. */
const TICK_BODY_CAP = 4000;
/** Max screen frames referenced per tick. */
const FRAMES_PER_TICK = 2;
/** Pause analysis when the 5h Claude window is hotter than this (analysis is a
 *  nice-to-have; the user's interactive agents are not). */
const USAGE_CEILING_PERCENT = 85;

function clock(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * Drives the live analysis loop: accumulates fresh transcript segments from the
 * MeetingManager, and on a cadence packages them (plus the newest screen frames)
 * into an `inform` inbox message for the analyst agent. `inform` is deliberate —
 * it neither expects a reply (normalize() would default `requires_reply` on a
 * request) nor triggers claimTaskOnDelegation. On meeting stop it sends the
 * wrap-up instruction that produces summary.md.
 */
export class MeetingAnalysisDriver {
  constructor(private deps: AnalysisDriverDeps) {}

  private meetingId: string | null = null;
  private meetingTitle = '';
  private timer: NodeJS.Timeout | null = null;
  private pending: TranscriptSegment[] = [];
  private pendingChars = 0;
  private quietTicks = 0;
  private firstTick = true;
  /** Highest frame second already sent — frames are named frame-<sec>.jpg. */
  private frameHighwater = -1;
  private analystDownNotified = false;
  private usagePauseNotified = false;
  /** Total transcript chars seen this meeting — gates the wrap-up (no speech, no summary). */
  private totalChars = 0;

  active(): string | null {
    return this.meetingId;
  }

  attach(meetingId: string, title: string): void {
    this.detach();
    this.meetingId = meetingId;
    this.meetingTitle = title;
    this.firstTick = true;
    this.deps.manager.setTranscriptListener((id, segments) => {
      if (id !== this.meetingId) return;
      this.pending.push(...segments);
      for (const s of segments) {
        this.pendingChars += s.text.length;
        this.totalChars += s.text.length;
      }
    });
    const sec = Math.max(15, Math.min(600, this.deps.getConfig().meetingAnalysisIntervalSec ?? 60));
    this.timer = setInterval(() => { try { this.tick(); } catch (e) { console.error('[meeting] tick failed:', e); } }, sec * 1000);
    this.timer.unref?.();
  }

  /** Meeting ended normally: final flush + the wrap-up instruction. */
  stop(meetingId: string): void {
    if (this.meetingId !== meetingId) return;
    const dir = this.deps.manager.meetingDir(meetingId);
    const hadSpeech = this.totalChars > 0;
    const tail = this.pending;
    this.detach();
    if (!dir || !hadSpeech || !this.deps.isAnalystLive()) return; // nothing to summarize / nobody to ask
    const tailLines = tail.length
      ? `\n\nTranscript since the last tick (the full record is in the file):\n${this.formatLines(tail)}`
      : '';
    this.deps.send({
      to: ANALYST_AGENT_ID,
      act: 'inform',
      subject: `Meeting ended — write the summary (${meetingId})`,
      body: [
        `The meeting "${this.titleOr(meetingId)}" has ENDED. Wrap-up time:`,
        `1. Read the full transcript: ${join(dir, 'transcript.jsonl')} (one JSON row per segment; t0/t1 = seconds, source mic = the human "ME", system = the other participants "THEM").`,
        `2. If visuals matter, frames are in ${join(dir, 'frames')}/.`,
        `3. Write a concise summary to ${join(dir, 'summary.md')} with sections: ## TL;DR, ## Decisions, ## Action items (owner → what), ## Open questions.`,
        `4. Then post ONE final outbox file: {"type":"meeting-insight","meetingId":"${meetingId}","kind":"note","text":"Summary ready: <one-line takeaway>"}.${tailLines}`
      ].join('\n')
    }, 'meeting');
  }

  /** Silent cleanup (project switch / app teardown) — no wrap-up message. */
  detach(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.deps.manager.setTranscriptListener(null);
    this.meetingId = null;
    this.meetingTitle = '';
    this.pending = [];
    this.pendingChars = 0;
    this.quietTicks = 0;
    this.frameHighwater = -1;
    this.totalChars = 0;
    this.analystDownNotified = false;
    this.usagePauseNotified = false;
  }

  /** One cadence beat — exposed for tests. */
  tick(): void {
    const meetingId = this.meetingId;
    if (!meetingId) return;

    if (!this.deps.isAnalystLive()) {
      // Hold the delta (analysis resumes where it left off) and tell the UI once.
      if (!this.analystDownNotified) {
        this.analystDownNotified = true;
        this.deps.emit?.('meeting:analystDown', { meetingId });
      }
      return;
    }
    this.analystDownNotified = false;

    const five = this.deps.getUsage()?.fiveHour?.usedPercent ?? 0;
    if (five > USAGE_CEILING_PERCENT) {
      if (!this.usagePauseNotified) {
        this.usagePauseNotified = true;
        this.deps.emit?.('meeting:analysisPaused', { meetingId, reason: `Claude usage at ${Math.round(five)}% — live analysis paused` });
      }
      return;
    }
    this.usagePauseNotified = false;

    if (this.pendingChars === 0) return;
    if (this.pendingChars < MIN_TICK_CHARS && this.quietTicks < 2) {
      this.quietTicks++;
      return;
    }

    const segments = this.pending;
    this.pending = [];
    this.pendingChars = 0;
    this.quietTicks = 0;

    const intro = this.firstTick
      ? `A live meeting is running: "${this.titleOr(meetingId)}" (meeting id ${meetingId}). Ticks like this keep arriving until it ends — follow your MEETING ANALYST protocol.\n\n`
      : '';
    this.firstTick = false;

    const frames = this.newFrames(meetingId);
    const framesBlock = frames.length
      ? `\n\nNewest screen frames (Read only if the words suggest the screen matters):\n${frames.map((f) => `- ${f}`).join('\n')}`
      : '';

    this.deps.send({
      to: ANALYST_AGENT_ID,
      act: 'inform',
      subject: `Meeting tick — ${this.titleOr(meetingId)}`,
      body: `${intro}New transcript:\n${this.formatLines(segments)}${framesBlock}\n\n(Insights: 0-2 outbox meeting-insight files for meetingId "${meetingId}"; silence is fine.)`
    }, 'meeting');
  }

  // — helpers —

  private titleOr(meetingId: string): string {
    return this.meetingTitle || meetingId;
  }

  /** `[mm:ss ME|THEM] text` lines, newest kept within the per-tick budget. */
  private formatLines(segments: TranscriptSegment[]): string {
    const lines = segments.map((s) => `[${clock(s.t0)} ${s.source === 'mic' ? 'ME' : 'THEM'}] ${s.text}`);
    let body = lines.join('\n');
    while (body.length > TICK_BODY_CAP && lines.length > 1) {
      lines.shift(); // drop oldest — the analyst needs the freshest context
      body = `(…older lines trimmed…)\n${lines.join('\n')}`;
    }
    return body;
  }

  /** Absolute paths of up-to-N frames newer than the highwater, oldest→newest. */
  private newFrames(meetingId: string): string[] {
    const dir = this.deps.manager.meetingDir(meetingId);
    if (!dir) return [];
    const framesDir = join(dir, 'frames');
    if (!existsSync(framesDir)) return [];
    try {
      const fresh = readdirSync(framesDir)
        .map((f) => {
          const m = /^frame-(\d{6})\.jpg$/.exec(f);
          return m ? { sec: Number(m[1]), path: join(framesDir, f) } : null;
        })
        .filter((x): x is { sec: number; path: string } => x !== null && x.sec > this.frameHighwater)
        .sort((a, b) => a.sec - b.sec);
      if (fresh.length === 0) return [];
      this.frameHighwater = fresh[fresh.length - 1].sec;
      return fresh.slice(-FRAMES_PER_TICK).map((x) => x.path);
    } catch {
      return [];
    }
  }
}
