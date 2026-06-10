import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MeetingManager, MeetingAnalysisDriver, ANALYST_AGENT_ID,
  type MeetingMeta, type TranscriptSegment
} from '../src/main/meeting';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'officevibe-meeting-')));
afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ } });

let emitted: Array<{ channel: string; payload: unknown }> = [];
function manager(root: string | null = base): MeetingManager {
  return new MeetingManager(() => root, (channel, payload) => emitted.push({ channel, payload }));
}
beforeEach(() => { emitted = []; });

function startOne(m: MeetingManager): MeetingMeta {
  const res = m.start({
    title: 'Sync',
    sources: { mic: true, systemAudio: true, systemAudioDeviceLabel: 'Monitor of Built-in', screen: true },
    language: 'auto',
    model: 'whisper-base'
  });
  if (!res.ok) throw new Error(res.error);
  return res.meta;
}

describe('MeetingManager lifecycle', () => {
  it('creates the meeting folder + metadata and tracks the active id', () => {
    const m = manager();
    const meta = startOne(m);
    expect(meta.status).toBe('recording');
    expect(m.activeMeetingId()).toBe(meta.id);
    const dir = m.meetingDir(meta.id)!;
    expect(existsSync(join(dir, 'metadata.json'))).toBe(true);
    expect(existsSync(join(dir, 'frames'))).toBe(true);
    m.stop(meta.id, 12);
  });

  it('refuses a second concurrent meeting and frees the slot on stop', () => {
    const m = manager();
    const meta = startOne(m);
    const second = m.start({ sources: { mic: true, systemAudio: false, screen: false }, language: 'en', model: 'whisper-tiny.en' });
    expect(second.ok).toBe(false);
    expect(m.stop(meta.id, 5).ok).toBe(true);
    expect(m.activeMeetingId()).toBeNull();
    const again = m.start({ sources: { mic: true, systemAudio: false, screen: false }, language: 'en', model: 'whisper-tiny.en' });
    expect(again.ok).toBe(true);
    if (again.ok) m.stop(again.meta.id, 1);
  });

  it('appends chunks and transcript rows; read() returns the full record', () => {
    const m = manager();
    const meta = startOne(m);
    expect(m.appendChunk(meta.id, new Uint8Array([1, 2, 3])).ok).toBe(true);
    expect(m.appendChunk(meta.id, new Uint8Array([4, 5])).ok).toBe(true);
    const segs: TranscriptSegment[] = [
      { t0: 1.2, t1: 3.4, source: 'mic', text: 'hello there' },
      { t0: 4.0, t1: 6.0, source: 'system', text: 'hej med dig' }
    ];
    expect(m.appendTranscript(meta.id, segs).ok).toBe(true);
    m.stop(meta.id, 7);
    const read = m.read(meta.id);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.meta.status).toBe('ended');
      expect(read.meta.recordingBytes).toBe(5);
      expect(read.transcript).toHaveLength(2);
      expect(read.transcript[1].source).toBe('system');
    }
    // The live feed event fired with the cleaned segments.
    expect(emitted.some((e) => e.channel === 'meeting:transcript')).toBe(true);
  });

  it('drops empty/whitespace transcript segments instead of persisting junk', () => {
    const m = manager();
    const meta = startOne(m);
    expect(m.appendTranscript(meta.id, [
      { t0: 0, t1: 1, source: 'mic', text: '   ' },
      { t0: 0, t1: 1, source: 'mic', text: '' }
    ]).ok).toBe(true);
    const read = m.read(meta.id);
    if (read.ok) expect(read.transcript).toHaveLength(0);
    m.stop(meta.id, 1);
  });

  it('marks orphaned recordings as interrupted on scan', () => {
    const m = manager();
    const meta = startOne(m);
    // Simulate a crash: a NEW manager instance (no active id) scans the disk.
    const fresh = manager();
    const repaired = fresh.scanForOrphans();
    expect(repaired).toBeGreaterThanOrEqual(1);
    const read = fresh.read(meta.id);
    if (read.ok) expect(read.meta.status).toBe('interrupted');
  });

  it('lists meetings newest-first with decorations', () => {
    const m = manager();
    const list = m.list();
    expect(list.length).toBeGreaterThanOrEqual(1);
    for (let i = 1; i < list.length; i++) {
      expect(list[i - 1].startedAt >= list[i].startedAt).toBe(true);
    }
  });
});

describe('MeetingManager hardening', () => {
  it('rejects traversal-shaped meeting ids everywhere', () => {
    const m = manager();
    for (const bad of ['../../etc', 'm-../x', 'm-a/b', '', 'nope', 'm-' + 'x'.repeat(200)]) {
      expect(m.meetingDir(bad)).toBeNull();
      expect(m.appendChunk(bad, new Uint8Array([1])).ok).toBe(false);
      expect(m.writeFrame(bad, 0, new Uint8Array([1])).ok).toBe(false);
      expect(m.appendTranscript(bad, []).ok).toBe(false);
      expect(m.stop(bad).ok).toBe(false);
    }
  });

  it('no-ops without an active project', () => {
    const m = manager(null);
    expect(m.enabled()).toBe(false);
    const res = m.start({ sources: { mic: true, systemAudio: false, screen: false }, language: 'auto', model: 'whisper-base' });
    expect(res.ok).toBe(false);
    expect(m.list()).toEqual([]);
  });

  it('drops a meeting-insight whose sink raises (unknown meeting) without throwing', () => {
    const m = manager();
    expect(m.ingestInsight('analyst', { meetingId: 'm-not-real-0000', kind: 'note', text: 'x' }).ok).toBe(false);
  });

  it('validates insights: unknown meeting, empty text, bad kind, traversal id', () => {
    const m = manager();
    const meta = startOne(m);
    expect(m.ingestInsight('analyst', { meetingId: '../../etc', kind: 'note', text: 'x' }).ok).toBe(false);
    expect(m.ingestInsight('analyst', { meetingId: meta.id, kind: 'note', text: '   ' }).ok).toBe(false);
    // Unknown kind is coerced to 'note', not rejected (the text is still valuable).
    expect(m.ingestInsight('analyst', { meetingId: meta.id, kind: 'whatever', text: 'a point' }).ok).toBe(true);
    expect(m.ingestInsight('analyst', {
      meetingId: meta.id,
      kind: 'action-item',
      text: 'Follow up with billing',
      suggestedTask: { title: 'Email billing about the invoice', description: 'From the meeting' }
    }).ok).toBe(true);
    const read = m.read(meta.id);
    if (read.ok) {
      expect(read.insights).toHaveLength(2);
      expect(read.insights[0].kind).toBe('note');
      expect(read.insights[1].suggestedTask?.title).toContain('billing');
    }
    const dir = m.meetingDir(meta.id)!;
    const raw = readFileSync(join(dir, 'insights.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
    m.stop(meta.id, 2);
  });
});

describe('MeetingAnalysisDriver', () => {
  interface Sent { to: string; act: string; subject: string; body: string }

  function harness(opts: { live?: boolean; fiveHour?: number } = {}) {
    const m = manager();
    const meta = startOne(m);
    const sent: Sent[] = [];
    let live = opts.live ?? true;
    let fiveHour = opts.fiveHour ?? 10;
    const driver = new MeetingAnalysisDriver({
      manager: m,
      send: (partial) => sent.push(partial as Sent),
      getConfig: () => ({ meetingAnalysisIntervalSec: 60 }),
      isAnalystLive: () => live,
      getUsage: () => ({ fiveHour: { usedPercent: fiveHour } }),
      emit: (channel, payload) => emitted.push({ channel, payload })
    });
    driver.attach(meta.id, meta.title);
    return {
      m, meta, driver, sent,
      setLive: (v: boolean) => { live = v; },
      setUsage: (v: number) => { fiveHour = v; },
      speak: (text: string, t0 = 1) =>
        m.appendTranscript(meta.id, [{ t0, t1: t0 + 2, source: 'mic', text }])
    };
  }

  it('sends a tick once enough new transcript accumulated, with the meeting id + lines', () => {
    const h = harness();
    h.speak('x'.repeat(250));
    h.driver.tick();
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].to).toBe(ANALYST_AGENT_ID);
    expect(h.sent[0].act).toBe('inform');
    expect(h.sent[0].body).toContain(h.meta.id);
    expect(h.sent[0].body).toContain('ME]');
    h.driver.detach();
  });

  it('skips short deltas but force-sends after two quiet ticks', () => {
    const h = harness();
    h.speak('short remark');
    h.driver.tick(); // quiet 1
    h.driver.tick(); // quiet 2
    expect(h.sent).toHaveLength(0);
    h.driver.tick(); // forced
    expect(h.sent).toHaveLength(1);
    h.driver.detach();
  });

  it('never ticks an empty delta', () => {
    const h = harness();
    h.driver.tick();
    h.driver.tick();
    h.driver.tick();
    expect(h.sent).toHaveLength(0);
    h.driver.detach();
  });

  it('holds ticks while the analyst is dead (no god-reroute spam) and resumes', () => {
    const h = harness({ live: false });
    h.speak('y'.repeat(300));
    h.driver.tick();
    h.driver.tick();
    expect(h.sent).toHaveLength(0);
    expect(emitted.filter((e) => e.channel === 'meeting:analystDown')).toHaveLength(1); // notified once
    h.setLive(true);
    h.driver.tick();
    expect(h.sent).toHaveLength(1); // the held delta went out, nothing lost
    h.driver.detach();
  });

  it('pauses on the usage ceiling', () => {
    const h = harness({ fiveHour: 92 });
    h.speak('z'.repeat(300));
    h.driver.tick();
    expect(h.sent).toHaveLength(0);
    expect(emitted.some((e) => e.channel === 'meeting:analysisPaused')).toBe(true);
    h.setUsage(20);
    h.driver.tick();
    expect(h.sent).toHaveLength(1);
    h.driver.detach();
  });

  it('references only NEW frames, at most two, advancing the highwater', () => {
    const h = harness();
    const framesDir = join(h.m.meetingDir(h.meta.id)!, 'frames');
    mkdirSync(framesDir, { recursive: true });
    for (const sec of [5, 10, 15]) {
      writeFileSync(join(framesDir, `frame-${String(sec).padStart(6, '0')}.jpg`), 'x');
    }
    h.speak('a'.repeat(300));
    h.driver.tick();
    expect(h.sent[0].body).toContain('frame-000010.jpg');
    expect(h.sent[0].body).toContain('frame-000015.jpg');
    expect(h.sent[0].body).not.toContain('frame-000005.jpg'); // capped at 2, newest win
    writeFileSync(join(framesDir, 'frame-000020.jpg'), 'x');
    h.speak('b'.repeat(300));
    h.driver.tick();
    expect(h.sent[1].body).toContain('frame-000020.jpg');
    expect(h.sent[1].body).not.toContain('frame-000015.jpg'); // already sent
    h.driver.detach();
  });

  it('caps a huge delta to the newest lines', () => {
    const h = harness();
    for (let i = 0; i < 30; i++) h.speak(`line ${i} ${'w'.repeat(300)}`, i * 10);
    h.driver.tick();
    expect(h.sent[0].body.length).toBeLessThan(6000);
    expect(h.sent[0].body).toContain('line 29');
    expect(h.sent[0].body).not.toContain('line 0 ');
    h.driver.detach();
  });

  it('stop() sends the wrap-up with the summary path; detach() never does', () => {
    const h = harness();
    h.speak('decisions were made');
    h.driver.stop(h.meta.id);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].subject).toContain('summary');
    expect(h.sent[0].body).toContain('summary.md');
    expect(h.sent[0].body).toContain('transcript.jsonl');

    const h2 = harness();
    h2.speak('more words here');
    h2.driver.detach();
    expect(h2.sent).toHaveLength(0);
  });

  it('skips the wrap-up when nobody spoke or the analyst is dead', () => {
    const silent = harness();
    silent.driver.stop(silent.meta.id);
    expect(silent.sent).toHaveLength(0);

    const dead = harness({ live: false });
    dead.speak('words');
    dead.driver.stop(dead.meta.id);
    expect(dead.sent).toHaveLength(0);
  });
});
