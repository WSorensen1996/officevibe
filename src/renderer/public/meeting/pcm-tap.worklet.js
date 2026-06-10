// AudioWorkletProcessor that taps mono PCM out of the meeting capture graph.
// Lives in public/ as plain JS (served same-origin → passes the app's CSP
// script-src 'self'; Vite copies public/ verbatim so the same URL works in dev
// and in a packaged app:// build — the same trick as the vendored Whisper assets).
//
// Runs inside an AudioContext({ sampleRate: 16000 }) so the PCM that arrives here
// is ALREADY 16 kHz mono — exactly what Whisper expects, no offline resampling.
// Batches ~2048 samples (128 ms) per postMessage to keep message churn low; the
// buffer is transferred (zero-copy) and a fresh one allocated.
class PcmTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(2048);
    this._fill = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]; // first input, channel 0 (mono graph)
    if (ch && ch.length) {
      let off = 0;
      while (off < ch.length) {
        const n = Math.min(ch.length - off, this._buf.length - this._fill);
        this._buf.set(ch.subarray(off, off + n), this._fill);
        this._fill += n;
        off += n;
        if (this._fill === this._buf.length) {
          const out = this._buf;
          this.port.postMessage(out, [out.buffer]);
          this._buf = new Float32Array(2048);
          this._fill = 0;
        }
      }
    }
    return true; // keep alive for the whole meeting
  }
}

registerProcessor('pcm-tap', PcmTapProcessor);
