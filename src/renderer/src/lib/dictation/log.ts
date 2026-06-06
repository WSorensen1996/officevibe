// Shared `[stt]` logger for the main-thread dictation modules (hook + audio capture).
// Prints to the renderer DevTools console AND forwards to the main process so the
// line also appears in the `npm run dev` terminal — one consolidated place to read.
// (The worker can't use window.cth; it posts {type:'log'} messages the hook relays.)
export function sttLog(level: 'log' | 'error', ...parts: unknown[]): void {
  (level === 'error' ? console.error : console.log)('[stt]', ...parts);
  try { window.cth?.sttLog?.(level, parts); } catch { /* preload not ready */ }
}
