// Pure, dependency-free voice-activity segmenter: push 16 kHz mono PCM batches in,
// get speech segments out. One instance per audio source ('mic' / 'system').
//
// Why segment at all: Whisper's window is 30 s and the meeting runs for hours —
// live transcription means cutting the stream into utterance-sized chunks at
// natural pauses. Plain RMS energy over an ADAPTIVE noise floor is deliberately
// chosen over a neural VAD: it's a handful of lines, runs in nanoseconds on the
// UI thread, has no model to load, and a false positive merely transcribes a
// noisy-but-silent chunk (Whisper returns empty/garbage that the empty-text
// filter drops) while a false negative is bounded by the floor adapting within
// seconds. Electron-free + DOM-free so vitest covers it directly.

export interface SegmenterOptions {
  sampleRate?: number;
  /** Absolute RMS floor for "could be speech" — guards against a dead-silent
   *  digital source where the adaptive floor would drift to ~0. */
  startThreshold?: number;
  /** Speech must exceed the noise floor by this factor to open a segment. */
  floorFactor?: number;
  /** Close the segment after this much trailing silence. */
  silenceMs?: number;
  /** Hard cut even mid-speech (Whisper's usable window). */
  maxSegmentMs?: number;
  /** Discard blips shorter than this (door clicks, coughs). */
  minSegmentMs?: number;
  /** Audio kept from just BEFORE speech opened, so the first word isn't clipped. */
  prerollMs?: number;
}

export interface RawSegment {
  /** Seconds since the segmenter started (≈ meeting start). */
  t0: number;
  t1: number;
  pcm: Float32Array;
}

const DEFAULTS: Required<SegmenterOptions> = {
  sampleRate: 16000,
  startThreshold: 0.012,
  floorFactor: 3,
  silenceMs: 600,
  maxSegmentMs: 25_000,
  minSegmentMs: 400,
  prerollMs: 240
};

/** Analysis granularity: 32 ms sub-windows give silence detection finer than the
 *  ~128 ms batches the audio tap posts. */
const WIN = 512;

export class PcmSegmenter {
  private readonly o: Required<SegmenterOptions>;
  private readonly onSegment: (seg: RawSegment) => void;

  /** Total samples consumed — the master clock for t0/t1. */
  private consumed = 0;
  /** Carry-over when a push isn't a multiple of WIN. */
  private remainder: Float32Array | null = null;

  /** Adaptive ambient-noise RMS (EMA over non-speech windows). */
  private noiseFloor = 0.004;

  private speaking = false;
  private speech: Float32Array[] = [];
  private speechSamples = 0;
  private speechStartSample = 0;
  private silentSamples = 0;
  /** Pre-roll length captured when the segment opened — excluded (with the
   *  trailing silence) from the blip-filter's SPEECH duration. */
  private openPrerollSamples = 0;
  /** Ring of recent non-speech windows for the pre-roll. */
  private preroll: Float32Array[] = [];
  private prerollSamples = 0;

  constructor(onSegment: (seg: RawSegment) => void, opts: SegmenterOptions = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.onSegment = onSegment;
  }

  push(batch: Float32Array): void {
    let data = batch;
    if (this.remainder && this.remainder.length) {
      const joined = new Float32Array(this.remainder.length + batch.length);
      joined.set(this.remainder, 0);
      joined.set(batch, this.remainder.length);
      data = joined;
    }
    let off = 0;
    for (; off + WIN <= data.length; off += WIN) {
      this.window(data.subarray(off, off + WIN));
    }
    this.remainder = off < data.length ? data.slice(off) : null;
  }

  /** Meeting over — emit whatever is still open (if long enough). */
  flush(): void {
    if (this.speaking) this.close();
    this.remainder = null;
  }

  private window(w: Float32Array): void {
    let sum = 0;
    for (let i = 0; i < w.length; i++) sum += w[i] * w[i];
    const rms = Math.sqrt(sum / w.length);
    const threshold = Math.max(this.o.startThreshold, this.noiseFloor * this.o.floorFactor);
    const ms = (n: number): number => (n / this.o.sampleRate) * 1000;

    if (!this.speaking) {
      if (rms >= threshold) {
        // Open: pre-roll + this window. t0 points at the pre-roll start.
        this.speaking = true;
        this.speech = [...this.preroll, w.slice()];
        this.speechSamples = this.prerollSamples + w.length;
        this.speechStartSample = this.consumed - this.prerollSamples;
        this.silentSamples = 0;
        this.openPrerollSamples = this.prerollSamples;
        this.preroll = [];
        this.prerollSamples = 0;
      } else {
        // Ambient — adapt the floor (slow EMA) and maintain the pre-roll ring.
        this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
        this.preroll.push(w.slice());
        this.prerollSamples += w.length;
        const maxPre = Math.round((this.o.prerollMs / 1000) * this.o.sampleRate);
        while (this.prerollSamples - (this.preroll[0]?.length ?? 0) >= maxPre && this.preroll.length > 1) {
          this.prerollSamples -= this.preroll.shift()!.length;
        }
      }
    } else {
      this.speech.push(w.slice());
      this.speechSamples += w.length;
      this.silentSamples = rms < threshold ? this.silentSamples + w.length : 0;
      if (ms(this.silentSamples) >= this.o.silenceMs || ms(this.speechSamples) >= this.o.maxSegmentMs) {
        this.close();
      }
    }
    this.consumed += w.length;
  }

  private close(): void {
    this.speaking = false;
    const total = this.speechSamples;
    const parts = this.speech;
    this.speech = [];
    this.speechSamples = 0;
    const startSample = this.speechStartSample;
    const trailing = this.silentSamples;
    this.silentSamples = 0;

    // The blip filter measures actual SPEECH — pre-roll and the silence hangover
    // are padding, not voice, and would let a 100ms click masquerade as ~1s.
    const speechSamples = Math.max(0, total - trailing - this.openPrerollSamples);
    this.openPrerollSamples = 0;
    if (((speechSamples / this.o.sampleRate) * 1000) < this.o.minSegmentMs) return; // blip — drop
    const pcm = new Float32Array(total);
    let off = 0;
    for (const p of parts) { pcm.set(p, off); off += p.length; }
    this.onSegment({
      t0: startSample / this.o.sampleRate,
      t1: (startSample + total) / this.o.sampleRate,
      pcm
    });
  }
}
