/**
 * SlackWebhookServer — receive Slack messages and hand them to the harness.
 *
 * A bare `node:http` server (no @slack/bolt) that implements just enough of the
 * Slack Events API to let the user pipe a channel's messages into Michael's
 * message queue:
 *   - verifies EVERY request with Slack's signing-secret HMAC over the RAW body
 *     plus a 5-minute replay-timestamp guard (403 on any failure),
 *   - answers the one-time `url_verification` challenge handshake,
 *   - on a plain `message` event, strips a leading bot mention and emits the
 *     text via `onMessage`.
 *
 * It also opens a `localtunnel` so the local port is reachable from Slack's
 * servers; the tunnel URL is what the user pastes into their Slack app's Event
 * Subscriptions → Request URL. The tunnel is best-effort: the local handler is
 * the security boundary and stays up even if the tunnel can't be established.
 *
 * Runs in the Electron main process. Deliberately free of any `electron`
 * import so it can be unit-/smoke-tested as a plain Node module.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import localtunnel from 'localtunnel';

/** The live tunnel handle returned by localtunnel (has `url` + `close()` + EventEmitter). */
type Tunnel = Awaited<ReturnType<typeof localtunnel>>;

export interface SlackWebhookServerOptions {
  /** Local TCP port the HTTP server binds to (and the tunnel forwards to). */
  port: number;
  /** Slack app signing secret (Basic Information → Signing Secret). Required. */
  signingSecret: string;
  /** Optional channel id filter — when set, events from other channels are dropped. */
  channelId?: string;
  /** Called once per accepted, de-mentioned message body. */
  onMessage: (text: string) => void;
}

/** Reject request bodies larger than this — Slack event payloads are tiny; the
 *  cap stops an unauthenticated peer from forcing unbounded memory use before
 *  we've even checked the signature. */
const MAX_BODY_BYTES = 1024 * 1024; // 1 MB
/** Slack's recommended replay window: reject timestamps more than 5 min off. */
const REPLAY_WINDOW_SECONDS = 60 * 5;
/** Cap how long we wait for the public tunnel before giving up (server stays up). */
const TUNNEL_START_TIMEOUT_MS = 10_000;

export class SlackWebhookServer {
  private server: Server | null = null;
  private tunnel: Tunnel | null = null;
  private readonly port: number;
  private readonly signingSecret: string;
  private readonly channelId?: string;
  private readonly onMessage: (text: string) => void;

  constructor(opts: SlackWebhookServerOptions) {
    this.port = opts.port;
    this.signingSecret = opts.signingSecret;
    this.channelId = opts.channelId?.trim() || undefined;
    this.onMessage = opts.onMessage;
  }

  /**
   * Bind the local HTTP server, then open a public tunnel to it. The HTTP
   * handler (the security boundary) is live the instant `listen` resolves; the
   * tunnel is opened afterwards and is non-fatal — if it can't be established
   * (offline, loca.lt down, timed out) the server keeps running and we report
   * the tunnel error without a URL.
   */
  async start(): Promise<{ ok: boolean; url?: string; error?: string }> {
    if (this.server) return { ok: false, error: 'already running' };
    if (!this.signingSecret) return { ok: false, error: 'missing signing secret' };
    try {
      await this.listen();
    } catch (e) {
      this.stop();
      return { ok: false, error: `failed to bind port ${this.port}: ${errMsg(e)}` };
    }
    try {
      const tunnel = await this.openTunnel();
      this.tunnel = tunnel;
      // A dropped tunnel must not crash the main process; the local server stays up.
      tunnel.on('error', () => { /* tunnel hiccup — ignore, server still listening */ });
      return { ok: true, url: tunnel.url };
    } catch (e) {
      return { ok: true, error: `tunnel unavailable: ${errMsg(e)}` };
    }
  }

  /** Close the tunnel and HTTP server. Idempotent and best-effort. */
  stop(): void {
    try { this.tunnel?.close(); } catch { /* noop */ }
    this.tunnel = null;
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
  }

  private listen(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => this.handleRequest(req, res));
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      // Bind loopback only: the public entry point is the localtunnel tunnel
      // (openTunnel below), so the raw port must never be LAN-reachable.
      server.listen(this.port, '127.0.0.1', () => {
        server.off('error', onError);
        this.server = server;
        resolve();
      });
    });
  }

  private openTunnel(): Promise<Tunnel> {
    return new Promise<Tunnel>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), TUNNEL_START_TIMEOUT_MS);
      Promise.resolve(localtunnel({ port: this.port }))
        .then((t) => { clearTimeout(timer); resolve(t); })
        .catch((e) => { clearTimeout(timer); reject(e); });
    });
  }

  /** Buffer the raw body (needed verbatim for the HMAC) under a size cap, then
   *  verify + dispatch. Only POST is accepted. */
  private handleRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      if (aborted) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413); res.end();
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      this.handleBody(req, res, Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', () => {
      if (aborted) return;
      try { res.writeHead(400); res.end(); } catch { /* socket already gone */ }
    });
  }

  private handleBody(req: IncomingMessage, res: ServerResponse, rawBody: string): void {
    // 1) Authenticate over the RAW body BEFORE parsing. Any failure → 403.
    if (!this.verify(req, rawBody)) { res.writeHead(403); res.end(); return; }

    let payload: SlackPayload;
    try { payload = JSON.parse(rawBody) as SlackPayload; }
    catch { res.writeHead(400); res.end(); return; }

    // 2) URL verification handshake — echo the challenge back.
    if (payload.type === 'url_verification' && typeof payload.challenge === 'string') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ challenge: payload.challenge }));
      return;
    }

    // 3) Real events: only plain user messages (no subtype = not an edit/join/
    //    bot post), optionally filtered to one channel.
    if (payload.type === 'event_callback' && payload.event) {
      const ev = payload.event;
      const isPlainMessage = ev.type === 'message' && !ev.subtype && !ev.bot_id;
      const channelOk = !this.channelId || ev.channel === this.channelId;
      if (isPlainMessage && channelOk) {
        const text = stripLeadingMention(typeof ev.text === 'string' ? ev.text : '');
        if (text) {
          try { this.onMessage(text); } catch { /* delivery is best-effort */ }
        }
      }
    }

    // Always 200 so Slack treats the event as delivered and doesn't retry.
    res.writeHead(200); res.end();
  }

  /**
   * Verify a request is genuinely from Slack: HMAC-SHA256 of `v0:<ts>:<rawBody>`
   * with the signing secret must equal the `X-Slack-Signature` header (compared
   * in constant time), AND the timestamp must be within the replay window.
   */
  private verify(req: IncomingMessage, rawBody: string): boolean {
    const sig = req.headers['x-slack-signature'];
    const ts = req.headers['x-slack-request-timestamp'];
    if (typeof sig !== 'string' || typeof ts !== 'string') return false;

    // Replay guard: reject stale or non-numeric timestamps (> 5 min skew).
    const tsNum = Number(ts);
    if (!Number.isFinite(tsNum)) return false;
    if (Math.abs(Date.now() / 1000 - tsNum) > REPLAY_WINDOW_SECONDS) return false;

    const expected = 'v0=' + createHmac('sha256', this.signingSecret)
      .update(`v0:${ts}:${rawBody}`)
      .digest('hex');
    const provided = Buffer.from(sig);
    const computed = Buffer.from(expected);
    // timingSafeEqual throws on length mismatch — guard, and a differing length
    // is itself a mismatch, so bail before the constant-time compare.
    if (provided.length !== computed.length) return false;
    return timingSafeEqual(provided, computed);
  }
}

/** Minimal shape of the Slack Events API payloads we handle. */
interface SlackPayload {
  type?: string;
  challenge?: string;
  event?: {
    type?: string;
    subtype?: string;
    bot_id?: string;
    channel?: string;
    text?: string;
  };
}

/** Strip a single leading `<@BOTID>` app-mention so "@bot do X" enqueues "do X". */
function stripLeadingMention(text: string): string {
  return text.replace(/^\s*<@[A-Z0-9]+>\s*/i, '').trim();
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
