import { app, BrowserWindow, WebContentsView, clipboard, dialog, ipcMain, shell, protocol, session } from 'electron';
import { spawn } from 'node:child_process';
import { rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep, extname } from 'node:path';
import { PtyManager, type SpawnOptions } from './pty';
import {
  readConfig, writeConfig, resetConfig, ensureHarnessHome,
  slugify, projectFolderName, defaultProjectsDir, deriveProjectName, upsertProject,
  type HarnessConfig, type ScheduledMission, type ProjectRef
} from './config';
import { listDir, readFileText, writeFileText } from './fs';
import {
  getBranch, isRepo, addWorktree, removeWorktree
} from './git';
import { ProjectManager, type AgentMeta, type ProjectMessage, type ProjectTask } from './project';
import { HookServer } from './hooks';
import { MemoryManager } from './memory';
import { enrichMessage } from './assistant';
import { readAgentUsage } from './transcript';
import { SlackWebhookServer } from './slack';
import { startBrowserMcp, type BrowserMcpHandle } from './browserMcp';

const isDev = !!process.env.ELECTRON_RENDERER_URL;

// Register a privileged `app://` scheme so a packaged build can fetch() its own
// bundled assets — Chromium blocks fetch() of file:// URLs, which the in-renderer
// Whisper speech-to-text (transformers.js) needs to load its model + wasm. The
// renderer loads from app://bundle/ in production (dev uses the Vite http URL).
protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
]);

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
  (channel, payload) => { try { liveWebContents()?.send(channel, payload); } catch { /* window tore down */ } }
);
const hookServer = new HookServer(hive, () => liveWebContents(), () => readConfig());
const memory = new MemoryManager(
  () => readConfig().activeProjectPath,
  () => { const c = readConfig(); return { enabled: c.semanticMemory !== false, model: c.embeddingModel ?? 'minilm' }; }
);
let mainWindow: BrowserWindow | null = null;

// ─── Embedded browser pane (god-driven native WebContentsView) ───────────────
/** The bottom-left browser pane. A native view that paints above the DOM, so the
 *  renderer hides it (browser:setVisible) whenever a modal/fullscreen overlay is
 *  open. Created lazily on browser:ensure (BrowserPane mount) or first agent use. */
let browserView: WebContentsView | null = null;
/** The in-process MCP server that lets the god agent drive `browserView`. */
let browserMcp: BrowserMcpHandle | null = null;
/** Last bounds the renderer measured for the pane (CSS px = DIP). */
let browserBounds = { x: 0, y: 0, width: 0, height: 0 };
/** Whether the pane should be shown (false while a DOM overlay is open). */
let browserVisible = true;

/** The pane's live webContents, or null if it isn't up. */
function browserWc(): Electron.WebContents | null {
  return browserView && !browserView.webContents.isDestroyed() ? browserView.webContents : null;
}

/** Position the native view to the renderer's last-measured rect. */
function applyBrowserBounds(): void {
  if (!browserView || browserView.webContents.isDestroyed()) return;
  const b = browserBounds;
  browserView.setBounds({
    x: Math.round(b.x), y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)), height: Math.max(0, Math.round(b.height))
  });
}

/** Push the pane's URL/title/loading state to the renderer chrome. */
function emitBrowserState(): void {
  const wc = browserWc();
  if (!wc) return;
  const nav = (wc as unknown as { navigationHistory?: { canGoBack(): boolean; canGoForward(): boolean } }).navigationHistory;
  try {
    liveWebContents()?.send('browser:state', {
      url: wc.getURL(),
      title: wc.getTitle(),
      canGoBack: nav?.canGoBack() ?? false,
      canGoForward: nav?.canGoForward() ?? false,
      loading: wc.isLoading()
    });
  } catch { /* window tore down */ }
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

/** Create the browser WebContentsView if absent and attach it to the window.
 *  Idempotent; returns null only if there's no window yet. */
function ensureBrowserView(): WebContentsView | null {
  if (!mainWindow) return null;
  if (browserView && !browserView.webContents.isDestroyed()) return browserView;
  const view = new WebContentsView({
    webPreferences: {
      // Isolated, persistent profile — the agent's logins persist across restarts
      // but stay separate from the user's real Chrome.
      partition: 'persist:agent-browser',
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  view.setBackgroundColor('#FFF8E7'); // kill the white flash before first paint
  browserView = view;
  mainWindow.contentView.addChildView(view);
  console.log('[browser] WebContentsView created + attached; window children =', mainWindow.contentView.children.length);
  applyBrowserBounds();
  view.setVisible(browserVisible);

  const wc = view.webContents;
  // Keep popups in-pane instead of spawning OS windows (mirrors the main window).
  wc.setWindowOpenHandler(({ url }) => { const t = toHttpUrl(url); if (t) { try { void wc.loadURL(t); } catch { /* noop */ } } return { action: 'deny' }; });
  const onChange = (): void => emitBrowserState();
  wc.on('did-navigate', onChange);
  wc.on('did-navigate-in-page', onChange);
  wc.on('page-title-updated', onChange);
  wc.on('did-start-loading', onChange);
  wc.on('did-stop-loading', onChange);
  // ── Diagnostics: surface load failures + render crashes (these explain a blank/black pane).
  wc.on('did-finish-load', () => console.log('[browser] did-finish-load', wc.getURL()));
  wc.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    console.error('[browser] did-fail-load', { code, desc, url, isMainFrame });
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
  wc.on('render-process-gone', (_e, details) => console.error('[browser] render-process-gone', JSON.stringify(details)));
  wc.on('unresponsive', () => console.error('[browser] webContents unresponsive'));
  console.log('[browser] loading start page https://www.google.com');
  void wc.loadURL('https://www.google.com').catch((e) => console.error('[browser] loadURL threw', e));
  return view;
}

/** Best-effort destroy of the browser pane + its MCP server (used on quit/reset). */
function teardownBrowser(): void {
  try { browserMcp?.stop(); } catch (e) { console.error('[browser] mcp stop:', e); }
  browserMcp = null;
  try {
    if (browserView && mainWindow && !browserView.webContents.isDestroyed()) {
      mainWindow.contentView.removeChildView(browserView);
    }
  } catch (e) { console.error('[browser] removeChildView:', e); }
  browserView = null;
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
    if (agentToPty.get(agentId) === id) {
      agentToPty.delete(agentId);
      if (hive.enabled()) {
        try { hive.setArchived(agentId, true); } catch (e) { console.error('[hive] setArchived failed:', e); }
      }
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
    to = task.assignee ?? 'god';
    subject = 'Task from you';
    body = `Task: ${task.title} [task:${task.id}]\nContext: ${desc}\n`;
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
  slackServer?.stop();
  slackServer = new SlackWebhookServer({
    port: cfg.slackPort && cfg.slackPort > 0 ? cfg.slackPort : 3847,
    signingSecret: cfg.slackSigningSecret,
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
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow = win;

  win.once('ready-to-show', () => win.show());

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

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
      const inj = hive.ensureAgent({ ...opts.hive, cwd: opts.cwd }, { semanticMemory: memory.active() });
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
ipcMain.handle('config:get', (): HarnessConfig => readConfig());
ipcMain.handle('config:update', (_evt, patch: Partial<HarnessConfig>) => writeConfig(patch));
ipcMain.handle('config:ensureHome', (_evt, path: unknown) => {
  if (typeof path !== 'string' || path.length === 0) return { ok: false, error: 'invalid path' };
  return ensureHarnessHome(path);
});

// ─── IPC: filesystem (sandboxed to a root) ──────────────────────────────────
ipcMain.handle('fs:listDir', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return listDir(root, rel);
});
ipcMain.handle('fs:readFile', (_evt, root: unknown, rel: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string') return { ok: false, error: 'invalid args' };
  return readFileText(root, rel);
});
ipcMain.handle('fs:writeFile', (_evt, root: unknown, rel: unknown, content: unknown) => {
  if (typeof root !== 'string' || typeof rel !== 'string' || typeof content !== 'string') {
    return { ok: false, error: 'invalid args' };
  }
  return writeFileText(root, rel, content);
});

// ─── IPC: project store (multi-agent coordination) ──────────────────────────
ipcMain.handle('project:registry', () => hive.registry());
ipcMain.handle('project:board', () => hive.board());
ipcMain.handle('project:tasks', () => hive.tasks());
ipcMain.handle('project:log', (_evt, n: unknown) => hive.logTail(typeof n === 'number' ? n : 200));
ipcMain.handle('project:memory', (_evt, id: unknown) => (typeof id === 'string' ? hive.memory(id) : ''));
ipcMain.handle('project:inbox', (_evt, id: unknown) => (typeof id === 'string' ? hive.inbox(id) : []));
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
ipcMain.handle('project:setArchived', (_evt, id: unknown, archived: unknown) => {
  if (typeof id !== 'string') return { ok: false, error: 'invalid id' };
  if (!hive.enabled()) return { ok: false, error: 'no active project' };
  hive.setArchived(id, archived === true);
  return { ok: true };
});

// ─── IPC: project management (open / create / switch) ───────────────────────
/** List known projects + which one is active (drives the switcher). */
ipcMain.handle('project:list', () => {
  const cfg = readConfig();
  return { projects: cfg.projects ?? [], activeProjectPath: cfg.activeProjectPath ?? null };
});

/** Tear down all services bound to the current project, then relaunch the app so
 *  the boot sequence re-bootstraps everything against the newly-active project.
 *  Mirrors the reset flow minus the data wipe. The process exits → never returns. */
function switchToProjectAndRelaunch(activeProjectPath: string, ref: ProjectRef): void {
  const projects = upsertProject(readConfig().projects ?? [], ref);
  writeConfig({ activeProjectPath, projects });
  allowQuit = true;
  teardownServices('switch');
  app.relaunch();
  app.exit(0);
}

/** Create a new project folder `officevibe-<slug>` under `parentDir`, write its
 *  manifest, make it active, and relaunch (ensureProject builds the skeleton). */
ipcMain.handle('project:create', (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { name?: unknown; parentDir?: unknown };
  const name = typeof p.name === 'string' ? p.name.trim() : '';
  if (!name) return { ok: false, error: 'project name required' };
  const cfg = readConfig();
  const parentDir = typeof p.parentDir === 'string' && p.parentDir ? p.parentDir : defaultProjectsDir(cfg);
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
  switchToProjectAndRelaunch(path, { name, path });
  return { ok: true, path };
});

/** Open an existing folder as the active project. Adopts any folder (ensureProject
 *  populates an empty one); a folder with a manifest/registry is recognised as one. */
ipcMain.handle('project:open', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path) return { ok: false, error: 'invalid path' };
  if (!existsSync(path)) return { ok: false, error: 'folder does not exist' };
  switchToProjectAndRelaunch(path, { name: deriveProjectName(path), path });
  return { ok: true, path };
});

/** Switch to an already-known project by path. */
ipcMain.handle('project:switch', (_evt, path: unknown) => {
  if (typeof path !== 'string' || !path) return { ok: false, error: 'invalid path' };
  switchToProjectAndRelaunch(path, { name: deriveProjectName(path), path });
  return { ok: true, path };
});

// ─── IPC: enrichment assistant (headless prompt prep, subscription default model) ───
ipcMain.handle('assistant:enrich', async (_evt, payload: unknown) => {
  const p = (payload ?? {}) as { message?: unknown; cwd?: unknown; mode?: unknown };
  if (typeof p.message !== 'string' || !p.message.trim()) {
    return { ok: false, error: 'empty message' };
  }
  const cfg = readConfig();
  const cwd = typeof p.cwd === 'string' && p.cwd ? p.cwd : cfg.activeProjectPath;
  if (!cwd) return { ok: false, error: 'no working directory available' };
  try {
    return await enrichMessage({
      message: p.message,
      cwd,
      repos: cfg.registeredRepos ?? [],
      command: cfg.defaultCommand,
      // Track the configured default model like the PTY agents do — unset → no
      // --model flag → the subscription's default model (no surprise cost).
      model: cfg.defaultModel,
      env: memory.env(),
      mode: p.mode === 'task' ? 'task' : 'message'
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
});

// ─── IPC: semantic memory (MemPalace CLI) ───────────────────────────────────
ipcMain.handle('project:memoryStatus', () => { memory.resetBinCache(); return memory.status(); });
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
  allowQuit = true;
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
  // Back to first-run defaults, then relaunch clean so all in-memory services
  // re-bootstrap from scratch and the renderer lands on onboarding.
  resetConfig();
  app.relaunch();
  app.exit(0);
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
    let hits = 0;
    for (const line of readFileSync(path, 'utf8').split('\n')) {
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
    signingSecret?: unknown; botToken?: unknown; channelId?: unknown; port?: unknown; enabled?: unknown;
  };
  const next: Partial<HarnessConfig> = {};
  // Trim string fields; an emptied field clears back to undefined.
  if (typeof p.signingSecret === 'string') next.slackSigningSecret = p.signingSecret.trim() || undefined;
  if (typeof p.botToken === 'string') next.slackBotToken = p.botToken.trim() || undefined;
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

// ─── IPC: embedded browser pane (user chrome → native WebContentsView) ───────
ipcMain.handle('browser:ensure', () => {
  console.log('[browser] ipc browser:ensure (mainWindow=', !!mainWindow, ')');
  const v = ensureBrowserView();
  if (v) emitBrowserState();
  return { ok: !!v, error: v ? undefined : 'no window' };
});
ipcMain.handle('browser:navigate', async (_evt, url: unknown) => {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, error: 'invalid url' };
  const target = toHttpUrl(url);
  if (!target) return { ok: false, error: 'unsupported url scheme (http/https only)' };
  const v = ensureBrowserView();
  if (!v) return { ok: false, error: 'no window' };
  try { await v.webContents.loadURL(target); return { ok: true }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : String(e) }; }
});
ipcMain.handle('browser:goBack', () => {
  const nav = (browserWc() as unknown as { navigationHistory?: { canGoBack(): boolean; goBack(): void } } | null)?.navigationHistory;
  if (nav?.canGoBack()) nav.goBack();
});
ipcMain.handle('browser:goForward', () => {
  const nav = (browserWc() as unknown as { navigationHistory?: { canGoForward(): boolean; goForward(): void } } | null)?.navigationHistory;
  if (nav?.canGoForward()) nav.goForward();
});
ipcMain.handle('browser:reload', () => { browserWc()?.reload(); });
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
  if (browserView && !browserView.webContents.isDestroyed()) browserView.setVisible(browserVisible);
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
  if (hive.enabled()) {
    hive.ensureProject();
    hive.startRouter();
    syncMissions(); // arm recurring auto-dispatch missions now the router is live
    hookServer.start();
    memory.start(); // init per-project palace + mine loop (no-op without mempalace)
  }
  createWindow();
  // Start the in-process browser MCP server and hand its endpoint to the hive so
  // the god agent spawns with a --mcp-config pointing at it. Best-effort: binding
  // a localhost port is near-instant and resolves well before the renderer kicks
  // off the god spawn (~1.2s after load), so Michael gets the browser tool.
  void startBrowserMcp({
    ensureView: () => { ensureBrowserView(); },
    getWebContents: () => browserWc()
  }).then((handle) => {
    browserMcp = handle;
    hive.setBrowserEndpoint(handle.url, handle.token);
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
    });
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
