// The meeting capture engine: microphone + system audio + screen → one combined
// recording on disk, plus per-source 16 kHz PCM taps for live transcription.
//
// MODULE-SCOPED SINGLETON (like terminalPool): the engine must survive left-tab
// switches — React components subscribe to its state via useMeeting, they never
// own the MediaRecorder. At most one meeting records at a time.
//
// Source topology (the meetily trick — mix for the RECORDING, split for the STT):
//   mic stream ────────┬─ mix AudioContext (48k) ─ MediaStreamDestination ─┐
//   system stream ─────┘                                                   ├─ MediaRecorder → 2s chunks → IPC append
//   screen videoTrack ─────────────────────────────────────────────────────┘
//   mic stream ────────┬─ stt AudioContext (16k) ─ pcm-tap worklet → onPcm('mic', …)
//   system stream ─────┘                          ─ pcm-tap worklet → onPcm('system', …)
//
// System audio per platform: Linux (primary) uses a PulseAudio/PipeWire
// "Monitor of <sink>" input device via getUserMedia; Windows/macOS get a loopback
// audio track on the getDisplayMedia stream (granted by the main process's
// display-media handler). The 16 kHz stt context makes Chromium do the
// resampling natively — no OfflineAudioContext per segment.

import { PcmSegmenter } from './segmenter';
import { MeetingTranscriber } from './transcriber';

export interface AudioInputDevice {
  deviceId: string;
  label: string;
  /** Heuristic: a PulseAudio/PipeWire monitor source (system-audio loopback). */
  isMonitor: boolean;
}

export interface CaptureCallbacks {
  /** Throttled RMS level per source (0..~1), for the setup/live meters. */
  onLevel?: (source: 'mic' | 'system', rms: number) => void;
  /** Depth of the speech-segment queue awaiting transcription — the UI's
   *  "transcription lagging" signal. */
  onBacklog?: (depth: number) => void;
  /** Capture ended outside the Stop button (user hit the OS "stop sharing" bar,
   *  device unplugged). The store turns this into a graceful meeting stop. */
  onAutoStop?: (reason: string) => void;
  /** Non-fatal runtime error worth surfacing (a failed chunk write, frame grab). */
  onError?: (message: string) => void;
}

export interface CaptureOptions extends CaptureCallbacks {
  meetingId: string;
  mic: boolean;
  /** Linux monitor-device id for system audio; null = none. */
  systemAudioDeviceId: string | null;
  screen: boolean;
  /** Ask for loopback audio on the display stream (Windows/macOS path). */
  displayLoopback: boolean;
  frameCapture: boolean;
  frameIntervalSec: number;
  /** Whisper model folder for the meeting worker (always CPU/WASM). */
  sttModel: string;
  /** 'auto' | 'en' | 'da' — pins Whisper's language on multilingual models. */
  language: string;
}

interface EngineState {
  meetingId: string;
  startedAtMs: number;
  micStream: MediaStream | null;
  systemStream: MediaStream | null;
  displayStream: MediaStream | null;
  mixCtx: AudioContext;
  sttCtx: AudioContext | null;
  recorder: MediaRecorder;
  frameTimer: ReturnType<typeof setInterval> | null;
  frameVideo: HTMLVideoElement | null;
  frameCanvas: HTMLCanvasElement | null;
  /** Serialized chunk writes — ondataavailable → arrayBuffer() is async, so without
   *  a chain two chunks could land on disk out of order and corrupt the webm. */
  writeChain: Promise<void>;
  /** Live transcription: per-source VAD segmenters feeding one serial Whisper queue. */
  segmenters: Partial<Record<'mic' | 'system', PcmSegmenter>>;
  transcriber: MeetingTranscriber | null;
  stopping: boolean;
  opts: CaptureOptions;
}

let state: EngineState | null = null;

function log(level: 'log' | 'error', ...parts: unknown[]): void {
  (level === 'error' ? console.error : console.log)('[meeting]', ...parts);
  try { window.cth?.sttLog?.(level, ['[meeting]', ...parts.map((p) => (p instanceof Error ? p.message : p))]); } catch { /* noop */ }
}

/** Same-origin base the static assets are served from (dev: Vite http URL;
 *  packaged: app://bundle/) — mirrors assetBase() in useDictation. */
function assetBase(): string {
  return new URL('.', window.location.href).href;
}

export function isCapturing(): boolean {
  return state !== null;
}

/** Audio input devices, monitors flagged. Labels require mic permission — we
 *  request (and immediately release) a throwaway stream the first time so the
 *  picker shows real names instead of "Default". */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (devices.some((d) => d.kind === 'audioinput' && !d.label)) {
    try {
      const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
      probe.getTracks().forEach((t) => t.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
    } catch { /* keep label-less list — picker still works by index */ }
  }
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label || `Audio input ${d.deviceId.slice(0, 6)}`,
      isMonitor: /monitor/i.test(d.label)
    }));
}

export async function startCapture(opts: CaptureOptions): Promise<{ ok: true } | { ok: false; error: string }> {
  if (state) return { ok: false, error: 'a meeting capture is already running' };
  if (!opts.mic && !opts.systemAudioDeviceId && !(opts.screen && opts.displayLoopback)) {
    return { ok: false, error: 'pick at least one audio source' };
  }

  const acquired: MediaStream[] = [];
  const releaseAll = (): void => {
    for (const s of acquired) for (const t of s.getTracks()) { try { t.stop(); } catch { /* gone */ } }
  };

  try {
    // ── 1. Acquire streams ──────────────────────────────────────────────────
    let micStream: MediaStream | null = null;
    if (opts.mic) {
      // Unlike dictation, echoCancellation is ON: remote voices playing through
      // loudspeakers would otherwise re-enter the mic and double into the "me"
      // transcription channel. NS/AGC stay off to keep the signal honest for ASR.
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false }
      });
      acquired.push(micStream);
    }

    let systemStream: MediaStream | null = null;
    if (opts.systemAudioDeviceId) {
      // Linux: the PulseAudio/PipeWire monitor device IS the system output.
      systemStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: opts.systemAudioDeviceId },
          echoCancellation: false, noiseSuppression: false, autoGainControl: false
        }
      });
      acquired.push(systemStream);
    }

    let displayStream: MediaStream | null = null;
    if (opts.screen) {
      // The main process's setDisplayMediaRequestHandler resolves the armed source
      // (X11 picker) or the Wayland portal's pick, and attaches loopback audio on
      // Windows/macOS when we ask for audio here.
      displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 5, max: 10 } },
        audio: opts.displayLoopback
      });
      acquired.push(displayStream);
      // Win/mac: system audio rides the display stream.
      if (!systemStream && displayStream.getAudioTracks().length > 0) {
        systemStream = new MediaStream(displayStream.getAudioTracks());
      }
    }

    if (!micStream && !systemStream) {
      releaseAll();
      return { ok: false, error: 'no audio source available (mic denied and no system audio)' };
    }

    // ── 2. Mix graph for the recording ──────────────────────────────────────
    const mixCtx = new AudioContext(); // device rate (typically 48k) — best for opus
    const dest = mixCtx.createMediaStreamDestination();
    for (const s of [micStream, systemStream]) {
      if (!s || s.getAudioTracks().length === 0) continue;
      const src = mixCtx.createMediaStreamSource(s);
      const gain = mixCtx.createGain();
      gain.gain.value = 1.0;
      src.connect(gain).connect(dest);
    }

    const videoTrack = displayStream?.getVideoTracks()[0] ?? null;
    const recStream = new MediaStream([
      ...(videoTrack ? [videoTrack] : []),
      ...dest.stream.getAudioTracks()
    ]);
    const mimeType = videoTrack ? 'video/webm;codecs=vp8,opus' : 'audio/webm;codecs=opus';
    const recorder = new MediaRecorder(recStream, {
      mimeType,
      videoBitsPerSecond: 1_000_000, // ~1 GB per 2h with 5 fps screen video
      audioBitsPerSecond: 96_000
    });

    state = {
      meetingId: opts.meetingId,
      startedAtMs: performance.now(),
      micStream, systemStream, displayStream,
      mixCtx,
      sttCtx: null,
      recorder,
      frameTimer: null,
      frameVideo: null,
      frameCanvas: null,
      writeChain: Promise.resolve(),
      segmenters: {},
      transcriber: null,
      stopping: false,
      opts
    };

    recorder.ondataavailable = (e) => {
      if (!state || state.recorder !== recorder || e.data.size === 0) return;
      const st = state;
      st.writeChain = st.writeChain
        .then(() => e.data.arrayBuffer())
        .then((buf) => window.cth.meeting.appendChunk(opts.meetingId, buf))
        .then((res) => { if (!res?.ok) throw new Error(res?.error ?? 'append failed'); })
        .catch((err) => {
          log('error', 'chunk write failed:', err);
          opts.onError?.(`recording write failed: ${err instanceof Error ? err.message : err}`);
        });
    };
    recorder.onerror = (e) => {
      const err = (e as unknown as { error?: Error }).error;
      log('error', 'MediaRecorder error:', err);
      opts.onError?.(`recorder error: ${err?.message ?? 'unknown'}`);
    };
    recorder.start(2000); // 2s timeslice → crash loses at most the last chunk

    // ── 3. Live transcription: taps → VAD segmenters → serial Whisper queue ────
    try {
      installTranscription(opts);
      await installPcmTaps(micStream, systemStream);
    } catch (e) {
      // Taps failing must not kill the recording — transcription degrades, the
      // meeting record survives.
      log('error', 'pcm taps failed (recording continues, no live transcription):', e);
      opts.onError?.('live transcription unavailable (audio tap failed)');
    }

    // ── 4. Frames + OS-level stop handling ──────────────────────────────────
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => {
        // The user hit the browser/OS "stop sharing" UI — treat as meeting stop.
        if (state && !state.stopping) opts.onAutoStop?.('screen sharing was stopped');
      });
      if (opts.frameCapture) startFrameCapture(displayStream!, opts);
    }

    log('log', `capture started for ${opts.meetingId}:`,
      `mic=${!!micStream} system=${!!systemStream} screen=${!!videoTrack} (${mimeType})`);
    return { ok: true };
  } catch (e) {
    releaseAll();
    try { await stopCapture(); } catch { /* already torn down */ }
    const msg = e instanceof Error ? e.message : String(e);
    log('error', 'startCapture failed:', e);
    return { ok: false, error: msg };
  }
}

/** Stop everything, flush the recorder's final chunk to disk, transcribe the
 *  speech tail (bounded), release devices. Resolves once the last chunk write
 *  has settled — callers can then finalize metadata knowing recording.webm is
 *  complete. */
export async function stopCapture(): Promise<{ durationSec: number }> {
  const st = state;
  if (!st) return { durationSec: 0 };
  st.stopping = true;

  // Stop the recorder and wait for the final dataavailable + onstop.
  await new Promise<void>((resolveStop) => {
    if (st.recorder.state === 'inactive') { resolveStop(); return; }
    const done = (): void => resolveStop();
    st.recorder.onstop = done;
    try { st.recorder.stop(); } catch { done(); }
    // Belt & braces: never hang a stop on a wedged recorder.
    setTimeout(done, 4000);
  });
  await st.writeChain.catch(() => { /* surfaced via onError already */ });

  if (st.frameTimer) clearInterval(st.frameTimer);
  if (st.frameVideo) { try { st.frameVideo.srcObject = null; } catch { /* noop */ } }
  for (const s of [st.micStream, st.systemStream, st.displayStream]) {
    if (s) for (const t of s.getTracks()) { try { t.stop(); } catch { /* gone */ } }
  }
  try { await st.mixCtx.close(); } catch { /* already closed */ }
  // Closing the stt context stops new PCM; then flush open speech and give the
  // queue a bounded window to transcribe the meeting's tail.
  try { await st.sttCtx?.close(); } catch { /* already closed */ }
  for (const seg of Object.values(st.segmenters)) { try { seg.flush(); } catch { /* noop */ } }
  if (st.transcriber) {
    await Promise.race([
      st.transcriber.drain(),
      new Promise((r) => setTimeout(r, 20_000))
    ]);
    st.transcriber.dispose();
  }

  const durationSec = (performance.now() - st.startedAtMs) / 1000;
  state = null;
  log('log', `capture stopped after ${durationSec.toFixed(1)}s`);
  return { durationSec };
}

// ─── internals ────────────────────────────────────────────────────────────────

/** Build the live-transcription chain: one Whisper worker (warmed in the
 *  background — first segments queue while the model loads) and a VAD segmenter
 *  per source. Transcribed segments go straight to the meeting record over IPC;
 *  the main process echoes them back as the renderer's live feed event. */
function installTranscription(opts: CaptureOptions): void {
  const st = state;
  if (!st) return;
  const transcriber = new MeetingTranscriber(
    opts.sttModel,
    opts.language,
    (seg) => {
      void window.cth.meeting.appendTranscript(opts.meetingId, [seg])
        .then((res) => { if (!res?.ok) log('error', 'transcript append failed:', res?.error); })
        .catch((e) => log('error', 'transcript append failed:', e));
    },
    (depth) => opts.onBacklog?.(depth)
  );
  st.transcriber = transcriber;
  void transcriber.init().catch((e) => {
    log('error', 'meeting model failed to load (recording continues):', e);
    opts.onError?.(`live transcription unavailable: ${e instanceof Error ? e.message : e}`);
  });
  for (const source of ['mic', 'system'] as const) {
    st.segmenters[source] = new PcmSegmenter((seg) => transcriber.enqueue(source, seg));
  }
}

/** Attach a pcm-tap worklet per audio source inside a dedicated 16 kHz context
 *  (Chromium resamples MediaStreamSource input to the context rate natively).
 *  A zero-gain sink keeps the graph pulled without making sound. */
async function installPcmTaps(micStream: MediaStream | null, systemStream: MediaStream | null): Promise<void> {
  const st = state;
  if (!st) return;
  const sources: Array<['mic' | 'system', MediaStream]> = [];
  if (micStream && micStream.getAudioTracks().length) sources.push(['mic', micStream]);
  if (systemStream && systemStream.getAudioTracks().length) sources.push(['system', systemStream]);
  if (sources.length === 0) return;

  const sttCtx = new AudioContext({ sampleRate: 16000 });
  st.sttCtx = sttCtx;
  await sttCtx.audioWorklet.addModule(assetBase() + 'meeting/pcm-tap.worklet.js');

  for (const [name, stream] of sources) {
    const src = sttCtx.createMediaStreamSource(stream);
    const tap = new AudioWorkletNode(sttCtx, 'pcm-tap');
    const mute = sttCtx.createGain();
    mute.gain.value = 0;
    src.connect(tap).connect(mute).connect(sttCtx.destination);

    let lastLevelAt = 0;
    tap.port.onmessage = (e: MessageEvent) => {
      const pcm = e.data as Float32Array;
      const cur = state;
      if (!cur || cur.sttCtx !== sttCtx) return; // stale tap after teardown
      // Throttled RMS for the UI meter (~4 Hz).
      const now = performance.now();
      if (cur.opts.onLevel && now - lastLevelAt > 250) {
        lastLevelAt = now;
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
        cur.opts.onLevel(name, Math.sqrt(sum / pcm.length));
      }
      // The segmenter copies what it keeps, so handing it the transferred batch
      // synchronously is safe.
      cur.segmenters[name]?.push(pcm);
    };
  }
}

/** Periodically draw the live screen video to a canvas and persist a downscaled
 *  JPEG — the analyst's eyes on the shared screen. */
function startFrameCapture(displayStream: MediaStream, opts: CaptureOptions): void {
  const st = state;
  if (!st) return;
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = new MediaStream(displayStream.getVideoTracks());
  void video.play().catch((e) => log('error', 'frame video play failed:', e));
  st.frameVideo = video;
  const canvas = document.createElement('canvas');
  st.frameCanvas = canvas;

  const intervalMs = Math.max(5, opts.frameIntervalSec || 15) * 1000;
  st.frameTimer = setInterval(() => {
    const cur = state;
    if (!cur || cur.stopping || video.videoWidth === 0) return;
    const scale = Math.min(1, 1280 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob((blob) => {
      if (!blob || !state || state.stopping) return;
      const elapsedMs = performance.now() - state.startedAtMs;
      void blob.arrayBuffer()
        .then((buf) => window.cth.meeting.writeFrame(opts.meetingId, elapsedMs, buf))
        .then((res) => { if (!res?.ok) log('error', 'frame write failed:', res && 'error' in res ? res.error : '?'); })
        .catch((e) => log('error', 'frame write failed:', e));
    }, 'image/jpeg', 0.7);
  }, intervalMs);
}
