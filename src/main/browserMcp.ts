/**
 * In-process MCP server that gives EVERY agent live control of its OWN embedded
 * browser view (a `WebContentsView` in the main window).
 *
 * Design notes:
 *  - It speaks MCP over a localhost-only Streamable-HTTP endpoint. Each agent is
 *    handed a DISTINCT per-agent token in its generated mcp.json (see project.ts);
 *    the request's `x-agent-token` header is resolved to that agent's browsing
 *    context, so one server multiplexes all agents and an unknown token is 401'd.
 *  - It drives the page with *stable* webContents APIs (`executeJavaScript` +
 *    `capturePage`) rather than attaching the Chrome DevTools Protocol debugger.
 *    That sidesteps the whole class of "DevTools detaches our CDP session" /
 *    target-selection problems and keeps this purely additive to the app.
 *  - Because it lives in the main process it holds a direct reference to each
 *    agent's view, so the user watches the on-stage agent's navigation/clicks
 *    happen live in the bottom-left pane (and can take over by clicking it).
 *
 * Trade-off: JS-dispatched clicks/keystrokes are `isTrusted:false`. That is fine
 * for the overwhelming majority of sites; the documented fidelity upgrade is to
 * move click/type onto CDP `Input.dispatch*` later if a site rejects synthetic
 * events. Everything else (navigate, snapshot, read, screenshot) is unaffected.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server as HttpServer } from 'node:http';
import type { WebContents } from 'electron';
import { z } from 'zod';

export interface BrowserMcpHandle {
  /** `http://127.0.0.1:<port>/mcp` — written into each agent's mcp.json. */
  url: string;
  /** The ACTUAL bound TCP port. Persisted by the caller so the next launch can
   *  reuse it (keeps the port baked into each agent's mcp.json valid across restarts). */
  port: number;
  /** Stop the HTTP listener. Best-effort; safe to call when already stopped. */
  stop(): void;
}

export interface StartBrowserMcpOptions {
  /** Preferred localhost port to bind — a persisted port reused across restarts so
   *  the URL stays STABLE and the port in every agent's mcp.json keeps resolving.
   *  Falls back to an OS-assigned ephemeral port if this one is taken (EADDRINUSE).
   *  Omit or 0 = always pick an ephemeral port. */
  preferredPort?: number;
}

/** One agent's browsing context: its (lazily-created) view + a getter for the
 *  live webContents. Returned by {@link BrowserMcpDeps.resolve}. */
export interface BrowserContext {
  /** Create this agent's WebContentsView if it doesn't exist yet (idempotent). */
  ensureView: () => void;
  /** This agent's live page webContents, or null if its view isn't up. */
  getWebContents: () => WebContents | null;
  /** Capture a PNG of this agent's page as base64 — works even when the view is
   *  parked offscreen (briefly stages it to force a paint if a direct capture is
   *  blank). Returns '' on failure. */
  capture: () => Promise<string>;
}

export interface BrowserMcpDeps {
  /** Resolve the agent identified by the request's `x-agent-token` to its
   *  browsing context, or null if the token is unknown (→ 401 / tool error). */
  resolve: (token: string) => BrowserContext | null;
}

interface SnapshotElement {
  ref: string;
  role: string;
  name: string;
  href?: string;
  type?: string;
}
interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
}

// ─── page scripts (run in the page via executeJavaScript) ────────────────────

/** Tag visible interactive elements with `data-mcp-ref` and return a compact
 *  list the model can act on. Capped so a huge page can't blow up the result. */
const SNAPSHOT_JS = `(() => {
  const SEL = 'a,button,input,textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[role=checkbox],[onclick],[contenteditable=true]';
  const out = [];
  let i = 0;
  for (const el of Array.from(document.querySelectorAll(SEL))) {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (r.width <= 0 || r.height <= 0 || cs.visibility === 'hidden' || cs.display === 'none') continue;
    const ref = 'e' + (i++);
    el.setAttribute('data-mcp-ref', ref);
    const role = el.getAttribute('role') || el.tagName.toLowerCase();
    const raw = el.getAttribute('aria-label') || el.value || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || '';
    const name = String(raw).replace(/\\s+/g, ' ').trim().slice(0, 120);
    const item = { ref, role, name };
    const href = el.getAttribute('href'); if (href) item.href = href.slice(0, 300);
    const type = el.getAttribute('type'); if (type) item.type = type;
    out.push(item);
    if (out.length >= 200) break;
  }
  return { url: location.href, title: document.title, elements: out };
})()`;

function clickJs(ref: string): string {
  return `((ref) => {
    const el = document.querySelector('[data-mcp-ref="' + ref + '"]');
    if (!el) return { ok: false, error: 'no element with ref ' + ref + ' — call browser_snapshot first' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    if (el.focus) el.focus();
    el.click();
    return { ok: true, url: location.href };
  })(${JSON.stringify(ref)})`;
}

function typeJs(ref: string, text: string, submit: boolean): string {
  return `((ref, text, submit) => {
    const el = document.querySelector('[data-mcp-ref="' + ref + '"]');
    if (!el) return { ok: false, error: 'no element with ref ' + ref + ' — call browser_snapshot first' };
    if (el.focus) el.focus();
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    const setter = proto && Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) setter.call(el, text);
    else if (el.isContentEditable) el.textContent = text;
    else if ('value' in el) el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    if (submit) {
      const ev = (t) => el.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
      ev('keydown'); ev('keyup');
      if (el.form && el.form.requestSubmit) el.form.requestSubmit();
    }
    return { ok: true };
  })(${JSON.stringify(ref)}, ${JSON.stringify(text)}, ${submit ? 'true' : 'false'})`;
}

// ─── webContents helpers ─────────────────────────────────────────────────────

async function snapshot(wc: WebContents): Promise<Snapshot> {
  return (await wc.executeJavaScript(SNAPSHOT_JS, true)) as Snapshot;
}

function goBack(wc: WebContents): void {
  const h = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; goBack(): void } }).navigationHistory;
  if (h?.canGoBack()) h.goBack();
}
function goForward(wc: WebContents): void {
  const h = (wc as unknown as { navigationHistory?: { canGoForward(): boolean; goForward(): void } }).navigationHistory;
  if (h?.canGoForward()) h.goForward();
}

// ─── MCP tool registration ───────────────────────────────────────────────────

type TextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const ok = (text: string): TextResult => ({ content: [{ type: 'text', text }] });
const err = (text: string): TextResult => ({ content: [{ type: 'text', text }], isError: true });

/** Normalize an agent-supplied URL to a safe http(s) URL, or null for any
 *  disallowed scheme (file:, data:, javascript:, …). Bare host → https. */
function toHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (!scheme) return `https://${s}`;
  return /^https?$/i.test(scheme[1]) ? s : null;
}

/** Register the browser_* tools on a fresh McpServer instance, bound to the
 *  agent identified by `token` (resolved per request via deps.resolve). */
function registerTools(server: { registerTool: (...a: unknown[]) => unknown }, deps: BrowserMcpDeps, token: string): void {
  const reg = server.registerTool.bind(server) as (
    name: string,
    cfg: { description: string; inputSchema?: Record<string, unknown> },
    cb: (args: Record<string, unknown>) => Promise<unknown>
  ) => unknown;

  const wc = (): WebContents | null => {
    const ctx = deps.resolve(token);
    if (!ctx) return null;
    ctx.ensureView();
    return ctx.getWebContents();
  };

  reg('browser_navigate',
    { description: 'Navigate the shared browser pane to a URL. The user watches this happen live in the app.',
      inputSchema: { url: z.string().describe('Absolute URL, e.g. https://example.com') } },
    async ({ url }) => {
      const w = wc(); if (!w) return err('Browser pane is not ready yet.');
      const target = toHttpUrl(url);
      if (!target) return err('Only http/https URLs are allowed.');
      try { await w.loadURL(target); } catch { /* loadURL rejects on aborts/redirects; the page still loads */ }
      const snap = await snapshot(w).catch(() => ({ title: '', elements: [] } as Partial<Snapshot>));
      return ok(`Navigated to ${w.getURL()}\nTitle: ${snap.title ?? ''}\n${snap.elements?.length ?? 0} interactive elements found. Call browser_snapshot for their refs.`);
    });

  reg('browser_snapshot',
    { description: 'List the visible interactive elements on the current page with stable refs (use them with browser_click / browser_type) plus the page title and URL.' },
    async () => {
      const w = wc(); if (!w) return err('Browser pane is not ready yet.');
      const snap = await snapshot(w);
      return ok(JSON.stringify(snap, null, 2));
    });

  reg('browser_click',
    { description: 'Click the element with the given ref (from browser_snapshot). The user sees the click live.',
      inputSchema: { ref: z.string().describe('A ref like "e3" from browser_snapshot') } },
    async ({ ref }) => {
      const w = wc(); if (!w) return err('Browser pane is not ready yet.');
      const r = await w.executeJavaScript(clickJs(String(ref ?? '')), true) as { ok: boolean; error?: string; url?: string };
      return r.ok ? ok(`Clicked ${ref}. Now at ${r.url}. Call browser_snapshot to see the new state.`) : err(r.error ?? 'click failed');
    });

  reg('browser_type',
    { description: 'Type text into the input/textarea with the given ref. Set submit=true to press Enter / submit the form afterwards.',
      inputSchema: {
        ref: z.string().describe('A ref like "e3" from browser_snapshot'),
        text: z.string().describe('The text to type'),
        submit: z.boolean().optional().describe('Press Enter / submit the form after typing')
      } },
    async ({ ref, text, submit }) => {
      const w = wc(); if (!w) return err('Browser pane is not ready yet.');
      const r = await w.executeJavaScript(typeJs(String(ref ?? ''), String(text ?? ''), submit === true), true) as { ok: boolean; error?: string };
      return r.ok ? ok(`Typed into ${ref}${submit ? ' and submitted' : ''}.`) : err(r.error ?? 'type failed');
    });

  reg('browser_read_text',
    { description: 'Return the visible text content of the current page (truncated).' },
    async () => {
      const w = wc(); if (!w) return err('Browser pane is not ready yet.');
      const text = await w.executeJavaScript('document.body ? document.body.innerText : ""', true) as string;
      return ok(String(text).slice(0, 20000));
    });

  reg('browser_screenshot',
    { description: 'Capture a screenshot of your browser page so you can see what is on screen. Works even when another agent is the one being watched in the pane.' },
    async () => {
      const ctx = deps.resolve(token); if (!ctx) return err('Browser is not provisioned for this agent.');
      ctx.ensureView();
      const data = await ctx.capture();
      if (!data) return err('Screenshot was empty (the page may not have painted yet — try browser_wait then retry).');
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] } as unknown as TextResult;
    });

  reg('browser_go_back',
    { description: 'Go back one entry in the browser history.' },
    async () => { const w = wc(); if (!w) return err('Browser pane is not ready yet.'); goBack(w); return ok('Went back. Now at ' + w.getURL()); });

  reg('browser_go_forward',
    { description: 'Go forward one entry in the browser history.' },
    async () => { const w = wc(); if (!w) return err('Browser pane is not ready yet.'); goForward(w); return ok('Went forward. Now at ' + w.getURL()); });

  reg('browser_reload',
    { description: 'Reload the current page.' },
    async () => { const w = wc(); if (!w) return err('Browser pane is not ready yet.'); w.reload(); return ok('Reloaded ' + w.getURL()); });

  reg('browser_wait',
    { description: 'Wait for a number of seconds (e.g. for a page or an async action to settle).',
      inputSchema: { seconds: z.number().describe('Seconds to wait (1–30)') } },
    async ({ seconds }) => {
      const s = Math.min(30, Math.max(0, Number(seconds) || 0));
      await new Promise((r) => setTimeout(r, s * 1000));
      return ok(`Waited ${s}s.`);
    });
}

// ─── HTTP transport (stateless Streamable HTTP, localhost + token) ───────────

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; if (data.length > 4_000_000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || 'null')); } catch { resolve(null); } });
    req.on('error', () => resolve(null));
  });
}

/**
 * Start the browser MCP server on a localhost port. Binds `opts.preferredPort`
 * (a persisted port) when given so the URL stays STABLE across restarts — the
 * port written into every agent's mcp.json keeps resolving and no agent restart
 * is needed; falls back to an ephemeral port if it's taken. Returns the URL +
 * the actual bound port (the caller persists it). Each request carries its OWN
 * per-agent `x-agent-token`, resolved via deps.resolve. The SDK is ESM-only, so
 * it's pulled in via dynamic import (works from the CJS main bundle).
 */
export async function startBrowserMcp(deps: BrowserMcpDeps, opts: StartBrowserMcpOptions = {}): Promise<BrowserMcpHandle> {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');

  const makeServer = (token: string): InstanceType<typeof McpServer> => {
    const server = new McpServer({ name: 'officevibe-browser', version: '0.1.0' }, { capabilities: { tools: {} } });
    registerTools(server as unknown as { registerTool: (...a: unknown[]) => unknown }, deps, token);
    return server;
  };

  const httpServer: HttpServer = createServer((req, res) => {
    void handle(req, res).catch((e) => {
      try {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: String(e) } }));
      } catch { /* response already sent */ }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!(req.url ?? '').startsWith('/mcp')) { res.writeHead(404).end(); return; }
    const token = typeof req.headers['x-agent-token'] === 'string' ? req.headers['x-agent-token'] : '';
    // Per-agent auth: the token must resolve to a live agent browsing context.
    if (!token || !deps.resolve(token)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'unauthorized' } }));
      return;
    }
    if (req.method !== 'POST') {
      // Stateless server: no server-initiated SSE stream / session to GET or DELETE.
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'method not allowed' } }));
      return;
    }
    const body = await readBody(req);
    const server = makeServer(token);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { try { void transport.close(); } catch { /* noop */ } try { void server.close(); } catch { /* noop */ } });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  // Bind the persisted/preferred port so the URL is STABLE across restarts and the
  // port baked into each agent's mcp.json keeps resolving. 127.0.0.1-only. If that
  // port is taken (EADDRINUSE — e.g. a stale instance still holding it), fall back to
  // an OS-assigned ephemeral port so startup never wedges.
  const bind = (p: number): Promise<void> => new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException): void => { httpServer.removeListener('listening', onListening); reject(e); };
    const onListening = (): void => { httpServer.removeListener('error', onError); resolve(); };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(p, '127.0.0.1');
  });
  const preferred = opts.preferredPort && opts.preferredPort > 0 ? opts.preferredPort : 0;
  try {
    await bind(preferred);
  } catch (e) {
    if (preferred !== 0 && (e as NodeJS.ErrnoException).code === 'EADDRINUSE') {
      await bind(0); // persisted port taken → ephemeral fallback (caller persists the new one)
    } else {
      throw e;
    }
  }
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    stop() { try { httpServer.close(); } catch { /* noop */ } }
  };
}
