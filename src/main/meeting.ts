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
