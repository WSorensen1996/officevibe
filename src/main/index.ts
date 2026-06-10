import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, shell, protocol, session } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome,
  projectFolderName, defaultProjectsDir, deriveProjectName, upsertProject,
  type HarnessConfig, type ScheduledMission, type ProjectRef
} from './config';
import { listDir, readFileText, writeFileText, writeFileBinary, readFileBinary } from './fs';
import {
  getBranch, isRepo, addWorktree, removeWorktree
} from './git';
import { ProjectManager, type AgentMeta, type ProjectMessage, type ProjectTask } from './project';
import { HookServer } from './hooks';
import { MemoryManager } from './memory';
import { KnowledgeManager } from './knowledge';
import { Curator } from './curator';
import { readAgentUsage } from './transcript';
import { SlackWebhookServer } from './slack';
import { startBrowserMcp, type BrowserMcpHandle } from './browserMcp';
import { decryptDef, encryptDef, encryptionAvailable, isValidName, testConnection, type McpServerDef } from './mcp';
import { decryptValue } from './secrets';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// Last-resort safety net: a stray rejection or throw on a callback stack (a timer,
// a child-process or server event, a fire-and-forget promise) would otherwise tear
// down the whole main process and take every running agent with it. Log loudly and
// keep the app alive — a backgrounded curator/memory/Slack hiccup must not be fatal.
// (uncaughtException leaves state possibly inconsistent, but for a local desktop
// harness staying up beats a hard crash dialog; the atomic writes guard the data.)
process.on('unhandledRejection', (reason) => {
  console.error('[process] unhandledRejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[process] uncaughtException:', err);
});

// Dev-runtime isolation: when running unpackaged (npm run dev), redirect userData
// to ~/.config/officevibe-dev so iterating on source can never corrupt the stable
// packaged AppImage's config at ~/.config/officevibe. Must run before app is ready.
if (!app.isPackaged) {
  app.setPath('userData', join(app.getPath('appData'), 'officevibe-dev'));
}

// Register a privileged `app://` scheme so a packaged build can fetch() its own
// bundled assets — Chromium blocks fetch() of file:// URLs, which the in-renderer
// Whisper speech-to-text (transformers.js) needs to load its model + wasm. The
// renderer loads from app://bundle/ in production (dev uses the Vite http URL).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

// [STT-WEBGPU-PROBE] Phase-1 (task 5z52): enable WebGPU so the renderer/worker can
// probe for a GPU adapter — the go/no-go for GPU speech-to-text. Linux+Electron
// WebGPU is gated/flaky, so these switches are required for navigator.gpu to exist.
// Must run BEFORE app ready (module load is). enable-unsafe-webgpu turns the API on
// where Chromium gates it; Vulkan is the WebGPU backend on Linux. REMOVE if no-go.
app.commandLine.appendSwitch('enable-unsafe-webgpu');
if (process.platform === 'linux') {
  // VulkanFromANGLE + DefaultANGLEVulkan route WebGPU through ANGLE's Vulkan backend.
  // With plain 'Vulkan' alone, a transcription on the GPU tier hangs the display
  // compositor's Vulkan swapchain (vkAcquireNextImageKHR hangs → GPU process recycled)
  // on this AMD/RADV stack — the documented workaround for that exact symptom + flag
  // combo (gpuweb/gpuweb#5022). Keep all three together.
  app.commandLine.appendSwitch('enable-features', 'Vulkan,VulkanFromANGLE,DefaultANGLEVulkan');
  // The office floor's continuous WebGL render loop shares one GPU process with the STT
  // WebGPU compute. A heavy transcription can briefly stall the compositor's swapchain
  // present (vkAcquireNextImageKHR hangs); Chromium's GPU watchdog treats that as an
  // unrecoverable hang and recycles the whole GPU process, killing the in-flight
  // transcription AND the scene. We already pause the render loop during transcription
  // (see useDictation + OfficeFloor); disabling the watchdog keeps a brief stall from
  // escalating to a process kill. Linux/Vulkan only, where the contention occurs.
  app.commandLine.appendSwitch('disable-gpu-watchdog');
}

/** Content-Type for a file served over the app:// protocol. */
function mimeForPath(p: string): string {
  switch (extname(p).toLowerCase()) {
    case '.html': return 'text/html';
    case '.js':
    case '.mjs': return 'text/javascript';
    case '.css': return 'text/css';
    case '.json':
    case '.map': return 'application/json';
    case '.wasm': return 'application/wasm';
    case '.svg': return 'image/svg+xml';
    case '.png': return 'image/png';
    case '.jpg':
    case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    case '.woff': return 'font/woff';
    case '.woff2': return 'font/woff2';
    case '.ttf': return 'font/ttf';
    case '.txt': return 'text/plain';
    default: return 'application/octet-stream'; // incl. .onnx model weights
  }
}
const ptyManager = new PtyManager();
/** Live PTY id → its hive agent id, recorded at spawn. The pty:kill handler only
 *  gets the PTY id, so this lets a closed tab archive the right registry agent. */
const ptyToAgent = new Map<string, string>();
/** Hive agent id → its CURRENT live PTY id. Agents respawn under a constant id
 *  (e.g. 'pty-god'); this lets teardown confirm a dying PTY is still the agent's
 *  current one before archiving, so a superseded PTY can't archive a live agent. */
const agentToPty = new Map<string, string>();
// The on-disk project store (was the "hive"). `hive` is kept as the internal
// variable name only; the active project folder is its data root.
const hive = new ProjectManager(
  () => readConfig().activeProjectPath,
  (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } },
  // Register each agent's per-agent browser token → agentId so the shared browser
  // MCP server can resolve an incoming x-agent-token to that agent's view. Called
  // synchronously inside ensureAgent (before the PTY spawns), so the token is known
  // before the agent can fire a browser tool. (`agentTokenToId`, `ensureAgentBrowser`
  // are declared in the embedded-browser section below; this closure only runs at
  // spawn time, well after module init.)
  (agentId, token) => {
    agentTokenToId.set(token, agentId);
    // Eagerly create the god's (Michael's) view on spawn so the pane shows him
    // live on launch — matching the original single-pane experience. ensureAgent
    // sets reg.godId before this fires; ensureAgentBrowser auto-stages it only if
    // nothing else is staged, so a pinned sub-agent isn't stolen on a god respawn.
    try { if (mainWindow && hive.registry().godId === agentId) ensureAgentBrowser(agentId); }
    catch { /* registry/window not ready */ }
  }
);
// Authoritative liveness: an agent is live iff its PTY session (`pty-<id>`) exists.
// Lets the router reroute task dispatches away from dead agents to god — so a task
// can never be assigned/delivered into a non-live agent's inbox (t-mq71a2km-up8s).
hive.setLivenessProbe((agentId) => ptyManager.has(`pty-${agentId}`));
const memory = new MemoryManager(
  () => readConfig().activeProjectPath,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
// Self-improvement ("Project Brain"): the team-shared skill library + the background
// curator. Instantiated before hookServer because the hook injects ranked skills and
// the curator is triggered (debounced) when an agent goes idle.
const knowledge = new KnowledgeManager(() => readConfig().activeProjectPath, () => readConfig());
const curator = new Curator(
  () => readConfig().activeProjectPath,
  () => readConfig(),
  knowledge,
  memory,
  () => hive.usageLimits()
);
const hookServer = new HookServer(
  hive,
  () => liveWebContents(),
  () => readConfig(),
  knowledge,
  (agentId) => curator.onAgentIdle(agentId)
);
let mainWindow: BrowserWindow | null = null;

// ─── Embedded browser pane (per-agent native WebContentsViews) ───────────────
/** Every agent gets its OWN native browser view, created lazily on first
 *  browser-tool use (or when the user clicks its tab). Exactly ONE view is "on
 *  stage" — bound to the single bottom-left pane rect the user watches; the rest
 *  are parked offscreen-but-visible so they keep compositing (a setVisible(false)
 *  view stops painting → blank capturePage). Views paint above the DOM, so the
 *  renderer hides the staged view (browser:setVisible) whenever a modal/fullscreen
 *  overlay is open. */
interface AgentBrowser { view: WebContentsView; lastUsed: number }
const browserViews = new Map<string, AgentBrowser>();
/** The in-process MCP server that lets each agent drive its own view. */
let browserMcp: BrowserMcpHandle | null = null;
/** Last bounds the renderer measured for the pane (CSS px = DIP). */
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
/** Whether the staged view should be shown (false while a DOM overlay is open). */
let browserVisible = true;
/** The agent whose view is currently bound to the on-screen pane rect (null = none). */
let stageAgentId: string | null = null;
/** Per-agent browser token (x-agent-token header) → agentId. Populated by
 *  ProjectManager's onBrowserToken callback (above) before each agent spawns, so
 *  the shared browser MCP server can route a request to the right agent's view. */
const agentTokenToId = new Map<string, string>();
/** Soft cap on concurrently-live browser views; idle ones beyond this are
 *  LRU-evicted to bound RAM/CPU when a web task is fanned out across many agents. */
const MAX_LIVE_BROWSERS = 5;

/** Filesystem/partition-safe slug for an agent id (used in the session partition).
 *  A short hash of the FULL id is appended so two distinct ids can never collide
 *  onto one shared partition via truncation/normalization. */
function slugId(id: string): string {
  const readable = id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 24);
  const hash = createHash('sha256').update(id).digest('hex').slice(0, 16);
  return `${readable}-${hash}`;
}

/** A given agent's live webContents, or null if its view isn't up. */
function wcForAgent(id: string | null): Electron.WebContents | null {
  if (!id) return null;
  const ab = browserViews.get(id);
  return ab && !ab.view.webContents.isDestroyed() ? ab.view.webContents : null;
}

/** The staged (on-screen) agent's live webContents, or null. */
function stagedWc(): Electron.WebContents | null {
  return wcForAgent(stageAgentId);
}

/** Position the STAGED view to the renderer's last-measured rect and park every
 *  other view offscreen-but-visible (real size so it keeps compositing). */
function applyBrowserBounds(): void {
  const b = browserBounds;
  const onStage = {
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height))
  };
  // Parked views need a REAL non-zero size to keep painting; default to a sane
  // size when the pane hasn't been measured yet, and sit fully off the canvas.
  const W = Math.max(onStage.width, 1024);
  const H = Math.max(onStage.height, 768);
  const parked = { x: -(W + 64), y: 0, width: W, height: H };
  for (const [id, ab] of browserViews) {
    if (ab.view.webContents.isDestroyed()) continue;
    ab.view.setBounds(id === stageAgentId ? onStage : parked);
  }
}

/** Push the STAGED view's URL/title/loading state (+ which agent it is) to the
 *  renderer chrome. A background agent's navigation must NOT rewrite the bar, so
 *  callers gate on agentId === stageAgentId. */
function emitBrowserState(): void {
  const wc = stagedWc();
  if (!wc) {
    // Nothing staged (all torn down / none created yet) — clear the chrome.
    try {
      liveWebContents()?.send('browser:state', {
        url: '', title: '', canGoBack: false, canGoForward: false, loading: false, agentId: null
      });
    } catch { /* window tore down */ }
    return;
  }
  const nav = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean } }).navigationHistory;
  try {
    liveWebContents()?.send('browser:state', {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: nav?.canGoBack() ?? false,
      canGoForward: nav?.canGoForward() ?? false,
      loading: wc.isLoading(),
      agentId: stageAgentId
    });
  } catch { /* window tore down */ }
}

/** Push the roster of agents that currently have a browser view (+ which is
 *  staged) so the BrowserPane can render its tab-strip. */
function emitBrowserViews(): void {
  let agents: Record<string, { name?: string; isGod?: boolean }> = {};
  try { agents = hive.registry().agents; } catch { /* no project / not ready */ }
  const views = [...browserViews.keys()].map((id) => ({
    agentId: id,
    name: agents[id]?.name ?? id,
    isGod: !!agents[id]?.isGod
  }));
  try { liveWebContents()?.send('browser:views', { views, stageAgentId }); } catch { /* window tore down */ }
}

/** Make `agentId` the staged (on-screen) agent: swap which view sits at the pane
 *  rect, show it (honoring the overlay guard), park the rest, and refresh chrome. */
function stageAgent(agentId: string | null): void {
  if (stageAgentId === agentId) return;
  // Keep the outgoing view visible (it just becomes parked offscreen by
  // applyBrowserBounds, so it keeps compositing); the incoming one is shown by the
  // visibility line below. Honors the overlay guard via browserVisible.
  const prev = wcForAgent(stageAgentId);
  const prevView = stageAgentId ? browserViews.get(stageAgentId)?.view : null;
  if (prevView && prev && !prev.isDestroyed()) prevView.setVisible(true);
  stageAgentId = agentId;
  applyBrowserBounds();
  const ab = agentId ? browserViews.get(agentId) : null;
  if (ab && !ab.view.webContents.isDestroyed()) {
    ab.view.setVisible(browserVisible);
    ab.lastUsed = Date.now();
  }
  emitBrowserState();
  emitBrowserViews();
}

/** Normalize a user/agent-supplied URL to a safe http(s) URL, or null if it
 *  carries a disallowed scheme (file:, data:, javascript:, ftp:, …). A bare
 *  host (incl. host:port) defaults to https. Used at every navigation entry
 *  into the browser pane so the sandboxed view can't be pointed at local files. */
function toHttpUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(s);
  if (!scheme) return `https://${s}`;
  return /^https?$/i.test(scheme[1]) ? s : null;
}

/** True when `url` belongs to OUR renderer origin — the packaged `app://` bundle
 *  or the dev Vite server (localhost). The main window's preload exposes the full
 *  `window.cth` IPC surface on EVERY page it loads, so the window must never
 *  navigate anywhere else (see the will-navigate guard in createWindow). */
function isOwnAppUrl(url: string): boolean {
  return url.startsWith('app://') ||
    url.startsWith('http://localhost') ||
    url.startsWith('http://127.0.0.1') ||
    url === 'about:blank';
}

/** Open an externally-clicked link in the user's real browser — but only for safe
 *  schemes. `shell.openExternal` on an arbitrary scheme (file:, smb:, a custom
 *  protocol handler, …) is an OS-level footgun, so anything but http/https/mailto
 *  is dropped. */
function openExternalSafe(url: string): void {
  let scheme: string;
  try { scheme = new URL(url).protocol.replace(/:$/, '').toLowerCase(); }
  catch { return; }
  if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') void shell.openExternal(url);
}

/** LRU-evict idle browser views once the soft cap is reached. Never evicts the
 *  staged view or `keepId`; an evicted agent re-creates its view next time it
 *  browses. `lastUsed` is bumped on every browser-tool call + on staging, so a
 *  currently-working agent has a recent timestamp and won't be the victim. */
function evictIdleBrowsers(keepId: string): void {
  while (browserViews.size >= MAX_LIVE_BROWSERS) {
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [id, ab] of browserViews) {
      if (id === stageAgentId || id === keepId) continue;
      if (ab.lastUsed < oldest) { oldest = ab.lastUsed; victim = id; }
    }
    if (!victim) break; // nothing evictable (everything is staged/kept)
    console.log('[browser] LRU-evicting idle view', victim);
    destroyAgentBrowser(victim);
  }
}

/** Create agent `agentId`'s WebContentsView if absent and attach it to the window.
 *  Idempotent; returns null only if there's no window yet. The first view created
 *  auto-stages so the pane is never empty; the rest are parked offscreen. */
function ensureAgentBrowser(agentId: string): WebContentsView | null {
  if (!mainWindow) return null;
  const existing = browserViews.get(agentId);
  if (existing && !existing.view.webContents.isDestroyed()) { existing.lastUsed = Date.now(); return existing.view; }
  evictIdleBrowsers(agentId);
  const view = new WebContentsView({
    webPreferences: {
      // Per-agent isolated, persistent profile — each agent's logins persist across
      // restarts and stay separate from other agents and the user's real Chrome.
      partition: `persist:agent-browser-${slugId(agentId)}`,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  view.setBackgroundColor('#FFF8E7'); // kill the white flash before first paint
  browserViews.set(agentId, { view, lastUsed: Date.now() });
  mainWindow.contentView.addChildView(view);
  if (stageAgentId === null) stageAgentId = agentId; // first view goes on stage
  console.log('[browser] view created for', agentId, '; window children =', mainWindow.contentView.children.length);
  applyBrowserBounds();
  // Staged view honors the overlay guard; parked views stay visible offscreen so
  // they keep compositing (a hidden view stops painting → blank capturePage).
  view.setVisible(agentId === stageAgentId ? browserVisible : true);

  const wc = view.webContents;
  // Keep popups in-pane instead of spawning OS windows (mirrors the main window).
  wc.setWindowOpenHandler(({ url }) => { const t = toHttpUrl(url); if (t) { try { void wc.loadURL(t); } catch { /* noop */ } } return { action: 'deny' }; });
  // Enforce http/https-only on EVERY page/renderer-initiated navigation (defense in
  // depth alongside the normalization at the tool/IPC entry points): a page can't
  // steer the view to file:/data:/etc. (Programmatic loadURL from the tools does NOT
  // emit will-navigate, so legitimate navigations are unaffected.)
  const blockNonHttp = (e: { preventDefault: () => void }, url: string): void => {
    if (!toHttpUrl(url)?.startsWith('http')) { e.preventDefault(); console.warn('[browser] blocked non-http navigation', agentId, url.slice(0, 80)); }
  };
  wc.on('will-navigate', (e, url) => blockNonHttp(e, url));
  wc.on('will-redirect', (e, url) => blockNonHttp(e, url));
  // Only the STAGED agent's navigation updates the on-screen chrome (URL bar etc.).
  const onChange = (): void => { if (agentId === stageAgentId) emitBrowserState(); };
  wc.on('did-navigate', onChange);
  wc.on('did-navigate-in-page', onChange);
  wc.on('page-title-updated', onChange);
  wc.on('did-start-loading', onChange);
  wc.on('did-stop-loading', onChange);
  // ── Diagnostics: surface load failures + render crashes (these explain a blank/black pane).
  wc.on('did-finish-load', () => console.log('[browser]', agentId, 'did-finish-load', wc.getURL()));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.error('[browser] did-fail-load', agentId, { code, desc, url, isMainFrame });
    // -3 = ERR_ABORTED (benign, e.g. a superseded navigation). On a real main-frame
    // failure, show a visible local page so the pane isn't just blank/black.
    if (isMainFrame && code !== -3 && !url.startsWith('data:')) {
      void wc.loadURL(
        'data:text/html,' + encodeURIComponent(
          `<body style="font-family:sans-serif;padding:24px;background:#FFF8E7;color:#1A1320">
           <h2>Browser pane</h2><p>Could not load the start page (${code} ${desc}).</p>
           <p>Type a URL in the bar above to navigate.</p></body>`
        )
      );
    }
  });
  wc.on('render-process-gone', (_e, details) => console.error('[browser] render-process-gone', agentId, JSON.stringify(details)));
  wc.on('unresponsive', () => console.error('[browser] webContents unresponsive', agentId));
  console.log('[browser] loading start page https://www.google.com for', agentId);
  void wc.loadURL('https://www.google.com').catch((e) => console.error('[browser] loadURL threw', e));
  emitBrowserViews();
  if (agentId === stageAgentId) emitBrowserState();
  return view;
}

/** Destroy ONE agent's browser view, and if it was staged, re-stage the
 *  most-recently-used remaining view (or clear the pane). `freeToken` controls
 *  whether the agent's browser token is also revoked: TRUE only on real teardown
 *  (the agent is gone/archived); FALSE on LRU eviction, where the agent is still
 *  alive and must be able to lazily re-create its view on its next browser call —
 *  revoking its token there would 401 a live agent forever. */
function destroyAgentBrowser(agentId: string, freeToken = false): void {
  const ab = browserViews.get(agentId);
  if (!ab) return;
  browserViews.delete(agentId);
  try {
    if (mainWindow && !ab.view.webContents.isDestroyed()) mainWindow.contentView.removeChildView(ab.view);
  } catch (e) { console.error('[browser] removeChildView:', e); }
  try { if (!ab.view.webContents.isDestroyed()) ab.view.webContents.close(); } catch { /* noop */ }
  // Only revoke the token when the agent is truly gone — see freeToken doc above.
  if (freeToken) for (const [tok, id] of agentTokenToId) if (id === agentId) agentTokenToId.delete(tok);
  if (stageAgentId === agentId) {
    let next: string | null = null;
    let newest = -Infinity;
    for (const [id, b] of browserViews) { if (b.lastUsed > newest) { newest = b.lastUsed; next = id; } }
    stageAgentId = null;
    if (next) stageAgent(next);
    else { applyBrowserBounds(); emitBrowserState(); emitBrowserViews(); }
  } else {
    emitBrowserViews();
  }
}

/** Guards the capture-on-demand fallback so at most one runs at a time — two
 *  overlapping fallbacks would each snapshot the other's transient stage and
 *  restore in the wrong order. */
let capturingOnStage = false;

/** Capture a PNG (base64) of an agent's page, even if its view is parked
 *  offscreen. A parked/zero-intersection view can have a throttled compositor
 *  that returns a blank image, so on an empty capture we briefly stage it to
 *  force a paint, capture, then restore the previous stage (a brief on-screen
 *  flicker, only on the fallback path). Returns '' on failure. */
async function captureAgentPage(agentId: string): Promise<string> {
  const wc = wcForAgent(agentId);
  if (!wc) return '';
  const grab = async (): Promise<string> => {
    try { const img = await wc.capturePage(); return img.toPNG().toString('base64'); }
    catch { return ''; }
  };
  const data = await grab();
  if (data || agentId === stageAgentId) return data; // staged views always paint
  // Fallback: bring it on stage briefly to force a paint, then restore. Serialized
  // (one at a time) — if another capture is mid-flight, just return what we have.
  if (capturingOnStage) return data;
  capturingOnStage = true;
  const prevStage = stageAgentId;
  try {
    stageAgent(agentId);
    await new Promise((r) => setTimeout(r, 250));
    const retry = await grab();
    // Restore ONLY if nothing else re-staged during our window (e.g. a user tab
    // click or another agent's auto-follow). Restoring blindly would clobber that
    // legitimate change. Restore to prevStage only if it still has a live view;
    // otherwise leave the just-captured view staged (avoids an empty pane).
    if (stageAgentId === agentId && prevStage && wcForAgent(prevStage)) stageAgent(prevStage);
    return retry || data;
  } finally {
    capturingOnStage = false;
  }
}

/** Best-effort destroy of ALL browser views + the MCP server (used on quit/reset). */
function teardownBrowser(): void {
  try { browserMcp?.stop(); } catch (e) { console.error('[browser] mcp stop:', e); }
  browserMcp = null;
  for (const [, ab] of browserViews) {
    try {
      if (mainWindow && !ab.view.webContents.isDestroyed()) mainWindow.contentView.removeChildView(ab.view);
    } catch (e) { console.error('[browser] removeChildView:', e); }
    try { if (!ab.view.webContents.isDestroyed()) ab.view.webContents.close(); } catch { /* noop */ }
  }
  browserViews.clear();
  agentTokenToId.clear();
  stageAgentId = null;
}

/** When true, skip the quit interceptor (user already confirmed). */
let allowQuit = false;

/** Agents spawned with `isolate: true` get a dedicated git worktree; this maps
 *  the agent/pty id → the worktree path so we can tear it down on kill. */
const worktreePaths = new Map<string, string>();
/** id → the original repo cwd the worktree was created from (needed to run
 *  `git worktree remove` from the parent tree, not the worktree itself). */
const worktreeOrigins = new Map<string, string>();

/**
 * Tear down everything tied to a PTY id: archive its hive agent, remove its
 * isolated git worktree, and drop the bookkeeping-map entries. Runs on BOTH an
 * explicit `pty:kill` AND a natural PTY exit (the child finished, crashed, or
 * was killed externally) — without this the agent stays "active" (broadcasts
 * keep mailing a dead inbox), the worktree orphans (plus a dangling `git
 * worktree` registration in the user's real repo), and the maps leak an entry
 * per dead PTY.
 *
 * Idempotent: guarded on map presence and the already-idempotent
 * `hive.setArchived`, so the second call (kill() also makes node-pty fire
 * onExit) is a harmless no-op. Best-effort — every step is wrapped so a teardown
 * error can never crash the caller (an IPC handler or node-pty's onExit).
 */
function teardownPty(id: string): void {
  // 1) Archive the agent — retained + flagged; only live-PTY agents are active.
  //    But only if this PTY is still the agent's CURRENT one: a superseded PTY
  //    (the agent already respawned under the same id) must NOT archive the live
  //    replacement. The primary guard is in PtyManager.onExit, which stops a stale
  //    exit reaching here at all; this is a second line of defense.
  const agentId = ptyToAgent.get(id);
  if (agentId) {
    ptyToAgent.delete(id);
    // Release any permission prompts this agent was blocked on — its PTY is gone,
    // so no one can answer them; deny + clear so the card doesn't linger.
    try { hookServer.rejectForAgent(agentId); } catch (e) { console.error('[hooks] rejectForAgent failed:', e); }
    if (agentToPty.get(agentId) === id) {
      agentToPty.delete(agentId);
      if (hive.enabled()) {
        try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
      }
      // Tear down this agent's browser view AND revoke its token (the agent is
      // archived — gone — so it shouldn't keep a renderer process alive, leave a
      // tab in the strip, or retain a usable browser token).
      try { destroyAgentBrowser(agentId, true); } catch (e) { console.error('[browser] destroyAgentBrowser failed:', e); }
    }
  }
  // 2) Remove the isolated worktree, if any. Non-blocking; errors are logged.
  const wtPath = worktreePaths.get(id);
  if (wtPath) {
    const origCwd = worktreeOrigins.get(id) ?? wtPath;
    worktreePaths.delete(id);
    worktreeOrigins.delete(id);
    void removeWorktree(origCwd, wtPath)
      .then(r => { if (!r.ok) console.error('[worktree] removeWorktree failed:', r.error); })
      .catch(e => console.error('[worktree] removeWorktree threw:', e));
  }
}
// A natural PTY exit must run the same teardown as an explicit kill.
ptyManager.setExitHandler(teardownPty);

/** A mission's live scheduler handles: the initial `setTimeout` that waits out
 *  the time remaining until its next due fire, and the steady `setInterval`
 *  armed once it has fired. Both are tracked so shutdown can clear whichever is
 *  pending. */
interface MissionTimer {
  timeout?: NodeJS.Timeout;
  interval?: NodeJS.Timeout;
}

/** Active scheduler timers keyed by mission id. */
const missionTimers = new Map<string, MissionTimer>();

/** Clear and forget every armed mission timer (both the setTimeout and the
 *  setInterval handle). Safe to call from syncMissions and from shutdown
 *  teardown so a tick never fires into half-torn-down services. */
function clearMissionTimers(): void {
  for (const t of missionTimers.values()) {
    if (t.timeout) clearTimeout(t.timeout);
    if (t.interval) clearInterval(t.interval);
  }
  missionTimers.clear();
}

/** Stamp a single mission in persisted config via read-modify-write-by-id so a
 *  concurrent stamp to a sibling mission is never clobbered. */
function patchMission(id: string, patch: Partial<ScheduledMission>): void {
  const current = readConfig().missions ?? [];
  const next = current.map((x) => (x.id === id ? { ...x, ...patch } : x));
  writeConfig({ missions: next });
}

/** Send a mission's dispatch. For a task-linked mission the live task is re-read
 *  so the dispatched title/description/assignee are never stale, and the body
 *  carries the `[task:id]` marker so the worker posts status updates back onto
 *  the card (byte-identical to the renderer's dispatchTask). Returns `skipped`
 *  when a task-linked mission's task no longer exists (caller self-heals). Also
 *  pings the renderer so an idle assignee gets woken even with auto-pilot off. */
function dispatchMissionMessage(m: ScheduledMission): { skipped: boolean } {
  let to = m.to;
  let subject = m.label;
  let body = m.body;
  if (m.taskId) {
    const data = hive.tasks() as { tasks?: ProjectTask[] };
    const task = (data.tasks ?? []).find((t) => t.id === m.taskId);
    if (!task) return { skipped: true };
    const desc = task.description?.trim() ? task.description.trim() : '(no description)';
    // Mirror the renderer's dispatchBody: append the reference (source context kept
    // out of the visible description) as a labeled block so a SCHEDULED dispatch
    // still hands the agent the same context as a manual one.
    const ref = task.reference?.trim() ? `\nReference (source context):\n${task.reference.trim()}` : '';
    to = task.assignee ?? 'god';
    subject = 'Task from you';
    body = `Task: ${task.title} [task:${task.id}]\nContext: ${desc}${ref}\n`;
  }
  if (hive.enabled()) {
    hive.send({ to, act: 'request', subject, body }, 'scheduler');
  }
  // Wake the renderer's nudge loop so an idle assignee drains its inbox even
  // when auto-pilot is off (the scheduler runs in main and can't flip the
  // renderer's transient floorStarted flag itself).
  try { liveWebContents()?.send('scheduler:fired'); } catch { /* window tore down */ }
  return { skipped: false };
}

/** Rebuild the scheduler from persisted config: clear every existing timer,
 *  then arm each enabled mission. Recurring missions honor lastFiredAt — a
 *  setTimeout for the time remaining until the next due fire, which settles into
 *  a steady interval. One-time missions (mode 'once') arm a single setTimeout to
 *  runAt then disable themselves. Called on boot (after the router starts) and
 *  after every missions:save. */
function syncMissions(): void {
  clearMissionTimers();
  const missions = readConfig().missions ?? [];
  for (const m of missions) {
    if (!m.enabled) continue;

    // One-time: fire once at runAt, then disable. lastFiredAt is the durable
    // double-fire guard (survives reboot); a past-due runAt clamps to 0 so it
    // fires ~immediately on boot.
    if (m.mode === 'once') {
      if (typeof m.runAt !== 'number' || m.lastFiredAt) continue;
      const fireOnce = (): void => {
        try {
          dispatchMissionMessage(m);
        } catch (e) {
          console.error('[scheduler] mission', m.id, e);
        } finally {
          // Always disable, even if the task was deleted, so it self-clears.
          patchMission(m.id, { lastFiredAt: Date.now(), enabled: false });
        }
      };
      const entry: MissionTimer = {};
      entry.timeout = setTimeout(fireOnce, Math.max(0, m.runAt - Date.now()));
      missionTimers.set(m.id, entry);
      continue;
    }

    // Recurring.
    if (!(m.intervalMs > 0)) continue;
    const entry: MissionTimer = {};
    let stopped = false;
    const fire = (): void => {
      try {
        const res = dispatchMissionMessage(m);
        if (res.skipped) {
          // Task-linked mission whose task was deleted out-of-band: disable it
          // and stop its live interval so it doesn't keep skip-firing forever.
          stopped = true;
          patchMission(m.id, { enabled: false });
          if (entry.interval) { clearInterval(entry.interval); entry.interval = undefined; }
        } else {
          patchMission(m.id, { lastFiredAt: Date.now() });
        }
      } catch (e) {
        console.error('[scheduler] mission', m.id, e);
      }
    };
    // Honor lastFiredAt so a partially-elapsed interval is not restarted from
    // zero on reboot or when an unrelated mission is edited: wait only the time
    // remaining until the next due fire, then settle into a steady interval.
    const remaining = Math.max(0, m.intervalMs - (Date.now() - (m.lastFiredAt ?? 0)));
    entry.timeout = setTimeout(() => {
      fire();
      if (!stopped) entry.interval = setInterval(fire, m.intervalMs);
    }, remaining);
    missionTimers.set(m.id, entry);
  }
}

/** The live renderer webContents, or null if the window is gone/destroyed.
 *  Anything that emits to the renderer from a timer/socket/child callback must
 *  route through here — during quit the window can be destroyed while those
 *  callbacks are still in flight, and `.send()` on a destroyed webContents
 *  throws "Object has been destroyed" (the main-process crash dialog). */
function liveWebContents(): Electron.WebContents | null {
  const wc = mainWindow?.webContents;
  return wc && !wc.isDestroyed() ? wc : null;
}

// ─── Slack webhook server (Slack message → Michael's queue) ──────────────────
/** The running Slack ingestion server, or null when disabled/stopped. */
let slackServer: SlackWebhookServer | null = null;

/** Build a SlackWebhookServer from the current config and start it, replacing
 *  any running instance, and return the start result (incl. the public tunnel
 *  URL the user pastes into Slack). No-op + error result when the integration is
 *  disabled or the signing secret is unset. */
async function startSlackServer(): Promise<{ ok: boolean; url?: string; error?: string }> {
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) {
    return { ok: false, error: 'slack disabled or missing signing secret' };
  }
  const signingSecret = decryptValue(cfg.slackSigningSecret);
  if (!signingSecret) return { ok: false, error: 'signing secret could not be decrypted' };
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret,
    channelId: cfg.slackChannelId,
    // Fires from the HTTP server's event loop (not the IPC thread); route through
    // liveWebContents() so a message arriving during window teardown can't throw.
    onMessage: (text) => {
      try { liveWebContents()?.send('slack:incomingMessage', { text }); }
      catch { /* window torn down */ }
    }
  });
  const res = await slackServer.start();
  // ok:false means we never bound the port → drop the instance. ok:true with no
  // url just means the tunnel is unavailable; the local handler is still live.
  if (!res.ok) slackServer = null;
  return res;
}

/** Stop and forget the Slack server. Best-effort; safe to call when not running. */
function stopSlackServer(): void {
  try { slackServer?.stop(); } catch (e) { console.error('[slack] stop failed:', e); }
  slackServer = null;
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 800,
    title: 'OfficeVibe',
    backgroundColor: '#FFF8E7',
    titleBarStyle: 'hiddenInset',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Sandboxed: the preload only uses contextBridge + ipcRenderer (no Node
      // built-ins), so the OS sandbox is safe to keep on for defense in depth.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  // window.open / target=_blank → open in the system browser (safe schemes only),
  // never as an in-app window that would inherit our preload.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // Pin the privileged main window to our own origin. A top-level navigation away
  // (e.g. clicking an http(s) link rendered in untrusted agent/task/Slack markdown)
  // would load the destination INTO this webContents, handing it the full
  // window.cth IPC surface (spawnPty, writeFile, …). Block it and send external
  // links to the system browser instead — mirrors the browser pane's guard.
  const guardNavigation = (e: { preventDefault: () => void }, url: string): void => {
    if (isOwnAppUrl(url)) return;
    e.preventDefault();
    openExternalSafe(url);
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);

  // On macOS, the red-X "close" event by default destroys the window — and on
  // a single-window app, that effectively quits. Intercept it the same way we
  // intercept before-quit so PTY users get the warning.
  win.on('close', (e) => {
    if (allowQuit) return;
    const count = ptyManager.list().length;
    if (count === 0) return;
    e.preventDefault();
    win.focus();
    win.webContents.send('app:closeRequested', { ptyCount: count });
  });

  ptyManager.attachWebContents(win.webContents);

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
    // Open DevTools in dev so the renderer/worker console (incl. [stt] logs) is visible.
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    // Served by the app:// protocol handler (see whenReady) so the renderer can
    // fetch() its bundled STT model + wasm — file:// can't be fetched in Chromium.
    win.loadURL('app://bundle/index.html');
  }

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
    // The browser views were children of this window's contentView, so they died
    // with it. Drop the now-dangling map entries + stage so a reopen (macOS
    // 'activate') rebuilds a clean tab-strip and re-creates views lazily. Keep the
    // MCP server + per-agent tokens — the agents themselves are still alive.
    browserViews.clear();
    stageAgentId = null;
  });
}

// ─── IPC: pty lifecycle ─────────────────────────────────────────────────────
ipcMain.handle('pty:spawn', async (_evt, opts: SpawnOptions & { hive?: AgentMeta; isolate?: boolean }) => {
  if (!opts || typeof opts.id !== 'string' || typeof opts.cwd !== 'string' || typeof opts.command !== 'string') {
    return { ok: false, error: 'invalid SpawnOptions' };
  }
  // Git isolation: when requested and the cwd is a real repo, give this agent
  // its own worktree on an `agent/<id>` branch so it can't clobber other agents'
  // (or the user's) working tree. Best-effort — a failure falls back to the
  // shared cwd rather than blocking the spawn.
  if (opts.isolate === true && await isRepo(opts.cwd)) {
    try {
      const origCwd = opts.cwd;
      const wtRoot = join(readConfig().activeProjectPath ?? origCwd, 'worktrees');
      // The id is renderer-supplied (validated only as a string). Slugify it so a
      // crafted id can't inject path separators, then assert the resolved path
      // stays under the worktrees root (defends against bare '..' that slugify
      // leaves intact). If it would escape, bail isolation → fall back to cwd.
      const seg = (opts.hive?.id ?? opts.id).replace(/[^A-Za-z0-9._-]/g, '-');
      const wtPath = join(wtRoot, seg);
      if (!resolve(wtPath).startsWith(resolve(wtRoot) + sep)) {
        console.error('[worktree] refusing unsafe worktree path for id:', opts.hive?.id ?? opts.id);
      } else {
        const br = await getBranch(origCwd);
        const baseBranch = 'current' in br && br.current ? br.current : 'main';
        const wt = await addWorktree(origCwd, wtPath, baseBranch);
        if (wt.ok) {
          opts.cwd = wtPath;
          worktreePaths.set(opts.id, wtPath);
          worktreeOrigins.set(opts.id, origCwd);
        } else {
          console.error('[worktree] addWorktree failed:', wt.error);
        }
      }
    } catch (e) {
      console.error('[worktree] isolation failed:', e);
    }
  }
  // If the agent carries hive metadata, provision its workspace and inject the
  // identity + protocol (extra --append-system-prompt args + AGENT_* env).
  if (opts.hive && hive.enabled()) {
    try {
      const inj = hive.ensureAgent({ ...opts.hive, cwd: opts.cwd }, { semanticMemory: memory.active(), knowledge: knowledge.enabled() });
      opts.args = [...(opts.args ?? []), ...inj.args];
      // Point the agent's mempalace CLI at the shared palace (no-op if inactive).
      opts.env = { ...(opts.env ?? {}), ...inj.env, ...memory.env() };
    } catch (e) {
      // Project provisioning is best-effort; never block a spawn on it.
      console.error('[project] ensureAgent failed:', e);
    }
  }
  // Remember which agent owns this PTY so closing the tab can archive it, and
  // record this PTY as the agent's CURRENT one (a respawn overwrites the prior
  // mapping so a late teardown of the old PTY can't archive the live agent). A
  // live terminal means active — ensureAgent above already cleared `archived`.
  if (opts.hive?.id) {
    ptyToAgent.set(opts.id, opts.hive.id);
    agentToPty.set(opts.hive.id, opts.id);
  }
  return ptyManager.spawn(opts);
});
ipcMain.handle('pty:write', (_evt, id: string, data: string) => {
  if (typeof id !== 'string' || typeof data !== 'string') return { ok: false, error: 'invalid args' };
  return ptyManager.write(id, data);
});
ipcMain.handle('pty:resize', (_evt, id: string, cols: number, rows: number) => {
  if (typeof id !== 'string' || typeof cols !== 'number' || typeof rows !== 'number') return { ok: false, error: 'invalid args' };
  return ptyManager.resize(id, cols, rows);
});
ipcMain.handle('pty:kill', (_evt, id: string) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  // Kill the process, then run the shared lifecycle teardown (archive the agent,
  // remove its isolated worktree, drop the maps). teardownPty is idempotent, so
  // node-pty firing onExit once the child actually dies is a harmless no-op.
  const res = ptyManager.kill(id);
  teardownPty(id);
  return res;
});
ipcMain.handle('pty:list', () => ptyManager.list());

// ─── IPC: permission gate (renderer answers a PreToolUse approval card) ──────
// The renderer resolves a pending PreToolUse hook held open by HookServer; main
// writes the allow/deny decision back to the (blocked) agent's hook socket.
ipcMain.handle('permission:respond', (_evt, payload: { requestId?: unknown; decision?: unknown; reason?: unknown }) => {
  const requestId = typeof payload?.requestId === 'string' ? payload.requestId : '';
  const decision = payload?.decision === 'allow' || payload?.decision === 'deny' ? payload.decision : null;
  if (!requestId || !decision) return { ok: false, error: 'invalid args' };
  const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
  hookServer.respond(requestId, decision, reason);
  return { ok: true };
});

// ─── IPC: clipboard ─────────────────────────────────────────────────────────
ipcMain.handle('app:copyToClipboard', (_evt, text: unknown) => {
  if (typeof text !== 'string') return { ok: false, error: 'invalid text' };
  try { clipboard.writeText(text); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});

// ─── IPC: folder picker ─────────────────────────────────────────────────────
ipcMain.handle('dialog:chooseFolder', async (evt) => {
  const win = BrowserWindow.fromWebContents(evt.sender);
  if (!win) return { ok: false as const, error: 'no window' };
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Pick a folder'
  });
  if (res.canceled || res.filePaths.length === 0) return { ok: false as const, error: 'cancelled' };
  return { ok: true as const, path: res.filePaths[0] };
});

// ─── IPC: Terminal.app at a folder ──────────────────────────────────────────
ipcMain.handle('terminal:openAtFolder', async (_evt, cwd: unknown) => {
  if (typeof cwd !== 'string' || cwd.length === 0) return { ok: false, error: 'invalid cwd' };
  return new Promise<{ ok: boolean; error?: string }>((resolve) => {
    const p = spawn('open', ['-a', 'Terminal', cwd]);
    let err = '';
    p.stderr.on('data', (d) => { err += d.toString(); });
    p.on('error', (e) => resolve({ ok: false, error: e.message }));
    p.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else resolve({ ok: false, error: err.trim() || `open exited ${code}` });
    });
  });
});

// ─── IPC: config ────────────────────────────────────────────────────────────
/** Every key the renderer is allowed to patch — anything else is dropped so a
 *  compromised renderer can't smuggle in unexpected fields. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'onboardingComplete', 'harnessHome', 'activeProjectPath', 'projects', 'registeredRepos',
  'autoMode', 'autoPilot', 'remoteControl', 'defaultCommand', 'defaultModel', 'defaultEffort',
  'semanticMemory', 'embeddingModel', 'skillLearning', 'curatorIntervalMinutes',
  'skillStaleAfterDays', 'skillArchiveAfterDays', 'maxInjectedSkills', 'skillInventoryTokenBudget',
  'curatorBackupKeep', 'curatorUsageCeilingPercent', 'sttModel', 'autoApprove', 'missions',
  'notifications', 'slackEnabled', 'slackChannelId', 'slackPort', 'mcpServers'
  // NB: slackSigningSecret is intentionally NOT here — it is set only via the
  // dedicated slack:setConfig handler (which seals it), never the generic update.
]);
/** Shell-significant characters that have no place in a bare command name. */
const SHELL_META = /[;&|`$(){}<>\n\r]/;
/** Drop unknown keys and reject a `defaultCommand` carrying shell metacharacters
 *  (defense in depth on top of the safe command resolution in pty.ts/shellEnv.ts:
 *  defaultCommand flows into agent spawning AND the headless curator). */
function sanitizeConfigPatch(patch: unknown): Partial<HarnessConfig> {
  if (!patch || typeof patch !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!CONFIG_KEYS.has(k)) continue;
    if (k === 'defaultCommand' && (typeof v !== 'string' || SHELL_META.test(v))) continue;
    out[k] = v;
  }
  return out as Partial<HarnessConfig>;
}
/** What the renderer is allowed to see: the full config minus the Slack signing
 *  secret, which is replaced by a `slackSecretSet` boolean. The secret (encrypted
 *  at rest) never crosses the IPC boundary — the README's "never sent to the
 *  renderer" guarantee depends on every config-returning handler going through this. */
type RedactedConfig = Omit<HarnessConfig, 'slackSigningSecret'> & { slackSecretSet: boolean };
function redactConfig(cfg: HarnessConfig): RedactedConfig {
  const { slackSigningSecret, ...rest } = cfg;
  return { ...rest, slackSecretSet: !!slackSigningSecret };
}
ipcMain.handle('config:get', (): RedactedConfig => redactConfig(readConfig()));
ipcMain.handle('config:update', (_evt, patch: unknown) => redactConfig(writeConfig(sanitizeConfigPatch(patch))));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
/** safeJoin in fs.ts confines the REL path within a root but never validates the
 *  root itself — without this gate a renderer could pass root='/' and read/write
 *  anywhere the process can. Confine `root` to a place the renderer legitimately
 *  knows about: the active project, any known project, or a registered repo (or a
 *  descendant of one). Returns the resolved root, or null when not allowed. */
function allowedFsRoot(root: string): string | null {
  const abs = resolve(root);
  const cfg = readConfig();
  const bases = [
    cfg.activeProjectPath,
    ...(cfg.projects ?? []).map((p) => p.path),
    ...(cfg.registeredRepos ?? [])
  ].filter((r): r is string => typeof r === 'string' && r.length > 0).map((r) => resolve(r));
  for (const base of bases) {
    if (abs === base || abs.startsWith(base + sep)) return abs;
  }
  return null;
}
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  const base = allowedFsRoot(root);
  if (!base) return { ok: false, error: 'root not allowed' };
  return listDir(base, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  const base = allowedFsRoot(root);
  if (!base) return { ok: false, error: 'root not allowed' };
  return readFileText(base, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  const base = allowedFsRoot(root);
  if (!base) return { ok: false, error: 'root not allowed' };
  return writeFileText(base, rel, content);
});

// ─── IPC: task attachments (binary, under <projectRoot>/attachments/<taskId>) ─
// The main process owns the project root (renderer never sees it) and sanitizes
// the task id + filename before they hit the sandboxed safeJoin in fs.ts.
ipcMain.handle('attachment:write', (_evt, taskId: unknown, fileName: unknown, base64: unknown) => {
  if (typeof taskId !== 'string' || typeof fileName !== 'string' || typeof base64 !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  const root = readConfig().activeProjectPath;
  if (!root) return { ok: false, error: 'no active project' };
  const safeTask = taskId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'task';
  const safeName = fileName.replace(/[^a-zA-Z0-9._ -]/g, '_').replace(/^\.+/, '').slice(0, 120) || 'file';
  const rel = `attachments/${safeTask}/${safeName}`;
  return writeFileBinary(root, rel, base64).then((res) => (res.ok ? { ok: true, rel, name: safeName } : res));
});
ipcMain.handle('attachment:read', (_evt, rel: unknown) => {
  if (typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  const root = readConfig().activeProjectPath;
  if (!root) return { ok: false, error: 'no active project' };
  return readFileBinary(root, rel);
});

// ─── IPC: project store (multi-agent coordination) ──────────────────────────
ipcMain.handle('project:board', () => hive.board());
ipcMain.handle('project:tasks', () => hive.tasks());
ipcMain.handle('project:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('project:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('project:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
ipcMain.handle('project:says', (_evt, id: unknown, n: unknown) =>
  (typeof id === 'string' ? hive.saysTail(id, typeof n === 'number' ? n : 200) : []));
ipcMain.handle('project:send', (_evt, partial: Partial<ProjectMessage>, from: unknown) => {
  if (!hive.enabled()) return { ok: false, error: 'no active project' };
  const { message, delivered } = hive.send(partial ?? {}, typeof from === 'string' ? from : 'system');
  return { ok: true, message, delivered };
});
ipcMain.handle('project:writeTasks', (_evt, tasks: unknown) => {
  if (!Array.isArray(tasks)) return { ok: false, error: 'invalid tasks' };
  if (!hive.enabled()) return { ok: false, error: 'no active project' };
  hive.writeTasks(tasks as ProjectTask[]);
  return { ok: true };
});

// ─── IPC: project management (open / create / switch) ───────────────────────
/** Start every service bound to the active project. No-op when no project is open.
 *  Each service guards its own double-start, so this is safe to call after
 *  teardownServices() to re-bootstrap in place — and it's the single boot path used
 *  at startup (whenReady) too. */
function bootstrapActiveProject(): void {
  if (!hive.enabled()) return;
  hive.ensureProject();
  hive.startRouter();
  syncMissions(); // arm recurring auto-dispatch missions now the router is live
  hookServer.start();
  memory.start(); // init per-project palace + mine loop (no-op without mempalace)
  knowledge.ensureScaffold(); // seed the skill library dirs (no-op when disabled)
  curator.start(); // background promote/lifecycle/consolidate loop (no-op when disabled)
}

/** Switch the active project IN-PROCESS: rewrite config, tear down the old project's
 *  services + PTYs, re-bootstrap against the new project (every manager reads
 *  activeProjectPath live, see the getter closures at construction), then reload the
 *  renderer so its store + hive bootstrap re-run. Replaces the old relaunch flow,
 *  which blanked the window in dev — app.exit() makes electron-vite tear down the
 *  Vite dev server that the renderer loads from, so the relaunched window pointed at
 *  a dead URL. In-process reload works in both dev (Vite stays up) and prod (app://). */
function switchToProject(activeProjectPath: string, ref: ProjectRef): void {
  const projects = upsertProject(readConfig().projects ?? [], ref);
  writeConfig({ activeProjectPath, projects });
  teardownServices('switch');
  // Defer one tick so server.close() (hook pipe, slack) fully releases before
  // bootstrap re-binds; bootstrap still completes long before the renderer's ~1.2s
  // god spawn (useProject effect #1).
  setImmediate(() => {
    bootstrapActiveProject();
    const wc = liveWebContents();
    if (wc) { try { wc.reload(); } catch { /* window torn down */ } }
  });
}

/** True only for a path that exists AND is a directory — guards the project
 *  handlers from adopting a file (which later ENOTDIRs and bricks boot) or
 *  creating project folders at an arbitrary, non-existent location. */
function isExistingDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

/** Create a new project folder `officevibe-<slug>` under `parentDir`, write its
 *  manifest, make it active, and relaunch (ensureProject builds the skeleton). */
ipcMain.handle('project:create', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { name?: unknown; parentDir?: unknown };
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) return { ok: false, error: 'project name required' };
  const cfg = readConfig();
  const parentDir = typeof p.parentDir === 'string' && p.parentDir ? p.parentDir : defaultProjectsDir(cfg);
  if (!isExistingDir(parentDir)) return { ok: false, error: 'parent folder does not exist' };
  const path = join(parentDir, projectFolderName(name));
  if (existsSync(join(path, 'officevibe.json')) || existsSync(join(path, 'registry.json'))) {
    return { ok: false, error: 'a project already exists at ' + path };
  }
  try {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'officevibe.json'),
      JSON.stringify({ name, createdAt: new Date().toISOString(), version: 1 }, null, 2), 'utf8');
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  switchToProject(path, { name, path });
  return { ok: true, path };
});

/** Open an existing folder as the active project. Adopts any folder (ensureProject
 *  populates an empty one); a folder with a manifest/registry is recognised as one. */
ipcMain.handle('project:open', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path) return { ok: false, error: 'invalid path' };
  if (!isExistingDir(path)) return { ok: false, error: 'folder does not exist' };
  switchToProject(path, { name: deriveProjectName(path), path });
  return { ok: true, path };
});

/** Switch to an already-known project by path. */
ipcMain.handle('project:switch', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path) return { ok: false, error: 'invalid path' };
  if (!isExistingDir(path)) return { ok: false, error: 'project folder no longer exists' };
  switchToProject(path, { name: deriveProjectName(path), path });
  return { ok: true, path };
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
ipcMain.handle('project:memoryStatus', () => { memory.resetBinCache(); memory.start(); return memory.status(); });
ipcMain.handle('project:searchMemory', (_evt, query: unknown, wing: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, output: '', error: 'empty query' };
  return memory.search(query, { wing: typeof wing === 'string' ? wing : undefined });
});
ipcMain.handle('project:memoryWakeUp', (_evt, wing: unknown) =>
  memory.wakeUp(typeof wing === 'string' ? wing : undefined));
ipcMain.handle('project:mineNow', () => { memory.mineNow(); return { ok: true }; });

/** Best-effort teardown of every service bound to the active project. Each step
 *  is guarded so a throw (dying child, half-torn-down socket) can never abort a
 *  quit/reset/project-switch or pop a crash dialog. Shared by quit, reset, and
 *  the project-switch relaunch. */
function teardownServices(tag: string): void {
  try { clearMissionTimers(); } catch (e) { console.error(`[${tag}] clearMissionTimers:`, e); }
  try { hive.stopRouter(); } catch (e) { console.error(`[${tag}] stopRouter:`, e); }
  try { hookServer.stop(); } catch (e) { console.error(`[${tag}] hookServer.stop:`, e); }
  try { stopSlackServer(); } catch (e) { console.error(`[${tag}] slack.stop:`, e); }
  try { memory.stop(); } catch (e) { console.error(`[${tag}] memory.stop:`, e); }
  try { curator.stop(); } catch (e) { console.error(`[${tag}] curator.stop:`, e); }
  try { teardownBrowser(); } catch (e) { console.error(`[${tag}] teardownBrowser:`, e); }
  try { ptyManager.killAll(); } catch (e) { console.error(`[${tag}] killAll:`, e); }
}

// ─── IPC: quit confirmation ─────────────────────────────────────────────────
ipcMain.handle('app:confirmClose', () => {
  allowQuit = true;
  teardownServices('quit');
  app.quit();
});
ipcMain.handle('app:cancelClose', () => {
  // no-op — modal will close on the renderer side
});

// ─── IPC: full reset (wipe data + config, relaunch into onboarding) ──────────
ipcMain.handle('app:resetAll', () => {
  // Tear everything down first so nothing writes back into the dirs we wipe.
  teardownServices('reset');
  // Erase the active project (Michael's + every agent's memory, inboxes, tasks,
  // board, git history) and its semantic-memory palace. Only these harness-created
  // dirs are removed — never the parent folder or any other project.
  for (const dir of [hive.root(), memory.palacePath()]) {
    if (!dir) continue;
    try { rmSync(dir, { recursive: true, force: true }); }
    catch (e) { console.error('[reset] rm', dir, e); }
  }
  // Back to first-run defaults, then reload the renderer in place so it lands on
  // onboarding. No relaunch — app.exit() blanks the window in dev (it kills the Vite
  // dev server the renderer loads from). With no active project after the reset, the
  // in-memory services stay torn down until onboarding opens a project.
  resetConfig();
  const wc = liveWebContents();
  if (wc) { try { wc.reload(); } catch { /* window torn down */ } }
});

// ─── IPC: token telemetry (real usage + est. cost from CC transcripts) ───────
ipcMain.handle('project:agentUsage', (_evt, cwd: unknown) =>
  typeof cwd === 'string' ? readAgentUsage(cwd) : null);

// ─── IPC: Claude subscription usage (5h session + 7d weekly, from statusLine) ─
ipcMain.handle('project:usageLimits', () => hive.usageLimits());

// ─── IPC: scheduled missions (recurring auto-dispatch) ──────────────────────
ipcMain.handle('missions:list', () => readConfig().missions ?? []);
ipcMain.handle('missions:save', (_evt, missions) => {
  // lastFiredAt is scheduler-owned. The renderer loads missions once and later
  // sends back a STALE array, so a wholesale write would clobber every
  // lastFiredAt the scheduler has stamped since. Merge by id and keep the newer
  // lastFiredAt (almost always the persisted one) so the UI can never erase it.
  const incoming = (Array.isArray(missions) ? missions : []) as ScheduledMission[];
  const persistedById = new Map(
    (readConfig().missions ?? []).map((m) => [m.id, m] as const)
  );
  const merged = incoming.map((m) => {
    const prev = persistedById.get(m.id);
    const prevLastFired = prev?.lastFiredAt ?? 0;
    const lastFiredAt = Math.max(m.lastFiredAt ?? 0, prevLastFired) || undefined;
    // A one-time mission that already fired (has lastFiredAt) must never be
    // resurrected by a stale renderer array re-asserting enabled:true.
    const enabled = m.mode === 'once' && lastFiredAt ? false : m.enabled;
    return { ...m, lastFiredAt, enabled };
  });
  writeConfig({ missions: merged });
  syncMissions();
  return { ok: true };
});

// ─── IPC: full-text search across hive files (board, tasks, memory) ──────────
ipcMain.handle('project:textSearch', (_evt, query: unknown) => {
  if (typeof query !== 'string' || !query.trim()) return { ok: false, results: [] };
  const root = hive.root();
  if (!root) return { ok: false, results: [] };
  const q = query.toLowerCase();
  const results: Array<{ source: string; excerpt: string }> = [];
  // Each target file is (path, readable label). agents/<id>/memory.md is expanded below.
  const targets: Array<{ path: string; source: string }> = [
    { path: join(root, 'board.md'), source: 'board.md' },
    { path: join(root, 'tasks.json'), source: 'tasks.json' }
  ];
  const agentsDir = join(root, 'agents');
  if (existsSync(agentsDir)) {
    for (const id of readdirSync(agentsDir)) {
      targets.push({ path: join(agentsDir, id, 'memory.md'), source: `${id}/memory.md` });
    }
  }
  for (const { path, source } of targets) {
    if (!existsSync(path)) continue;
    // Guard each read: a file vanishing/permission-flipping between the existsSync
    // and the read (or an unreadable file) must skip that target, not reject the
    // whole search.
    let content: string;
    try { content = readFileSync(path, 'utf8'); } catch { continue; }
    let hits = 0;
    for (const line of content.split('\n')) {
      if (hits >= 3) break;
      const idx = line.toLowerCase().indexOf(q);
      if (idx === -1) continue;
      // ~40 chars of context on either side of the match.
      const excerpt = line.slice(Math.max(0, idx - 40), idx + q.length + 40).trim();
      results.push({ source, excerpt });
      hits++;
    }
  }
  return { ok: true, results };
});

// ─── IPC: desktop notifications toggle ──────────────────────────────────────
ipcMain.handle('app:setNotifications', (_evt, val) => writeConfig({ notifications: val === true }));

// ─── IPC: Slack integration ─────────────────────────────────────────────────
ipcMain.handle('slack:start', () => startSlackServer());
ipcMain.handle('slack:stop', () => { stopSlackServer(); return { ok: true }; });
ipcMain.handle('slack:setConfig', (_evt, patch: unknown) => {
  const p = (patch ?? {}) as {
    signingSecret?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.channelId === 'string') next.slackChannelId = p.channelId.trim() || undefined;
  if (typeof p.port === 'number' && Number.isFinite(p.port)) next.slackPort = p.port;
  if (typeof p.enabled === 'boolean') next.slackEnabled = p.enabled;
  writeConfig(next);
  // Reconcile the running server: disabling (or clearing the secret) stops it. We
  // deliberately do NOT auto-(re)start here — the user presses Start in Settings
  // to fetch the fresh (ephemeral) tunnel URL.
  const cfg = readConfig();
  if (!cfg.slackEnabled || !cfg.slackSigningSecret) stopSlackServer();
  return { ok: true };
});

// ─── IPC: MCP server configuration ──────────────────────────────────────────
// User-managed MCP servers persisted on the app config and merged into each
// spawned agent's mcp.json (see src/main/mcp.ts + ProjectManager.ensureAgent).
// Secrets are encrypted at rest; handlers exchange DECRYPTED defs with the
// renderer (a local, trusted surface — same as the Slack secret in Settings).
function cleanRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k.trim() && typeof v === 'string') out[k.trim()] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeMcpDef(raw: unknown): { value: McpServerDef } | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'invalid server' };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim() : '';
  if (!name) return { error: 'name is required' };
  if (!isValidName(name)) return { error: 'name may only contain letters, numbers, _ and -' };
  const transport = r.transport === 'http' || r.transport === 'sse' ? r.transport : 'stdio';
  const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : `${name}-${Math.random().toString(36).slice(2, 8)}`;
  const value: McpServerDef = {
    id,
    name,
    enabled: r.enabled !== false,
    scope: r.scope === 'god' ? 'god' : 'all',
    transport
  };
  if (transport === 'stdio') {
    const command = typeof r.command === 'string' ? r.command.trim() : '';
    if (!command) return { error: 'command is required for a local (stdio) server' };
    value.command = command;
    value.args = Array.isArray(r.args) ? r.args.filter((a): a is string => typeof a === 'string') : [];
    value.env = cleanRecord(r.env);
  } else {
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (!url) return { error: 'url is required for a remote server' };
    try { new URL(url); } catch { return { error: 'url is not a valid URL' }; }
    value.url = url;
    value.headers = cleanRecord(r.headers);
  }
  return { value };
}

ipcMain.handle('mcp:list', () => ({
  servers: (readConfig().mcpServers ?? []).map(decryptDef),
  encryptionAvailable: encryptionAvailable()
}));
ipcMain.handle('mcp:save', (_evt, raw: unknown) => {
  const res = normalizeMcpDef(raw);
  if ('error' in res) return { ok: false, error: res.error };
  const list = (readConfig().mcpServers ?? []).filter((s) => s.id !== res.value.id);
  // Reject a duplicate name on a different id — same name silently clobbers in mcp.json.
  if (list.some((s) => s.name === res.value.name)) {
    return { ok: false, error: `a server named "${res.value.name}" already exists` };
  }
  list.push(encryptDef(res.value));
  writeConfig({ mcpServers: list });
  return { ok: true, servers: list.map(decryptDef) };
});
ipcMain.handle('mcp:remove', (_evt, id: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  const list = (readConfig().mcpServers ?? []).filter((s) => s.id !== id);
  writeConfig({ mcpServers: list });
  return { ok: true, servers: list.map(decryptDef) };
});
ipcMain.handle('mcp:test', (_evt, raw: unknown) => {
  const res = normalizeMcpDef(raw);
  if ('error' in res) return { ok: false, error: res.error };
  // res.value carries plaintext secrets (decryptDef is a no-op on them).
  return testConnection(res.value);
});

// ─── IPC: Knowledge library (Project Brain skills — the Skills tab) ───────────
ipcMain.handle('knowledge:list', () => {
  if (!knowledge.enabled()) return { ok: false, error: 'skill library disabled or no active project' };
  return { ok: true, skills: knowledge.listForAdmin(), status: knowledge.status() };
});
ipcMain.handle('knowledge:get', (_evt, slug: unknown) => {
  if (typeof slug !== 'string') return { ok: false, error: 'invalid slug' };
  const skill = knowledge.getSkill(slug);
  return skill ? { ok: true, skill } : { ok: false, error: 'not found' };
});
ipcMain.handle('knowledge:save', (_evt, input: unknown) => {
  if (!input || typeof input !== 'object') return { ok: false, error: 'invalid skill' };
  return knowledge.saveSkill(input as { slug?: string; title: string; description?: string; tags?: string[]; body: string; isNew?: boolean });
});
ipcMain.handle('knowledge:archive', (_evt, slug: unknown) =>
  typeof slug === 'string' ? knowledge.archiveSkill(slug) : { ok: false, error: 'invalid slug' });
ipcMain.handle('knowledge:restore', (_evt, slug: unknown) =>
  typeof slug === 'string' ? knowledge.restoreSkill(slug) : { ok: false, error: 'invalid slug' });
ipcMain.handle('knowledge:delete', (_evt, slug: unknown) =>
  typeof slug === 'string' ? knowledge.deleteSkill(slug) : { ok: false, error: 'invalid slug' });
ipcMain.handle('knowledge:curateNow', async () => {
  try { await curator.runCycle('manual'); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});

// ─── IPC: embedded browser pane (user chrome → staged native WebContentsView) ─
/** Resolve the agent the user's chrome (URL bar, nav buttons) should drive: the
 *  staged agent if any, else the god (Michael) so the pane works on launch. */
function userPaneAgentId(): string | null {
  if (stageAgentId) return stageAgentId;
  try { return hive.registry().godId; } catch { return null; }
}
ipcMain.handle('browser:ensure', () => {
  console.log('[browser] ipc browser:ensure (mainWindow=', !!mainWindow, ')');
  const id = userPaneAgentId();
  const v = id ? ensureAgentBrowser(id) : null;
  if (v) emitBrowserState();
  emitBrowserViews();
  return { ok: !!v, error: v ? undefined : 'no window or god not ready' };
});
ipcMain.handle('browser:navigate', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'invalid url' };
  const target = toHttpUrl(url);
  if (!target) return { ok: false, error: 'unsupported url scheme (http/https only)' };
  const id = userPaneAgentId();
  const v = id ? ensureAgentBrowser(id) : null;
  if (!v) return { ok: false, error: 'no staged agent' };
  try { await v.webContents.loadURL(target); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('browser:goBack', () => {
  const nav = (stagedWc() as unknown as { navigationHistory?: { canGoBack(): boolean; goBack(): void } } | null)?.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
});
ipcMain.handle('browser:goForward', () => {
  const nav = (stagedWc() as unknown as { navigationHistory?: { canGoForward(): boolean; goForward(): void } } | null)?.navigationHistory;
  if (nav?.canGoForward()) nav.goForward();
});
ipcMain.handle('browser:reload', () => { stagedWc()?.reload(); });
ipcMain.handle('browser:setBounds', (_evt, rect: unknown) => {
  if (!rect || typeof rect !== 'object') return;
  const r = rect as Record<string, unknown>;
  browserBounds = {
    x: Number(r.x) || 0, y: Number(r.y) || 0,
    width: Number(r.width) || 0, height: Number(r.height) || 0
  };
  applyBrowserBounds();
});
ipcMain.handle('browser:setVisible', (_evt, visible: unknown) => {
  browserVisible = visible === true;
  console.log('[browser] ipc browser:setVisible', browserVisible);
  // Parked (background) views are already offscreen; only the staged view's
  // visibility tracks the overlay guard.
  const ab = stageAgentId ? browserViews.get(stageAgentId) : null;
  if (ab && !ab.view.webContents.isDestroyed()) ab.view.setVisible(browserVisible);
});
ipcMain.handle('browser:stage', (_evt, agentId: unknown) => {
  if (typeof agentId !== 'string' || !agentId) return;
  // Auto-follow may fire on an agent's first browser tool before its view is
  // attached; create it so the pane can follow immediately. (Tab clicks always
  // reference an agent that already has a view.)
  if (!browserViews.has(agentId) && !ensureAgentBrowser(agentId)) return;
  stageAgent(agentId);
});

app.whenReady().then(() => {
  // Serve the bundled renderer + offline STT assets over app:// (production).
  // Registered before createWindow() so the first app://bundle/index.html load,
  // and the renderer's later fetches for app://bundle/models|wasm, resolve here.
  const rendererRoot = join(__dirname, '../renderer');
  protocol.handle('app', (request) => {
    let rel: string;
    try { rel = decodeURIComponent(new URL(request.url).pathname); }
    catch { return new Response('bad request', { status: 400 }); }
    if (rel === '/' || rel === '') rel = '/index.html';
    const filePath = join(rendererRoot, rel);
    // Path-traversal guard: the resolved path must stay under the renderer root.
    if (!resolve(filePath).startsWith(resolve(rendererRoot) + sep)) {
      return new Response('forbidden', { status: 403 });
    }
    try {
      const data = readFileSync(filePath);
      return new Response(data, { headers: { 'content-type': mimeForPath(filePath) } });
    } catch {
      return new Response('not found', { status: 404 });
    }
  });

  // Consolidated [stt] log sink: renderer + worker dictation logs are forwarded
  // here (via window.cth.sttLog) so they appear in the `npm run dev` terminal too.
  ipcMain.on('stt:log', (_e, level: string, parts: unknown[]) => {
    const args = Array.isArray(parts) ? parts : [parts];
    (level === 'error' ? console.error : console.log)('[stt]', ...args);
  });

  // Allow microphone capture for the dictation feature — but only for our OWN UI
  // (app:// in prod, the Vite localhost URL in dev), never the embedded web browser
  // pane, which can navigate to arbitrary sites.
  const isOwnOrigin = (s: string): boolean =>
    s.startsWith('app://') || s.startsWith('http://localhost') || s.startsWith('http://127.0.0.1');
  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    const url = wc?.getURL?.() ?? '';
    const allow = isOwnOrigin(url);
    if (permission === 'media') console.log('[stt] permission request:', permission, 'from', url, '→', allow);
    callback(allow);
  });
  // Some getUserMedia/enumerateDevices flows consult the synchronous check handler.
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    const allow = isOwnOrigin(requestingOrigin ?? '');
    if (permission === 'media') console.log('[stt] permission check:', permission, 'from', requestingOrigin, '→', allow);
    return allow;
  });

  // Persist the project migration once: a pre-"project" config derives its
  // activeProjectPath from the legacy `<harnessHome>/hive` on every read; write it
  // back so the on-disk config reflects reality (and `projects` is seeded).
  {
    const c0 = readConfig();
    if (c0.activeProjectPath) writeConfig({ activeProjectPath: c0.activeProjectPath, projects: c0.projects });
  }

  // Bootstrap the active project (if one is open) and start the message router.
  bootstrapActiveProject();
  createWindow();
  // Start the in-process browser MCP server and hand its endpoint to the hive so
  // EVERY agent spawns with a --mcp-config pointing at it (each with its own
  // x-agent-token). Best-effort: binding a localhost port is near-instant and
  // resolves well before the renderer kicks off the god spawn (~1.2s after load).
  // The resolver maps the request's token → that agent's lazily-created view.
  const browserMcpCfg = readConfig();
  void startBrowserMcp({
    resolve: (token) => {
      const id = agentTokenToId.get(token);
      if (!id) return null;
      return {
        ensureView: () => {
          ensureAgentBrowser(id);
          const ab = browserViews.get(id);
          if (ab) ab.lastUsed = Date.now(); // keep a browsing agent off the LRU chopping block
        },
        getWebContents: () => wcForAgent(id),
        capture: () => captureAgentPage(id)
      };
    }
  }, { preferredPort: browserMcpCfg.browserMcpPort }).then((handle) => {
    browserMcp = handle;
    hive.setBrowserEndpoint(handle.url);
    // Persist the ACTUAL bound port so the next launch reuses it and the port in every
    // agent's mcp.json stays valid across restarts (the stale-port bug). Only writes
    // when it changed (first run, or after an EADDRINUSE ephemeral fallback).
    if (handle.port && handle.port !== browserMcpCfg.browserMcpPort) {
      writeConfig({ browserMcpPort: handle.port });
    }
    console.log('[browser-mcp] listening', handle.url);
  }).catch((e) => console.error('[browser-mcp] failed to start:', e));
  // Auto-start the Slack webhook server when configured. Best-effort: a tunnel
  // failure (offline) is logged, not fatal. The tunnel URL is ephemeral and
  // changes per restart, so the user re-pastes it via Settings → Start.
  const slackCfg = readConfig();
  if (slackCfg.slackEnabled && slackCfg.slackSigningSecret) {
    void startSlackServer().then((r) => {
      if (!r.ok) console.error('[slack] auto-start failed:', r.error);
      else console.log('[slack] webhook listening', r.url ? `(tunnel: ${r.url})` : '(no tunnel)');
    }).catch((e) => console.error('[slack] auto-start threw:', e));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// before-quit covers Cmd-Q / dock-quit; the per-window close handler covers
// the red close button. Both routes hit the same warning UX.
app.on('before-quit', (e) => {
  if (allowQuit) return;
  const count = ptyManager.list().length;
  if (count === 0) return;
  e.preventDefault();
  if (mainWindow) {
    mainWindow.focus();
    mainWindow.webContents.send('app:closeRequested', { ptyCount: count });
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    ptyManager.killAll();
    app.quit();
  }
});
