// Shared one-liners for the meeting feature (capture engine + transcriber client),
// so there's exactly one copy of each to keep in sync.

/** Log to the console AND relay to the main process's consolidated [stt] sink so
 *  meeting diagnostics land in the `npm run dev` terminal next to dictation's. */
export function mtgLog(level: 'log' | 'error', ...parts: unknown[]): void {
  (level === 'error' ? console.error : console.log)('[meeting]', ...parts);
  try { window.cth?.sttLog?.(level, ['[meeting]', ...parts.map((p) => (p instanceof Error ? p.message : p))]); } catch { /* noop */ }
}

/** Same-origin base the static assets are served from (dev: Vite http URL;
 *  packaged: app://bundle/) — mirrors assetBase() in useDictation. */
export function assetBase(): string {
  return new URL('.', window.location.href).href;
}
