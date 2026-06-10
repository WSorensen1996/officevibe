import { safeStorage } from 'electron';

/**
 * Shared at-rest secret encryption for anything persisted to config.json.
 *
 * Values are sealed with Electron `safeStorage` (OS keychain / libsecret / DPAPI)
 * and tagged with `ENC_PREFIX` so we can tell ciphertext from legacy/fallback
 * plaintext on read. When no keyring is available (e.g. a headless Linux box)
 * `safeStorage.isEncryptionAvailable()` is false and we fall back to storing
 * plaintext — the same trade-off the MCP secret path makes.
 *
 * Used by both the MCP server secrets (env/header values, see mcp.ts) and the
 * Slack signing secret (config.ts).
 */

/** Marks a value encrypted by safeStorage (base64 ciphertext follows). */
export const ENC_PREFIX = 'enc:v1:';

/** True when a stored value is already sealed (so encryption is idempotent). */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

/** Seal a plaintext value. Idempotent (already-sealed input returned as-is) so it
 *  is safe to run on a config object that mixes fresh and previously-stored secrets. */
export function encryptValue(plain: string): string {
  if (!plain || isEncrypted(plain)) return plain;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
    }
  } catch { /* fall through to plaintext */ }
  return plain; // safeStorage unavailable (e.g. no keyring) → store plaintext
}

/** Inverse of encryptValue. Legacy/plaintext values pass through unchanged; an
 *  undecryptable value (keychain rotated/unavailable) returns '' rather than leaking ciphertext. */
export function decryptValue(stored: string): string {
  if (!stored || !isEncrypted(stored)) return stored; // legacy/plaintext
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    return '';
  }
}

/** True when safeStorage can actually encrypt on this machine. Surfaced to the
 *  UI so the user knows when secrets fall back to plaintext at rest. */
export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}
