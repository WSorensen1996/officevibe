// Microphone capture → 16 kHz mono Float32 PCM, the exact format Whisper expects.
// All decoding + resampling use the browser's Web Audio API (Chromium ships the
// webm/opus decoder and a real resampler), so there is NO ffmpeg dependency.

import { sttLog } from './log';

const TARGET_SAMPLE_RATE = 16000;

export interface Recorder {
  /** Stop recording and resolve the decoded 16 kHz mono PCM. */
  stop: () => Promise<Float32Array>;
  /** Abort without transcribing (e.g. on unmount); releases the mic. */
  cancel: () => void;
}

/** Open the mic and begin recording. Resolves once capture has started. */
export async function startRecording(): Promise<Recorder> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // Keep the raw signal for ASR; the browser's voice processing can hurt accuracy.
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.start();
  sttLog('log', 'getUserMedia ok; device=', stream.getAudioTracks()[0]?.label || '(unknown)',
    '| MediaRecorder.mimeType=', recorder.mimeType || '(default)');

  const releaseMic = () => stream.getTracks().forEach((t) => t.stop());

  return {
    cancel: () => { try { recorder.stop(); } catch { /* already stopped */ } releaseMic(); },
    stop: () =>
      new Promise<Float32Array>((resolve, reject) => {
        recorder.onerror = (ev) => {
          releaseMic();
          const err = (ev as unknown as { error?: Error }).error ?? new Error('recording failed');
          sttLog('error', 'MediaRecorder error:', err);
          reject(err);
        };
        recorder.onstop = async () => {
          releaseMic();
          try {
            // decodeAudioData needs the COMPLETE recording — one Blob of all chunks.
            const blob = new Blob(chunks, { type: chunks[0]?.type || 'audio/webm' });
            const bytes = chunks.reduce((n, c) => n + c.size, 0);
            sttLog('log', `recording stopped: ${chunks.length} chunk(s), ${bytes} bytes, type=${blob.type}`);
            if (bytes === 0) { reject(new Error('no audio captured (0 bytes) — mic may be muted/unavailable')); return; }
            resolve(await blobToPcm16k(blob));
          } catch (err) {
            sttLog('error', 'decode/resample failed:', err);
            reject(err);
          }
        };
        try { recorder.stop(); } catch (err) { releaseMic(); reject(err); }
      })
  };
}

async function blobToPcm16k(blob: Blob): Promise<Float32Array> {
  const arrayBuf = await blob.arrayBuffer();

  // Decode the (typically 48 kHz webm/opus) capture — Chromium has the codec built in.
  const decodeCtx = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(arrayBuf);
  } finally {
    void decodeCtx.close();
  }
  sttLog('log', `decoded audio: ${decoded.duration.toFixed(2)}s @ ${decoded.sampleRate}Hz, ${decoded.numberOfChannels}ch`);

  // Downmix to mono + resample to 16 kHz using the browser's offline resampler.
  // (Chromium ignores a 16 kHz getUserMedia constraint, so we always resample.)
  const frames = Math.max(1, Math.ceil(decoded.duration * TARGET_SAMPLE_RATE));
  const offline = new OfflineAudioContext(1, frames, TARGET_SAMPLE_RATE);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();

  // Copy out of the AudioBuffer so the result is a standalone, transferable buffer.
  const pcm = rendered.getChannelData(0).slice();
  sttLog('log', `resampled to ${TARGET_SAMPLE_RATE}Hz mono: ${pcm.length} samples`);
  return pcm;
}
