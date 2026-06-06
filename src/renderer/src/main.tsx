import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { sttLog } from '@/lib/dictation/log';
import brandLogo from '@brand/logo.png?url';
import './design/global.css';

// [STT-WEBGPU-PROBE] Phase-1 go/no-go for GPU speech-to-text (task 5z52). Logs once
// on app start whether THIS machine exposes a usable WebGPU adapter (Linux+Electron
// WebGPU is flaky — this single check decides if Option A is viable). Goes through
// sttLog so the line shows in the `npm run dev` terminal AND DevTools — grep
// [STT-WEBGPU-PROBE]. Tiny + self-contained; REMOVE after the go/no-go decision.
void (async () => {
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) { sttLog('log', '[STT-WEBGPU-PROBE] adapter=NULL (navigator.gpu undefined — WebGPU not exposed)'); return; }
    const adapter = (await gpu.requestAdapter()) as { info?: Record<string, unknown>; name?: string } | null;
    if (!adapter) { sttLog('log', '[STT-WEBGPU-PROBE] adapter=NULL (no GPU adapter available)'); return; }
    const info = adapter.info ?? adapter.name ?? 'present';
    sttLog('log', '[STT-WEBGPU-PROBE] adapter=PRESENT', typeof info === 'string' ? info : JSON.stringify(info));
  } catch (e) {
    sttLog('error', '[STT-WEBGPU-PROBE] adapter=ERROR', e instanceof Error ? e.message : String(e));
  }
})();

const favicon = document.createElement('link');
favicon.rel = 'icon';
favicon.type = 'image/png';
favicon.href = brandLogo;
document.head.appendChild(favicon);

const splashMark = document.querySelector('#cth-splash .mk');
if (splashMark) {
  const img = document.createElement('img');
  img.src = brandLogo;
  img.alt = 'OfficeVibe';
  img.style.cssText = 'height:56px;width:auto;display:block';
  splashMark.replaceWith(img);
}

const root = document.getElementById('root');
if (!root) throw new Error('No root element');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
