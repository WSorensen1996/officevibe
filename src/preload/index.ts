import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

export interface AgentMeta {
  id: string;
  name: string;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  isAssistant?: boolean;
}

export interface ProjectMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One natural-language utterance an agent produced during a turn — "what it said"
 *  while working (mirrors main's AgentSay). Captured from the transcript on Stop and
 *  shown in the Messages tab. */
export interface AgentSay {
  id: string;
  ts: string;
  text: string;
  turn: string;
}

/** A short agent-posted status note shown on a task card (mirrors main's TaskUpdate). */
export interface TaskUpdate {
  ts: string;
  by: string;
  kind: 'doing' | 'blocked' | 'done' | 'note';
  text: string;
}

/** A file/image the human attached to a task. Binary lives on disk under
 *  `<projectRoot>/attachments/<taskId>/`; only this reference persists in
 *  tasks.json. `path` is relative to the project root. */
export interface TaskAttachment {
  name: string;
  path: string;
  kind: 'image' | 'file';
}

/** A card on the task kanban, persisted to hive/tasks.json. */
export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** Append-only agent status notes (harness-owned, capped at 20). */
  updates?: TaskUpdate[];
  /** ISO of the last status change — recency tiebreaker for the writeTasks merge. */
  statusUpdatedAt?: string;
  /** ISO of the last UI dispatch — hides the dispatch button until the task's
   *  status next changes (re-nudgeable when blocked). */
  dispatchedAt?: string;
  /** Human-set: archived tasks are hidden from the board and listed separately. */
  archived?: boolean;
  /** ISO of the last time the human opened this card — drives the unread indicator.
   *  Renderer-owned; round-trips via the writeTasks `...t` spread. */
  viewedAt?: string;
  /** Files/images the human pasted or attached (binary on disk, refs only here). */
  attachments?: TaskAttachment[];
}

/** A message the router just delivered, with its resolved recipient ids. Drives
 *  the envelope-handoff animation on the office floor. `needsHuman` is set when
 *  the sender aimed at "human" (now routed to the god proxy) — cosmetic tint
 *  only; there is no approval queue. */
export interface ProjectRouteEvent {
  id: string;
  from: string;
  to: string;
  act: 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';
  subject: string;
  targets: string[];
  needsHuman: boolean;
}

export interface SpawnPtyOptions {
  id: string;
  cwd: string;
  command: string;
  args?: string[];
  cols?: number;
  rows?: number;
  /** When present, the agent is provisioned in the project at spawn. */
  hive?: AgentMeta;
  /** When true (and cwd is a git repo), spawn the agent in its own git worktree. */
  isolate?: boolean;
}

export interface PtyExit { exitCode: number; signal?: number | undefined }

/** A scheduled auto-dispatch handled by the scheduler. Historically a recurring
 *  "mission"; now also backs Tasks-tab schedules via taskId + mode. Mirrored in
 *  main/config.ts and renderer TasksKanban.tsx — keep the three in sync. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  lastFiredAt?: number;
  /** When set, this schedule auto-dispatches a Tasks-tab task (re-read live at
   *  fire time); label/to are a best-effort snapshot and body is unused. */
  taskId?: string;
  /** 'recurring' fires every intervalMs; 'once' fires a single time at runAt.
   *  Absent ⇒ 'recurring' (back-compat). */
  mode?: 'recurring' | 'once';
  /** Epoch ms of the single fire when mode === 'once'. */
  runAt?: number;
}

/** A project the user has opened/created — its folder is the data root. */
export interface ProjectRef {
  name: string;
  path: string;
}

/** A user-configured MCP server (mirrors McpServerDef in src/main/mcp.ts). The
 *  defs exchanged over IPC are DECRYPTED (secrets in env/headers are plaintext). */
export interface McpServerDef {
  id: string;
  name: string;
  enabled: boolean;
  scope: 'all' | 'god';
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** One row in the Skills tab: an index entry joined with usage telemetry
 *  (mirrors SkillAdminRow in src/main/knowledge.ts). */
export interface KnowledgeSkill {
  slug: string;
  title: string;
  desc: string;
  tags: string[];
  state: 'provisional' | 'active' | 'stale' | 'archived';
  created_by: string;
  pinned: boolean;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  inject_count: number;
}

export interface KnowledgeStatus {
  enabled: boolean;
  total: number;
  active: number;
  provisional: number;
  stale: number;
  archived: number;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  /** Default parent directory for newly created projects (the old "harness home"). */
  harnessHome: string | null;
  /** The currently open project folder = the data root. */
  activeProjectPath: string | null;
  /** Known projects (drives the switcher). */
  projects: ProjectRef[];
  registeredRepos: string[];
  autoMode: boolean;
  autoPilot?: boolean;
  remoteControl?: boolean;
  defaultCommand: string;
  defaultModel?: string;
  /** Default effort level for newly spawned agents (passed as `--effort <level>`); unset = CLI default. */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  sttModel: 'whisper-base.en' | 'whisper-tiny.en';
  missions?: ScheduledMission[];
  notifications?: boolean;
  mcpServers?: McpServerDef[];
}

export interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  palacePath: string | null;
  model: 'minilm' | 'embeddinggemma';
  bin: string | null;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

/** Real token usage + estimated USD cost summed from an agent's Claude Code
 *  transcripts under ~/.claude/projects (Sonnet pricing). */
export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

/** One Claude rate-limit window (5-hour or 7-day), captured from the Claude Code
 *  statusLine `rate_limits` payload. */
export interface UsageWindow {
  /** 0–100 percent of the window's limit consumed. */
  usedPercent: number;
  /** Unix epoch seconds when the rolling window resets, or null if unknown. */
  resetsAt: number | null;
}

/** Account-wide Claude subscription usage (current 5h session + 7d weekly). Each
 *  window is null until captured (Pro/Max only, after the first API response). */
export interface UsageLimits {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  model: string | null;
  /** Epoch ms the snapshot was written. */
  capturedAt: number;
}

/** Live state of the STAGED (on-screen) agent's browser view, pushed to the
 *  renderer chrome on every navigation / load change. `agentId` is whose view is
 *  currently on stage (null when none is). */
export interface BrowserState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  agentId: string | null;
}

/** One agent that currently has a live browser view — a tab in the pane's strip. */
export interface BrowserView {
  agentId: string;
  name: string;
  isGod: boolean;
}

/** The browser tab-strip roster + which agent is staged, pushed on
 *  create / teardown / stage. */
export interface BrowserViews {
  views: BrowserView[];
  stageAgentId: string | null;
}

/** Pixel rect (CSS px = Electron DIP) the renderer measures for the browser pane. */
export interface BrowserBounds { x: number; y: number; width: number; height: number }

const api = {
  // ─── PTY ─────────────────────────────────────────────────────────────────
  spawnPty: (opts: SpawnPtyOptions): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:spawn', opts),
  writePty: (id: string, data: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:write', id, data),
  resizePty: (id: string, cols: number, rows: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:resize', id, cols, rows),
  killPty: (id: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('pty:kill', id),
  listPtys: (): Promise<Array<{ id: string; cwd: string; command: string; pid: number }>> =>
    ipcRenderer.invoke('pty:list'),
  onPtyData: (id: string, cb: (data: string) => void): (() => void) => {
    const channel = `pty:data:${id}`;
    const listener = (_e: IpcRendererEvent, data: string) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
  onPtyExit: (id: string, cb: (info: PtyExit) => void): (() => void) => {
    const channel = `pty:exit:${id}`;
    const listener = (_e: IpcRendererEvent, info: PtyExit) => cb(info);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // ─── Dialog ──────────────────────────────────────────────────────────────
  chooseFolder: (): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('dialog:chooseFolder'),

  // ─── Terminal.app ────────────────────────────────────────────────────────
  openTerminalAt: (cwd: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:openAtFolder', cwd),

  // ─── Clipboard ─────────────────────────────────────────────────────────────
  copyToClipboard: (text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('app:copyToClipboard', text),

  // ─── Speech-to-text diagnostics ──────────────────────────────────────────────
  /** Forward a dictation log line to the main process so it shows in the terminal
   *  running `npm run dev` (one consolidated place to read [stt] logs). */
  sttLog: (level: 'log' | 'error', parts: unknown[]): void =>
    ipcRenderer.send('stt:log', level, parts),

  // ─── Config ──────────────────────────────────────────────────────────────
  getConfig: (): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:get'),
  updateConfig: (patch: Partial<HarnessConfig>): Promise<HarnessConfig> =>
    ipcRenderer.invoke('config:update', patch),
  ensureHarnessHome: (path: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('config:ensureHome', path),

  // ─── Project management (open / create / switch) ──────────────────────────
  /** Create `officevibe-<slug>` under parentDir, make it active, relaunch. The
   *  process exits on success, so this promise typically never resolves. */
  projectCreate: (name: string, parentDir?: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('project:create', { name, parentDir }),
  /** Open an existing folder as the active project, then relaunch. */
  projectOpen: (path: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('project:open', path),
  /** Switch to a known project by path, then relaunch. */
  projectSwitch: (path: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke('project:switch', path),

  // ─── Filesystem (sandboxed to cwd) ───────────────────────────────────────
  listDir: (root: string, rel: string): Promise<
    { ok: true; entries: DirEntry[]; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:listDir', root, rel),
  readFile: (root: string, rel: string): Promise<
    { ok: true; content: string; path: string; size: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:readFile', root, rel),
  writeFile: (root: string, rel: string, content: string): Promise<
    { ok: true; path: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('fs:writeFile', root, rel, content),

  // ─── Task attachments (binary, under <projectRoot>/attachments/<taskId>) ──────
  /** Write a base64-encoded file as a task attachment. The main process resolves
   *  the project root + sanitizes the names; returns the stored relative path. */
  attachmentWrite: (taskId: string, fileName: string, base64: string): Promise<
    { ok: true; rel: string; name: string } | { ok: false; error: string }
  > => ipcRenderer.invoke('attachment:write', taskId, fileName, base64),
  /** Read an attachment (by its relative path) back as a data: URL for display. */
  attachmentRead: (rel: string): Promise<
    { ok: true; dataUrl: string; size: number } | { ok: false; error: string }
  > => ipcRenderer.invoke('attachment:read', rel),

  // ─── Project store (multi-agent coordination) ────────────────────────────
  projectBoard: (): Promise<string> => ipcRenderer.invoke('project:board'),
  projectTasks: (): Promise<unknown> => ipcRenderer.invoke('project:tasks'),
  projectLog: (n?: number): Promise<unknown[]> => ipcRenderer.invoke('project:log', n ?? 200),
  projectMemory: (id: string): Promise<string> => ipcRenderer.invoke('project:memory', id),
  projectInbox: (id: string): Promise<ProjectMessage[]> => ipcRenderer.invoke('project:inbox', id),
  /** What the agent said while working (its natural-language output per turn). */
  projectSays: (id: string, n?: number): Promise<AgentSay[]> => ipcRenderer.invoke('project:says', id, n),

  // ─── Semantic memory (MemPalace CLI) ─────────────────────────────────────
  memoryStatus: (): Promise<MemoryStatus> => ipcRenderer.invoke('project:memoryStatus'),
  searchMemory: (query: string, wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('project:searchMemory', query, wing),
  memoryWakeUp: (wing?: string): Promise<{ ok: boolean; output: string; error?: string }> =>
    ipcRenderer.invoke('project:memoryWakeUp', wing),
  mineNow: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('project:mineNow'),
  projectSend: (msg: Partial<ProjectMessage>, from?: string): Promise<{ ok: boolean; error?: string; message?: ProjectMessage; delivered?: number }> =>
    ipcRenderer.invoke('project:send', msg, from),

  // ─── Enrichment assistant (headless Sonnet 1M prompt prep for Michael) ─────
  /** Run Michael's silent assistant on a raw message and return an enriched,
   *  context-rich prompt. `cwd` is the agent's working directory (its default
   *  context); the assistant may read every registered repo to gather more.
   *  `mode: 'task'` returns a self-contained task description instead of a
   *  Michael-addressed prompt (used by the Kanban task form). */
  enrichMessage: (req: { message: string; cwd: string; mode?: 'message' | 'task' }): Promise<{ ok: boolean; prompt?: string; error?: string; memoryUnavailable?: boolean }> =>
    ipcRenderer.invoke('assistant:enrich', req),
  onProjectHookEvent: (
    cb: (e: { agentId?: string; event: string; tool?: string; notificationType?: string; source?: string; message?: string; blocked?: boolean }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId?: string; event: string; tool?: string; notificationType?: string; source?: string; message?: string; blocked?: boolean }) => cb(payload);
    ipcRenderer.on('project:hookEvent', listener);
    return () => ipcRenderer.removeListener('project:hookEvent', listener);
  },
  onProjectMessage: (cb: (e: ProjectRouteEvent) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: ProjectRouteEvent) => cb(payload);
    ipcRenderer.on('project:message', listener);
    return () => ipcRenderer.removeListener('project:message', listener);
  },
  /** An agent just posted a status update onto a task (drives a live kanban
   *  refresh + auto-move). Same subscription shape as onProjectMessage. */
  onProjectTaskUpdated: (
    cb: (e: { taskId: string; by: string; kind: 'doing' | 'blocked' | 'done' | 'note'; text: string }) => void
  ): (() => void) => {
    const listener = (
      _e: IpcRendererEvent,
      payload: { taskId: string; by: string; kind: 'doing' | 'blocked' | 'done' | 'note'; text: string }
    ) => cb(payload);
    ipcRenderer.on('project:taskUpdated', listener);
    return () => ipcRenderer.removeListener('project:taskUpdated', listener);
  },
  /** An agent just said something (captured from its transcript on Stop). Drives a
   *  live append to the Messages tab. Same subscription shape as onProjectMessage. */
  onProjectAgentSaid: (
    cb: (e: { agentId: string; says: AgentSay[] }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { agentId: string; says: AgentSay[] }) => cb(payload);
    ipcRenderer.on('project:agentSaid', listener);
    return () => ipcRenderer.removeListener('project:agentSaid', listener);
  },

  // ─── Permission gate (PreToolUse approval cards) ─────────────────────────────
  /** An agent's PreToolUse hook is blocked awaiting the user's approval. Carries the
   *  exact tool + structured input so the card shows precisely what's being approved. */
  onPermissionRequest: (
    cb: (e: { requestId: string; agentId?: string; tool: string; input?: unknown; cwd?: string }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { requestId: string; agentId?: string; tool: string; input?: unknown; cwd?: string }) => cb(payload);
    ipcRenderer.on('permission:request', listener);
    return () => ipcRenderer.removeListener('permission:request', listener);
  },
  /** A pending permission request was resolved out-of-band (timed out / agent died) —
   *  clear its card. */
  onPermissionResolved: (
    cb: (e: { requestId: string; timedOut?: boolean }) => void
  ): (() => void) => {
    const listener = (_e: IpcRendererEvent, payload: { requestId: string; timedOut?: boolean }) => cb(payload);
    ipcRenderer.on('permission:resolved', listener);
    return () => ipcRenderer.removeListener('permission:resolved', listener);
  },
  /** Answer a pending PreToolUse approval (allow/deny). On deny, `reason` is fed back
   *  to the model as the explanation. */
  respondPermission: (requestId: string, decision: 'allow' | 'deny', reason?: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('permission:respond', { requestId, decision, reason }),

  // ─── Quit confirmation ───────────────────────────────────────────────────
  onCloseRequested: (cb: (info: { ptyCount: number }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, info: { ptyCount: number }) => cb(info);
    ipcRenderer.on('app:closeRequested', listener);
    return () => ipcRenderer.removeListener('app:closeRequested', listener);
  },
  confirmClose: (): Promise<void> => ipcRenderer.invoke('app:confirmClose'),
  cancelClose: (): Promise<void> => ipcRenderer.invoke('app:cancelClose'),

  // ─── Reset ─────────────────────────────────────────────────────────────────
  /** Wipe the active project's data + its memory palace, reset config, and relaunch
   *  the app into onboarding. The process exits, so this promise never resolves. */
  resetAll: (): Promise<void> => ipcRenderer.invoke('app:resetAll'),

  // ─── Token telemetry (real usage + est. cost from CC transcripts) ──────────
  /** Sum input/output/cache tokens + estimated USD cost for an agent from its
   *  Claude Code transcripts. Returns null for an invalid cwd. */
  agentUsage: (cwd: string): Promise<AgentUsage | null> =>
    ipcRenderer.invoke('project:agentUsage', cwd),
  /** The latest account-wide Claude usage snapshot (current 5h session + 7d
   *  weekly), captured from the agents' statusLine. Null until first captured. */
  usageLimits: (): Promise<UsageLimits | null> =>
    ipcRenderer.invoke('project:usageLimits'),

  // ─── Task kanban (hive/tasks.json) ───────────────────────────────────────
  /** Overwrite the hive task ledger with the full task list and commit it. */
  projectWriteTasks: (tasks: ProjectTask[]): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('project:writeTasks', tasks),

  // ─── Scheduled missions (recurring auto-dispatch) ──────────────────────────
  listMissions: (): Promise<ScheduledMission[]> => ipcRenderer.invoke('missions:list'),
  saveMissions: (missions: ScheduledMission[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('missions:save', missions),
  /** A scheduled mission just fired in the main process. Lets the renderer wake
   *  the idle assignee (startFloor) and refresh the schedule view. */
  onSchedulerFired: (cb: () => void): (() => void) => {
    const listener = (): void => cb();
    ipcRenderer.on('scheduler:fired', listener);
    return () => ipcRenderer.removeListener('scheduler:fired', listener);
  },

  // ─── Full-text search across hive files (board, tasks, memory) ─────────────
  textSearch: (q: string): Promise<{ ok: boolean; results: Array<{ source: string; excerpt: string }> }> =>
    ipcRenderer.invoke('project:textSearch', q),

  // ─── Desktop notifications ───────────────────────────────────────────────────
  /** Toggle native desktop notifications for agent lifecycle events. */
  setNotifications: (v: boolean): Promise<HarnessConfig> =>
    ipcRenderer.invoke('app:setNotifications', v),

  // ─── Slack integration (Slack message → Michael's queue) ─────────────────────
  /** Register a listener for inbound Slack messages; returns an unsubscribe fn.
   *  Same pattern as onProjectHookEvent. */
  onSlackMessage: (cb: (msg: { text: string }) => void): (() => void) => {
    const listener = (_e: IpcRendererEvent, msg: { text: string }) => cb(msg);
    ipcRenderer.on('slack:incomingMessage', listener);
    return () => ipcRenderer.removeListener('slack:incomingMessage', listener);
  },
  /** Start the Slack webhook server; returns the public tunnel URL to paste into
   *  the Slack app's Event Subscriptions → Request URL. */
  slackStart: (): Promise<{ ok: boolean; url?: string; error?: string }> =>
    ipcRenderer.invoke('slack:start'),
  /** Stop the Slack webhook server + tunnel. */
  slackStop: (): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:stop'),
  /** Persist Slack settings (and stop the server if disabled / secret cleared). */
  slackSetConfig: (patch: {
    signingSecret?: string; channelId?: string; port?: number; enabled?: boolean;
  }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke('slack:setConfig', patch),

  // ─── MCP server connections (wired into spawned agents' mcp.json) ────────────
  /** List configured MCP servers (decrypted) + whether secrets encrypt at rest. */
  mcpList: (): Promise<{ servers: McpServerDef[]; encryptionAvailable: boolean }> =>
    ipcRenderer.invoke('mcp:list'),
  /** Create or update a server (upsert by id); returns the refreshed list. */
  mcpSave: (def: McpServerDef): Promise<{ ok: boolean; error?: string; servers?: McpServerDef[] }> =>
    ipcRenderer.invoke('mcp:save', def),
  /** Delete a server by id; returns the refreshed list. */
  mcpRemove: (id: string): Promise<{ ok: boolean; error?: string; servers?: McpServerDef[] }> =>
    ipcRenderer.invoke('mcp:remove', id),
  /** Live health check: connect and list the server's tools. */
  mcpTest: (def: McpServerDef): Promise<{ ok: boolean; tools?: string[]; error?: string }> =>
    ipcRenderer.invoke('mcp:test', def),

  // ─── Knowledge library (Project Brain skills — the Skills tab) ───────────────
  /** All skills (incl. archived) + a status summary, for the admin tab. */
  knowledgeList: (): Promise<{ ok: boolean; skills?: KnowledgeSkill[]; status?: KnowledgeStatus; error?: string }> =>
    ipcRenderer.invoke('knowledge:list'),
  /** A single skill parsed for view/edit (frontmatter stripped → body). */
  knowledgeGet: (slug: string): Promise<{ ok: boolean; skill?: { slug: string; title: string; description: string; tags: string[]; body: string }; error?: string }> =>
    ipcRenderer.invoke('knowledge:get', slug),
  /** Create (isNew) or update a skill; user-authored skills become human-owned. */
  knowledgeSave: (input: { slug?: string; title: string; description?: string; tags?: string[]; body: string; isNew?: boolean }): Promise<{ ok: boolean; slug?: string; error?: string }> =>
    ipcRenderer.invoke('knowledge:save', input),
  knowledgeArchive: (slug: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('knowledge:archive', slug),
  knowledgeRestore: (slug: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('knowledge:restore', slug),
  knowledgeDelete: (slug: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('knowledge:delete', slug),
  /** Run a curator cycle now (promote proposals + lifecycle + budget-gated consolidation). */
  knowledgeCurateNow: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('knowledge:curateNow'),

  // ─── Embedded browser pane (god-driven native WebContentsView, bottom-left) ──
  browser: {
    /** Create the WebContentsView if it doesn't exist yet (idempotent). */
    ensure: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('browser:ensure'),
    /** Navigate the pane (user-driven, from the URL bar). */
    navigate: (url: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('browser:navigate', url),
    goBack: (): Promise<void> => ipcRenderer.invoke('browser:goBack'),
    goForward: (): Promise<void> => ipcRenderer.invoke('browser:goForward'),
    reload: (): Promise<void> => ipcRenderer.invoke('browser:reload'),
    /** Position the native view to track the renderer's placeholder rect. */
    setBounds: (rect: BrowserBounds): Promise<void> => ipcRenderer.invoke('browser:setBounds', rect),
    /** Show/hide the staged view (hide it whenever a DOM overlay is open). */
    setVisible: (visible: boolean): Promise<void> => ipcRenderer.invoke('browser:setVisible', visible),
    /** Make `agentId`'s browser the staged (on-screen) one — a tab click or auto-follow. */
    stage: (agentId: string): Promise<void> => ipcRenderer.invoke('browser:stage', agentId),
    /** Subscribe to live URL/title/loading state of the staged view. Returns an unsubscribe fn. */
    onState: (cb: (s: BrowserState) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, s: BrowserState) => cb(s);
      ipcRenderer.on('browser:state', listener);
      return () => ipcRenderer.removeListener('browser:state', listener);
    },
    /** Subscribe to the tab-strip roster (agents with a live browser + the staged one). */
    onViews: (cb: (v: BrowserViews) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, v: BrowserViews) => cb(v);
      ipcRenderer.on('browser:views', listener);
      return () => ipcRenderer.removeListener('browser:views', listener);
    }
  }
};

contextBridge.exposeInMainWorld('cth', api);

export type CthApi = typeof api;
