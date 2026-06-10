import { writeFileSync, renameSync, chmodSync, statSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

/**
 * Durable, crash-safe file writes for the app's persisted state (task ledger,
 * agent registry, message cursors, config). Kept electron-free so it can be
 * unit-tested directly.
 *
 * The hazard these guard against: a plain `writeFileSync` that is interrupted
 * (force-quit, `kill -9`, power loss, OOM) leaves the target half-written. The
 * next `JSON.parse` then throws and the caller's fallback silently wipes the
 * file — losing every task or every agent registration. Writing a temp sibling
 * and atomically `renameSync`-ing it over the target means a reader always sees
 * either the complete old file or the complete new one, never a torn middle.
 */

export interface AtomicWriteOpts {
  /** POSIX mode for the final file (e.g. 0o600 for the secret-bearing config). */
  mode?: number;
}

/** Atomically replace `path` with `data` (temp-write → rename). */
export function atomicWriteFile(path: string, data: string, opts: AtomicWriteOpts = {}): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, data, opts.mode != null ? { encoding: 'utf8', mode: opts.mode } : 'utf8');
  // writeFileSync's mode only applies on create and is subject to umask; force it
  // on the temp so the perms survive the rename onto the final path.
  if (opts.mode != null) { try { chmodSync(tmp, opts.mode); } catch { /* non-POSIX fs */ } }
  renameSync(tmp, path); // atomic on the same filesystem
}

/** Atomically write `data` as pretty JSON. The crash-safe replacement for any
 *  `writeFileSync(p, JSON.stringify(...))` on a file we can't afford to lose. */
export function atomicWriteJson(path: string, data: unknown, opts: AtomicWriteOpts = {}): void {
  atomicWriteFile(path, JSON.stringify(data, null, 2), opts);
}

/** Bound an append-only file: when it exceeds `maxBytes`, rotate it to `${path}.1`
 *  (overwriting any previous rotation) so the live file — which tail-readers load
 *  whole — stays small. Keeps one generation of history. No-op if small or absent. */
export function rotateIfLarge(path: string, maxBytes: number): void {
  try {
    if (!existsSync(path)) return;
    if (statSync(path).size <= maxBytes) return;
    renameSync(path, `${path}.1`); // atomic; the next append re-creates `path`
  } catch { /* best-effort — never let log housekeeping break the caller */ }
}
