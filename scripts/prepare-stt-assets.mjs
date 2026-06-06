// Vendors the local speech-to-text assets so the "tap to speak" feature runs FULLY
// OFFLINE (no Hugging Face / CDN access at runtime):
//   1. The Whisper ONNX models into src/renderer/public/models/<id>/ — the two q8/CPU
//      models (base.en/tiny.en, the `_quantized` files) plus the GPU tier
//      distil-small.en (fp32 encoder + q4 decoder, run on WebGPU with WASM fallback).
//   2. The onnxruntime-web WASM binaries (version-matched to the copy bundled by
//      @huggingface/transformers) into src/renderer/public/wasm/ — the whole ort-wasm-*
//      set, which includes the JSEP build the WebGPU execution provider loads.
//
// Vite copies everything under src/renderer/public/ to the renderer build output
// verbatim, and the renderer loads these via env.localModelPath / wasmPaths (see
// src/renderer/src/lib/dictation/transcriber.worker.ts). Both directories are
// gitignored; this script regenerates them and is auto-run on `prebuild`.
//
// Re-running is cheap: existing files are skipped. Use FORCE_STT_ASSETS=1 to redownload.

import { mkdir, writeFile, copyFile, access, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// The dictation models the app can switch between (Settings → DICTATION). Each is
// vendored into src/renderer/public/models/<id>/ and loaded fully offline at runtime.
// The first two are q8/CPU (WASM); distil-small.en is the GPU tier — fp32 encoder +
// q4 merged decoder, run on the WebGPU backend (it falls back to WASM if no adapter).
// A model's `onnx` list overrides the default q8 file set below; the id MUST match the
// sttModel union, the STT_MODELS card, and what transcriber.worker.ts loads.
const MODELS = [
  { id: 'whisper-base.en', repo: 'onnx-community/whisper-base.en' },
  { id: 'whisper-tiny.en', repo: 'onnx-community/whisper-tiny.en' },
  {
    id: 'distil-small.en',
    repo: 'onnx-community/distil-small.en',
    // GPU tier: fp32 encoder (no dtype suffix — Whisper's encoder is quantization-
    // sensitive) + q4 merged decoder (speed/VRAM). ~538 MB total. Matches the
    // per-module dtype { encoder_model:'fp32', decoder_model_merged:'q4' } the worker
    // passes on the WebGPU backend.
    onnx: ['onnx/encoder_model.onnx', 'onnx/decoder_model_merged_q4.onnx'],
  },
];

const MODELS_ROOT = join(ROOT, 'src/renderer/public/models');
const WASM_DIR = join(ROOT, 'src/renderer/public/wasm');
const ORT_DIST = join(ROOT, 'node_modules/onnxruntime-web/dist');

const FORCE = process.env.FORCE_STT_ASSETS === '1';

// Tokenizer / config / preprocessor JSON the WhisperProcessor needs. Required ones
// fail loudly; optional ones are downloaded if present (404 → skipped).
const REQUIRED_CONFIG = [
  'config.json',
  'generation_config.json',
  'preprocessor_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];
const OPTIONAL_CONFIG = [
  'special_tokens_map.json',
  'added_tokens.json',
  'normalizer.json',
  'vocab.json',
  'merges.txt',
];

// Default q8 ONNX (== transformers.js DATA_TYPES.q8 → "_quantized" file suffix). The
// merged decoder handles both the first step and the with-past steps, so these two
// files are all Whisper ASR needs. A model may override this via its own `onnx` list
// (e.g. the GPU tier's fp32 encoder + q4 decoder).
const DEFAULT_ONNX = [
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

async function exists(p) {
  try { await access(p); return true; } catch { return false; }
}

async function download(modelDir, hfBase, relPath, { required }) {
  const dest = join(modelDir, relPath);
  if (!FORCE && (await exists(dest))) {
    console.log(`  · skip   ${relPath} (exists)`);
    return true;
  }
  const url = `${hfBase}/${relPath}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (required) throw new Error(`required asset missing: ${url} → HTTP ${res.status}`);
    console.log(`  · skip   ${relPath} (HTTP ${res.status})`);
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, buf);
  console.log(`  ✓ fetch  ${relPath} (${(buf.length / 1e6).toFixed(1)} MB)`);
  return true;
}

async function copyWasm() {
  if (!existsSync(ORT_DIST)) {
    throw new Error(
      `onnxruntime-web not found at ${ORT_DIST}.\n` +
      `Run \`npm install\` first (it is a transitive dep of @huggingface/transformers).`
    );
  }
  await mkdir(WASM_DIR, { recursive: true });
  // Copy the runtime-fetched WASM backend files (binary + JS glue). The main ORT
  // library JS is bundled into the renderer by Vite; only these are loaded from
  // wasmPaths at runtime. Copying the whole set keeps us robust to which build
  // transformers.js selects (plain SIMD-threaded, asyncify, jsep, ...).
  const names = (await readdir(ORT_DIST)).filter((f) => /^ort-wasm-.*\.(wasm|mjs)$/.test(f));
  if (names.length === 0) throw new Error(`no ort-wasm-*.{wasm,mjs} files in ${ORT_DIST}`);
  let bytes = 0;
  for (const name of names) {
    const dest = join(WASM_DIR, name);
    if (!FORCE && (await exists(dest))) { console.log(`  · skip   ${name} (exists)`); continue; }
    await copyFile(join(ORT_DIST, name), dest);
    bytes += (await stat(dest)).size;
    console.log(`  ✓ copy   ${name}`);
  }
  console.log(`  copied ${names.length} ORT files (${(bytes / 1e6).toFixed(1)} MB new)`);
}

async function prepareModel({ id, repo, onnx }) {
  const modelDir = join(MODELS_ROOT, id);
  const hfBase = `https://huggingface.co/${repo}/resolve/main`;
  console.log(`\nModel "${id}" → ${modelDir}`);
  await mkdir(modelDir, { recursive: true });
  for (const f of REQUIRED_CONFIG) await download(modelDir, hfBase, f, { required: true });
  for (const f of OPTIONAL_CONFIG) await download(modelDir, hfBase, f, { required: false });
  for (const f of (onnx ?? DEFAULT_ONNX)) await download(modelDir, hfBase, f, { required: true });
}

async function main() {
  console.log(`\nPreparing offline speech-to-text assets…\n`);
  for (const m of MODELS) await prepareModel(m);

  console.log(`\nONNX Runtime WASM → ${WASM_DIR}`);
  await copyWasm();

  console.log('\n✅ STT assets ready. They are gitignored and packaged from src/renderer/public/.\n');
}

main().catch((err) => {
  console.error(`\n❌ prepare-stt-assets failed: ${err.message}\n`);
  process.exit(1);
});
