import { safeStorage } from 'electron';

/**
 * User-configured MCP servers that get wired into the Claude Code agents the app
 * spawns. Persisted as `mcpServers` on HarnessConfig (userData/config.json) and
 * mapped onto each agent's `mcp.json` (loaded via `--mcp-config`) at spawn time.
 *
 * Secret-bearing values (every value in `env` and `headers`) are encrypted at
 * rest with Electron safeStorage — see encryptDef/decryptDef. Everything else
 * (name, transport, url, command, args, scope) stays plaintext so the list can
 * be rendered without decrypting.
 */
export interface McpServerDef {
  /** Stable id (slug + random suffix); the key we upsert/remove by. */
  id: string;
  /** The mcp.json key Claude Code uses, e.g. "github". Must match [a-z0-9_-]. */
  name: string;
  /** Disabled servers are kept but never written into any agent's mcp.json. */
  enabled: boolean;
  /** Which agents receive this server: every agent, or Michael (god) only. */
  scope: 'all' | 'god';
  /** Local process (stdio) or remote endpoint (http/sse). */
  transport: 'stdio' | 'http' | 'sse';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  // http / sse
  url?: string;
  headers?: Record<string, string>;
}

/** The Claude Code server entry shape written into mcp.json (`mcpServers[name]`). */
export type ClaudeMcpEntry =
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http' | 'sse'; url: string; headers?: Record<string, string> };

/** Marks a value encrypted by safeStorage (base64 ciphertext follows). Lets us
 *  tell encrypted from legacy/fallback plaintext on read. */
const ENC_PREFIX = 'enc:v1:';

function encryptValue(plain: string): string {
  if (!plain) return plain;
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
    }
  } catch { /* fall through to plaintext */ }
  return plain; // safeStorage unavailable (e.g. no keyring) → store plaintext
}

function decryptValue(stored: string): string {
  if (!stored || !stored.startsWith(ENC_PREFIX)) return stored; // legacy/plaintext
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(ENC_PREFIX.length), 'base64'));
  } catch {
    // Keychain changed/unavailable — we can't recover; never leak ciphertext into mcp.json.
    return '';
  }
}

function mapValues(rec: Record<string, string> | undefined, fn: (v: string) => string): Record<string, string> | undefined {
  if (!rec) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k] = typeof v === 'string' ? fn(v) : v;
  return out;
}

/** Encrypt the secret-bearing values (env + header values) for storage. */
export function encryptDef(def: McpServerDef): McpServerDef {
  return { ...def, env: mapValues(def.env, encryptValue), headers: mapValues(def.headers, encryptValue) };
}

/** Inverse of encryptDef — decrypt secrets back to plaintext for use/display. */
export function decryptDef(def: McpServerDef): McpServerDef {
  return { ...def, env: mapValues(def.env, decryptValue), headers: mapValues(def.headers, decryptValue) };
}

/** True when safeStorage can actually encrypt on this machine. Surfaced to the
 *  UI so the user knows when secrets fall back to plaintext at rest. */
export function encryptionAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

/** Validate an mcp.json server key. A bad key breaks the whole --mcp-config load,
 *  so we gate it at save time. */
export function isValidName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

/** Map a (decrypted) def to the Claude Code mcp.json entry shape. */
export function toClaudeMcpEntry(def: McpServerDef): ClaudeMcpEntry {
  if (def.transport === 'stdio') {
    const env = def.env && Object.keys(def.env).length > 0 ? def.env : undefined;
    return { type: 'stdio', command: def.command ?? '', args: def.args ?? [], ...(env ? { env } : {}) };
  }
  const headers = def.headers && Object.keys(def.headers).length > 0 ? def.headers : undefined;
  return { type: def.transport, url: def.url ?? '', ...(headers ? { headers } : {}) };
}

/**
 * Build the merged `mcpServers` map (decrypted) for one agent, plus the granted
 * server names (used to add `mcp__<name>__*` permission allow-rules). Filters to
 * enabled servers in scope: `all` everyone gets, `god` only Michael gets.
 */
export function mcpServersForAgent(
  defs: McpServerDef[] | undefined,
  isGod: boolean
): { servers: Record<string, ClaudeMcpEntry>; names: string[] } {
  const servers: Record<string, ClaudeMcpEntry> = {};
  const names: string[] = [];
  for (const d of defs ?? []) {
    if (!d || !d.enabled || !d.name) continue;
    if (d.scope === 'god' && !isGod) continue;
    servers[d.name] = toClaudeMcpEntry(decryptDef(d));
    names.push(d.name);
  }
  return { servers, names };
}

/** Race a promise against a timeout, never leaving a dangling rejection. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  p.catch(() => { /* swallow late rejection if the timeout wins */ });
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}

/**
 * Live health check: connect to the server as an MCP client and list its tools.
 * Mirrors the SDK dynamic-import pattern used by the in-process browser server
 * (browserMcp.ts) so the CJS main bundle can load the ESM SDK.
 */
export async function testConnection(
  def: McpServerDef
): Promise<{ ok: boolean; tools?: string[]; error?: string }> {
  const d = decryptDef(def);
  let client: { connect(t: unknown): Promise<void>; listTools(): Promise<{ tools?: Array<{ name: string }> }>; close(): Promise<void> } | null = null;
  try {
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    let transport: unknown;
    if (d.transport === 'stdio') {
      if (!d.command?.trim()) return { ok: false, error: 'command is required for stdio' };
      const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
      transport = new StdioClientTransport({
        command: d.command,
        args: d.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(d.env ?? {}) }
      });
    } else {
      if (!d.url?.trim()) return { ok: false, error: 'url is required' };
      let url: URL;
      try { url = new URL(d.url); } catch { return { ok: false, error: 'invalid url' }; }
      const headers = d.headers && Object.keys(d.headers).length > 0 ? d.headers : undefined;
      const opts = headers ? { requestInit: { headers } } : undefined;
      if (d.transport === 'http') {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        transport = new StreamableHTTPClientTransport(url, opts);
      } else {
        const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
        transport = new SSEClientTransport(url, opts);
      }
    }

    client = new (Client as unknown as new (info: { name: string; version: string }, opts: { capabilities: object }) => NonNullable<typeof client>)(
      { name: 'officevibe-probe', version: '0.1.0' },
      { capabilities: {} }
    );
    await withTimeout(client.connect(transport), 10000, 'connection timed out');
    const res = await withTimeout(client.listTools(), 10000, 'listTools timed out');
    const tools = (res.tools ?? []).map((t) => t.name);
    return { ok: true, tools };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try { await client?.close(); } catch { /* best-effort */ }
  }
}
