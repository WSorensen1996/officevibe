import { useCallback, useEffect, useRef, useState } from 'react';
import { startRecording, type Recorder } from '@/lib/dictation/audio';
import { sttLog } from '@/lib/dictation/log';
import { useStore } from '@/store/store';

/**
 * Push-to-talk dictation: tap to record, tap again to transcribe locally (CPU) and
 * hand the text back via `onTranscript`. The heavy bit — the Whisper model + ONNX
 * runtime — lives in a single shared Web Worker created lazily on first use, so the
 * ~77 MB model loads ONCE and every mic button across the app reuses it.
 */

export type DictationState = 'idle' | 'recording' | 'transcribing' | 'error';

// ─── Shared worker singleton (one model load for the whole app) ──────────────
let worker: Worker | null = null;
let workerReady: Promise<void> | null = null;
let nextId = 0;
// The model id + backend the current `worker` was built for; lets us rebuild on a
// config change (model switch) or a device change.
let loadedModel: string | null = null;
let loadedDevice: 'webgpu' | 'wasm' | null = null;
// Once a WebGPU transcription has crashed and fallen back to CPU this session, stop
// choosing the WebGPU backend — retrying it would just re-crash the shared GPU process.
// Set when the worker posts 'backend-changed'; cleared only by an app restart.
let webgpuDisabledThisSession = false;
const pending = new Map<number, { resolve: (t: string) => void; reject: (e: Error) => void }>();

// Models that should run on the WebGPU backend when an adapter is present. The CPU
// models (whisper-base/tiny) always run on WASM. Keep in sync with the GPU tier ids in
// scripts/prepare-stt-assets.mjs + the STT_MODELS picker.
const GPU_MODELS = new Set(['distil-small.en']);

/** Same-origin base the vendored assets are served from: http://localhost/ in dev,
 *  app://bundle/ in a packaged build. transformers.js + ORT fetch model/wasm from here. */
function assetBase(): string {
  return new URL('.', window.location.href).href;
}

async function ensureWorker(): Promise<void> {
  // Read the chosen model live (config reads are fresh disk reads). Default to the
  // accurate base model if config is unavailable for any reason.
  let desiredModel = 'whisper-base.en';
  try {
    const cfg = await window.cth?.getConfig?.();
    if (cfg?.sttModel) desiredModel = cfg.sttModel;
  } catch { /* fall back to default */ }

  // Run the GPU tier on WebGPU when an adapter is reachable. If the GPU tier is selected
  // but there's NO adapter (navigator.gpu absent), we can't run it on CPU either — only
  // its fp32/q4 files are vendored, not q8 — so fall back to the Standard CPU model.
  // (If navigator.gpu IS present but the adapter is unusable, the worker's own init
  // try/catch drops to the CPU model — see transcriber.worker.ts.)
  const gpuPresent = typeof navigator !== 'undefined' && !!navigator.gpu;
  let desiredDevice: 'webgpu' | 'wasm' = 'wasm';
  if (GPU_MODELS.has(desiredModel)) {
    if (gpuPresent && !webgpuDisabledThisSession) desiredDevice = 'webgpu';
    else desiredModel = 'whisper-base.en'; // no (usable) GPU → run the Standard CPU model
  }

  // A worker already exists but for a different model OR backend → tear it down so it
  // rebuilds. Safe because we only reach here between dictations (start() warm-up or
  // stop() right before transcribe); any in-flight pending are rejected.
  if (workerReady && (loadedModel !== desiredModel || loadedDevice !== desiredDevice)) {
    sttLog('log', `stt config changed (${loadedModel}/${loadedDevice} → ${desiredModel}/${desiredDevice}); rebuilding worker`);
    try { worker?.terminate(); } catch { /* noop */ }
    worker = null;
    workerReady = null;
    for (const [, p] of pending) p.reject(new Error('speech model switched; please try again'));
    pending.clear();
  }

  if (workerReady) return workerReady;

  const base = assetBase();
  loadedModel = desiredModel;
  loadedDevice = desiredDevice;
  sttLog('log', 'ensureWorker: creating worker, base=', base, 'model=', desiredModel, 'device=', desiredDevice);
  workerReady = new Promise<void>((resolve, reject) => {
    const w = new Worker(
      new URL('../lib/dictation/transcriber.worker.ts', import.meta.url),
      { type: 'module' }
    );
    worker = w;
    w.onmessage = (e: MessageEvent) => {
      const m = e.data;
      if (m.type === 'ready') {
        // Record the backend the worker actually loaded on so Settings can show it
        // (the human's in-app GPU-vs-CPU proof, task 5z52).
        sttLog('log', 'worker ready', m.device ? `on ${m.device}` : '');
        try { useStore.getState().setSttBackend({ device: m.device ?? 'wasm', adapter: m.adapter }); } catch { /* noop */ }
        resolve();
      }
      else if (m.type === 'error') { sttLog('error', 'worker init error:', m.message); reject(new Error(m.message || 'failed to load speech model')); }
      else if (m.type === 'result') { pending.get(m.id)?.resolve(m.text); pending.delete(m.id); }
      else if (m.type === 'result-error') { pending.get(m.id)?.reject(new Error(m.message)); pending.delete(m.id); }
      else if (m.type === 'backend-changed') {
        // The worker hit a WebGPU failure mid-transcribe and fell back to the CPU model.
        // Keep the singleton's device/model cache in sync so ensureWorker() doesn't think
        // it's still on WebGPU, latch WebGPU off for the session (don't re-crash the GPU),
        // and update the Settings backend readout. The in-flight transcribe still resolves
        // normally with the CPU result.
        sttLog('log', 'worker fell back to', m.device, '— disabling webgpu for this session');
        webgpuDisabledThisSession = true;
        loadedDevice = m.device ?? 'wasm';
        loadedModel = 'whisper-base.en';
        try { useStore.getState().setSttBackend({ device: m.device ?? 'wasm' }); } catch { /* noop */ }
      }
      // Relay worker [stt][worker] logs to the main process (terminal).
      else if (m.type === 'log') { try { window.cth?.sttLog?.(m.level, ['[worker]', ...(m.parts ?? [])]); } catch { /* noop */ } }
    };
    w.onerror = (e) => {
      // A bare worker onerror often has an empty message — log everything we can.
      sttLog('error', 'worker.onerror:', e.message || '(no message)', 'at', e.filename, e.lineno);
      reject(new Error(e.message || 'speech worker failed to load (see console)'));
    };
    w.postMessage({ type: 'init', base, model: desiredModel, device: desiredDevice });
  });
  // A failed load shouldn't permanently wedge dictation — allow a later retry.
  workerReady.catch(() => { workerReady = null; worker = null; loadedModel = null; loadedDevice = null; });
  return workerReady;
}

function transcribe(pcm: Float32Array): Promise<string> {
  const id = ++nextId;
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // Transfer the PCM buffer (zero-copy); we don't reuse it after this.
    worker!.postMessage({ type: 'transcribe', id, pcm }, [pcm.buffer]);
  });
}

export interface UseDictation {
  state: DictationState;
  error: string | null;
  /** Toggle recording on/off. */
  toggle: () => void;
}

export function useDictation(onTranscript: (text: string) => void): UseDictation {
  const [state, setState] = useState<DictationState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<Recorder | null>(null);
  // Keep the latest callback without re-creating handlers.
  const onTranscriptRef = useRef(onTranscript);
  onTranscriptRef.current = onTranscript;

  const start = useCallback(async () => {
    setError(null);
    sttLog('log', 'start: requesting microphone…');
    try {
      recorderRef.current = await startRecording();
      setState('recording');
      sttLog('log', 'start: recording');
      // Warm the model concurrently with recording; errors surface at stop().
      void ensureWorker().catch((e) => sttLog('error', 'model warm-up failed (will retry on stop):', e?.message ?? e));
    } catch (e) {
      sttLog('error', 'start failed:', e);
      setState('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const stop = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    recorderRef.current = null;
    setState('transcribing');
    sttLog('log', 'stop: finishing recording…');
    try {
      const pcm = await rec.stop();
      sttLog('log', `stop: got ${pcm.length} samples; ensuring model…`);
      // Pause the office floor's Pixi render loop for the GPU-heavy window (model ensure +
      // transcribe). On the WebGPU tier this is what stops the continuous WebGL rendering
      // from contending with ONNX compute for the single shared GPU process — the
      // contention that hangs the compositor's Vulkan swapchain and crashes the GPU
      // mid-transcription. zustand fires subscribers synchronously, so OfficeFloor stops
      // its ticker before the transcribe below runs. Always cleared in finally (success,
      // error, AND the worker's CPU-fallback retry).
      useStore.getState().setSttBusy(true);
      try {
        await ensureWorker();
        sttLog('log', 'stop: transcribing…');
        const text = await transcribe(pcm);
        sttLog('log', 'stop: transcript=', JSON.stringify(text));
        if (text) onTranscriptRef.current(text);
        setState('idle');
      } finally {
        useStore.getState().setSttBusy(false);
      }
    } catch (e) {
      sttLog('error', 'stop/transcribe failed:', e);
      setState('error');
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const toggle = useCallback(() => {
    sttLog('log', 'mic toggle, currently recording=', !!recorderRef.current);
    if (recorderRef.current) void stop();
    else void start();
  }, [start, stop]);

  // Abort an in-flight recording if the component unmounts.
  useEffect(() => () => { recorderRef.current?.cancel(); recorderRef.current = null; }, []);

  return { state, error, toggle };
}
