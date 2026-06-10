import { describe, expect, it } from 'vitest';
import { PcmSegmenter, type RawSegment } from '../src/renderer/src/lib/meeting/segmenter';

const RATE = 16000;

/** Synthetic audio builders: "speech" = a loud sine, "silence" = near-zero noise. */
function tone(ms: number, amp = 0.3, hz = 220): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * hz * i) / RATE);
  return out;
}
function silence(ms: number, amp = 0.001): Float32Array {
  const n = Math.round((ms / 1000) * RATE);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = (Math.random() * 2 - 1) * amp;
  return out;
}
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Feed audio in tap-sized batches (2048 samples) like the worklet does. */
function run(audio: Float32Array, flush = true): RawSegment[] {
  const segments: RawSegment[] = [];
  const seg = new PcmSegmenter((s) => segments.push(s));
  for (let off = 0; off < audio.length; off += 2048) {
    seg.push(audio.subarray(off, Math.min(off + 2048, audio.length)));
  }
  if (flush) seg.flush();
  return segments;
}

describe('PcmSegmenter', () => {
  it('emits one segment for speech bounded by silence', () => {
    const segs = run(concat(silence(500), tone(1500), silence(1000)));
    expect(segs).toHaveLength(1);
    const s = segs[0];
    // Opened near 0.5s (minus ≤240ms pre-roll), closed after the 600ms hangover.
    expect(s.t0).toBeGreaterThan(0.1);
    expect(s.t0).toBeLessThanOrEqual(0.55);
    expect(s.t1).toBeGreaterThanOrEqual(2.0);
    // PCM length matches the reported bounds exactly.
    expect(s.pcm.length).toBe(Math.round((s.t1 - s.t0) * RATE));
  });

  it('splits two utterances separated by a long pause', () => {
    const segs = run(concat(silence(400), tone(1000), silence(1200), tone(900), silence(1000)));
    expect(segs).toHaveLength(2);
    expect(segs[0].t1).toBeLessThan(segs[1].t0);
  });

  it('drops sub-400ms blips (clicks/coughs)', () => {
    const segs = run(concat(silence(500), tone(120), silence(1000)));
    expect(segs).toHaveLength(0);
  });

  it('force-cuts a monologue at the 25s window', () => {
    const segs = run(concat(silence(300), tone(27_000), silence(800)));
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect((segs[0].t1 - segs[0].t0)).toBeLessThanOrEqual(25.2);
  });

  it('flush() emits the open segment at meeting stop', () => {
    const segs = run(concat(silence(300), tone(1200)), true);
    expect(segs).toHaveLength(1);
  });

  it('emits nothing for pure ambient noise', () => {
    const segs = run(silence(5000, 0.002));
    expect(segs).toHaveLength(0);
  });

  it('keeps the clock monotonic across many batches', () => {
    const segs = run(concat(
      silence(400), tone(800), silence(900),
      tone(700), silence(900), tone(600), silence(900)
    ));
    expect(segs.length).toBe(3);
    for (let i = 1; i < segs.length; i++) {
      expect(segs[i].t0).toBeGreaterThan(segs[i - 1].t0);
    }
  });

  it('adapts the floor: speech over a noisy bed still segments', () => {
    // Noisy ambient (rms ~0.008) for 3s, then clearly louder speech.
    const segs = run(concat(silence(3000, 0.012), tone(1200, 0.35), silence(1000, 0.012)));
    expect(segs.length).toBe(1);
  });
});
