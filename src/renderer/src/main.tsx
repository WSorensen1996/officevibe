import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { sttLog } from '@/lib/dictation/log';
import brandLogo from '@brand/logo.png?url';
import './design/global.css';

// [STT-WEBGPU-PROBE] Phase-1 go/no-go for GPU speech-to-text (task 5z52). On app
// start, probes whether THIS machine exposes a usable WebGPU adapter (Linux+Electron
// WebGPU is flaky). The result is (a) logged via sttLog → `npm run dev` terminal +
// DevTools (grep [STT-WEBGPU-PROBE]) AND (b) PERSISTED to <activeProject>/webgpu-probe.json
// via the sandboxed fs:writeFile IPC — a file is how the in-app reader (god) confirms
// the adapter post-deploy, since the konsole terminal isn't readable there. Tiny +
// self-contained; REMOVE the whole block after the GPU work ships.
void (async () => {
  const nowIso = (): string => { try { return new Date().toISOString(); } catch { return ''; } };
  let result: { ts: string; outcome: string; adapter: unknown; navigatorGpu: boolean; userAgent: string };
  try {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    if (!gpu) {
      result = { ts: nowIso(), outcome: 'null-navigator-gpu-undefined', adapter: null, navigatorGpu: false, userAgent: navigator.userAgent };
      sttLog('log', '[STT-WEBGPU-PROBE] adapter=NULL (navigator.gpu undefined — WebGPU not exposed)');
    } else {
      const adapter = (await gpu.requestAdapter()) as { info?: Record<string, unknown>; name?: string } | null;
      if (!adapter) {
        result = { ts: nowIso(), outcome: 'null-no-adapter', adapter: null, navigatorGpu: true, userAgent: navigator.userAgent };
        sttLog('log', '[STT-WEBGPU-PROBE] adapter=NULL (no GPU adapter available)');
      } else {
        const info = adapter.info ?? adapter.name ?? 'present';
        result = { ts: nowIso(), outcome: 'present', adapter: info, navigatorGpu: true, userAgent: navigator.userAgent };
        sttLog('log', '[STT-WEBGPU-PROBE] adapter=PRESENT', typeof info === 'string' ? info : JSON.stringify(info));
      }
    }
  } catch (e) {
    result = { ts: nowIso(), outcome: 'error', adapter: e instanceof Error ? e.message : String(e), navigatorGpu: false, userAgent: navigator.userAgent };
    sttLog('error', '[STT-WEBGPU-PROBE] adapter=ERROR', e instanceof Error ? e.message : String(e));
  }
  // Persist to a fixed project-root file (reuses the sandboxed fs:writeFile IPC).
  try {
    const cfg = await window.cth?.getConfig?.();
    const root = cfg?.activeProjectPath;
    if (!root) { sttLog('log', '[STT-WEBGPU-PROBE] no activeProjectPath — skipped file write'); return; }
    const res = await window.cth?.writeFile?.(root, 'webgpu-probe.json', JSON.stringify(result, null, 2));
    if (res?.ok) sttLog('log', '[STT-WEBGPU-PROBE] wrote', res.path);
    else sttLog('error', '[STT-WEBGPU-PROBE] file write failed', res ? res.error : '(cth.writeFile unavailable)');
  } catch (e) {
    sttLog('error', '[STT-WEBGPU-PROBE] file write threw', e instanceof Error ? e.message : String(e));
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
