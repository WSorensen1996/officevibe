// Meeting-dedicated Whisper client. REUSES the dictation worker FILE (one
// maintained inference codepath: offline asset loading, q8 path, logging relay)
// but runs its OWN Worker instance, deliberately apart from useDictation's
// singleton: that one is keyed to the dictation model and would terminate/rebuild
// on every model mismatch, and its WebGPU tier + setSttBusy/Pixi-pause pattern
// have no place in an hours-long meeting. Meeting STT is pinned to CPU/WASM —
// the office floor keeps animating.
//
// Serial FIFO across both sources: transformers.js serialises inference per
// pipeline anyway, and a strict queue keeps transcript order stable. The queue
// depth doubles as the "transcription lagging" signal.

import type { RawSegment } from './segmenter';

export interface TranscribedSegment {
  t0: number;
  t1: number;
  source: 'mic' | 'system';
  text: string;
}

interface QueueItem {
  seg: RawSegment;
  source: 'mic' | 'system';
}

function log(level: 'log' | 'error', ...parts: unknown[]): void {
  (level === 'error' ? console.error : console.log)('[meeting][stt]', ...parts);
  try { window.cth?.sttLog?.(level, ['[meeting]', ...parts.map((p) => (p instanceof Error ? p.message : p))]); } catch { /* noop */ }
}

/** Same-origin base the vendored model/wasm assets are served from. */
function assetBase(): string {
  return new URL('.', window.location.href).href;
}

/** transformers.js whisper takes full language names; map our config codes. */
function languageName(code: string | undefined): string | undefined {
  switch (code) {
    case 'da': return 'danish';
    case 'en': return 'english';
    default: return undefined; // 'auto' / unset → per-segment detection
  }
}

export class MeetingTranscriber {
  private worker: Worker | null = null;
  private ready: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();

  private queue: QueueItem[] = [];
  private running = false;
  private disposed = false;

  constructor(
    private readonly model: string,
    private readonly language: string | undefined,
    private readonly onResult: (seg: TranscribedSegment) => void,
    private readonly onBacklog?: (depth: number) => void
  ) {}

  /** Create + warm the worker (model load happens here, ~seconds once). */
  init(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const w = new Worker(
        new URL('../dictation/transcriber.worker.ts', import.meta.url),
        { type: 'module' }
      );
      this.worker = w;
      w.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; id?: number; text?: string; message?: string; level?: 'log' | 'error'; parts?: unknown[] };
        if (m.type === 'ready') { log('log', `meeting model ready (${this.model}, wasm)`); resolve(); }
        else if (m.type === 'error') reject(new Error(m.message || 'meeting speech model failed to load'));
        else if (m.type === 'result') { this.pending.get(m.id!)?.resolve(m.text ?? ''); this.pending.delete(m.id!); }
        else if (m.type === 'result-error') { this.pending.get(m.id!)?.reject(new Error(m.message || 'transcribe failed')); this.pending.delete(m.id!); }
        else if (m.type === 'log') { try { window.cth?.sttLog?.(m.level ?? 'log', ['[meeting-worker]', ...(m.parts ?? [])]); } catch { /* noop */ } }
      };
      w.onerror = (e) => reject(new Error(e.message || 'meeting speech worker failed to load'));
      // Always CPU/WASM for meetings — never contend with the Pixi floor's GPU.
      w.postMessage({ type: 'init', base: assetBase(), model: this.model, device: 'wasm' });
    });
    this.ready.catch(() => { /* surfaced per-enqueue; keep the rejection handled */ });
    return this.ready;
  }

  /** Queue a finalized speech segment; results stream out via onResult in order. */
  enqueue(source: 'mic' | 'system', seg: RawSegment): void {
    if (this.disposed) return;
    this.queue.push({ seg, source });
    this.onBacklog?.(this.queue.length);
    void this.pump();
  }

  /** Resolves once everything queued so far is transcribed (or failed). Used at
   *  meeting stop to catch the tail; callers bound it with a timeout. */
  async drain(): Promise<void> {
    while (!this.disposed && (this.queue.length > 0 || this.running)) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  dispose(): void {
    this.disposed = true;
    this.queue = [];
    for (const [, p] of this.pending) p.reject(new Error('meeting transcriber disposed'));
    this.pending.clear();
    try { this.worker?.terminate(); } catch { /* noop */ }
    this.worker = null;
    this.ready = null;
  }

  private async pump(): Promise<void> {
    if (this.running || this.disposed) return;
    const item = this.queue.shift();
    if (!item) return;
    this.running = true;
    this.onBacklog?.(this.queue.length);
    try {
      await this.init();
      const text = await this.transcribe(item.seg.pcm);
      const clean = text.trim();
      // Whisper emits fillers like "you"/"." on pure noise — drop empties, keep the rest.
      if (clean && !this.disposed) {
        this.onResult({ t0: item.seg.t0, t1: item.seg.t1, source: item.source, text: clean });
      }
    } catch (e) {
      log('error', `segment transcribe failed (${item.source} @${item.seg.t0.toFixed(1)}s):`, e);
    } finally {
      this.running = false;
      if (!this.disposed && this.queue.length > 0) void this.pump();
      else this.onBacklog?.(this.queue.length);
    }
  }

  private transcribe(pcm: Float32Array): Promise<string> {
    const id = this.nextId++;
    return new Promise<string>((resolve, reject) => {
      if (!this.worker) { reject(new Error('worker gone')); return; }
      this.pending.set(id, { resolve, reject });
      const language = languageName(this.language);
      this.worker.postMessage(
        { type: 'transcribe', id, pcm, ...(language ? { opts: { language } } : {}) },
        [pcm.buffer]
      );
    });
  }
}
