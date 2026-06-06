// Whisper speech-to-text running fully local on the CPU via transformers.js
// (ONNX-WASM). Lives in a Web Worker so transcription never blocks the React UI —
// transformers.js serialises inference sessions, and a 1–2s decode on the main
// thread would freeze the office floor.
//
// The model (whisper-base.en, int8) and the ONNX Runtime wasm are loaded from the
// app's OWN origin (http://localhost in dev, app://bundle in a packaged build) —
// nothing is fetched from Hugging Face or a CDN at runtime. See
// scripts/prepare-stt-assets.mjs for how those assets are vendored.

import { pipeline, env } from '@huggingface/transformers';

// `self` in a worker exposes postMessage(msg, transfer?) / onmessage — the Worker
// type carries those exact signatures, so cast to it for clean typing under the
// renderer's DOM lib (DedicatedWorkerGlobalScope isn't in scope here).
const ctx = self as unknown as Worker;

// Set from the init message ({type:'init', base, model}); defaults to the accurate
// base model if an older host posts an init without a model field.
let modelId = 'whisper-base.en';

// The compute backend this worker actually loads the model on. Today (Phase-1)
// always 'wasm' (CPU); Phase-2 sets it from the init message + drives device:'webgpu'
// in pipeline(). Echoed back in the 'ready' message so Settings can show the human
// which backend transcription is really running on (task 5z52).
let device: 'webgpu' | 'wasm' = 'wasm';

/** Log to the worker's own console (visible in DevTools) AND post to the hook,
 *  which relays it to the main process so it also lands in the dev terminal. */
function log(level: 'log' | 'error', ...parts: unknown[]): void {
  (level === 'error' ? console.error : console.log)('[stt][worker]', ...parts);
  try {
    ctx.postMessage({
      type: 'log',
      level,
      parts: parts.map((p) => (p instanceof Error ? (p.stack ?? p.message) : p))
    });
  } catch { /* noop */ }
}

// If this never prints, the worker module itself failed to load (e.g. a Vite-dev
// resolution error for @huggingface/transformers) — the hook's w.onerror will fire.
log('log', 'module loaded');

let transcriberPromise: Promise<(audio: Float32Array) => Promise<unknown>> | null = null;

function configure(base: string): void {
  // Fully offline: every request resolves to the app's OWN origin (localhost in dev,
  // app://bundle when packaged) — never Hugging Face or a CDN.
  env.allowLocalModels = true;
  env.localModelPath = base + 'models/';
  // transformers.js v4 decides whether to load the tokenizer/processor via a file-
  // existence probe (get_file_metadata → get_tokenizer_files/get_processor_files). In
  // DEV the assets are served over http://localhost, so localModelPath is a URL and the
  // probe's LOCAL branch (gated on `!isURL`) is skipped; with remote models off it then
  // reports the files "missing", and pipeline() silently builds a NULL tokenizer +
  // processor that crashes in _call_whisper / AutoTokenizer on first use. Point the
  // "remote" host at our OWN origin so the probe's remote branch (a same-origin GET)
  // succeeds — nothing leaves the app (remoteHost is our origin, not Hugging Face). In a
  // packaged app:// build the local branch already works and fetch_file_head ignores the
  // non-http app:// URL, so this is a harmless no-op there.
  env.allowRemoteModels = true;
  env.remoteHost = base;                      // e.g. http://localhost:5173/
  env.remotePathTemplate = 'models/{model}';  // → {base}/models/whisper-base.en/<file>
  const wasm = (env.backends as { onnx: { wasm: Record<string, unknown> } }).onnx.wasm;
  wasm.wasmPaths = base + 'wasm/';
  wasm.numThreads = 1; // single-threaded → no cross-origin isolation (COOP/COEP) required
  log('log', 'configured', { base, localModelPath: env.localModelPath, remoteHost: env.remoteHost });
}

function getTranscriber() {
  if (!transcriberPromise) {
    log('log', `loading model ${modelId} (dtype q8)…`);
    transcriberPromise = (pipeline as unknown as (
      task: string,
      model: string,
      opts: {
        dtype: string;
        session_options?: { graphOptimizationLevel?: string };
        progress_callback?: (p: unknown) => void;
      }
    ) => Promise<(audio: Float32Array) => Promise<unknown>>)(
      'automatic-speech-recognition',
      modelId,
      {
        dtype: 'q8',
        // onnxruntime-web's extended/'all' graph optimizer crashes on this q8
        // decoder's tied embedding ("TransposeDQWeightsForMatMulNBits Missing
        // required scale"). 'basic' skips that buggy fusion and the model loads
        // fine — verified against the vendored decoder with ort-web 1.26-dev.
        session_options: { graphOptimizationLevel: 'basic' },
        // progress_callback fires for every asset fetch (config/tokenizer/onnx/wasm) —
        // the key signal for a stuck or 404'd model/wasm load.
        progress_callback: (p) => log('log', 'model-progress', p)
      }
    );
  }
  return transcriberPromise;
}

ctx.onmessage = async (e: MessageEvent) => {
  const msg = e.data as
    | { type: 'init'; base: string; model?: string }
    | { type: 'transcribe'; id: number; pcm: Float32Array };
  try {
    if (msg.type === 'init') {
      if (msg.model) modelId = msg.model;
      log('log', 'init received, base=', msg.base, 'model=', modelId);
      configure(msg.base);
      await getTranscriber(); // warm the model so the first dictation isn't cold
      log('log', `model ready on ${device}`);
      ctx.postMessage({ type: 'ready', device });
    } else if (msg.type === 'transcribe') {
      log('log', `transcribe start: ${msg.pcm.length} samples (~${(msg.pcm.length / 16000).toFixed(1)}s)`);
      const transcriber = await getTranscriber();
      const out = (await transcriber(msg.pcm)) as { text?: string } | Array<{ text?: string }>;
      log('log', 'transcribe raw output', out);
      const text = Array.isArray(out)
        ? out.map((o) => o.text ?? '').join(' ')
        : out?.text ?? '';
      log('log', 'transcribe text=', JSON.stringify(text.trim()));
      ctx.postMessage({ type: 'result', id: msg.id, text: text.trim() });
    }
  } catch (err) {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log('error', `failed during ${(msg as { type?: string })?.type}:`, message);
    if ((msg as { type?: string })?.type === 'init') ctx.postMessage({ type: 'error', message });
    else ctx.postMessage({ type: 'result-error', id: (msg as { id?: number })?.id, message });
  }
};
