import { create } from 'zustand';
import type { AccentColorName } from '@/design/tokens';
import type { OfficeCharacterName } from '@/scene/office/cast';
import type { StatusKind } from '@/components/PixelBadge';
import type { EffortLevel } from '@/store/config';
import type { TaskAttachment } from '@/components/tasks/taskShared';

export type ToolKind =
  | 'Read' | 'Edit' | 'Write' | 'Bash' | 'WebFetch' | 'WebSearch'
  | 'Grep' | 'Glob' | 'TodoWrite' | 'MCP';

export type StationKind =
  | 'shelf' | 'terminal' | 'web' | 'board' | 'mailbox' | 'mcp' | 'desk';

export interface BlockReason {
  summary: string;                 // short headline shown on banner
  detail: string;                  // longer explanation
  command?: string;                // verbatim command awaiting confirmation, if any
  /** Shape of the underlying prompt — drives how the messages-tab card renders:
   *  'menu'/'yesno' show approve/deny buttons; 'text' shows a free-text reply box. */
  promptKind?: 'menu' | 'yesno' | 'text';
  /** Set when this card is backed by a real PreToolUse permission hook (the modern
   *  path). Actions resolve it via window.cth.respondPermission(requestId, …) rather
   *  than typing keystrokes into the pty. */
  requestId?: string;
  /** Parsed numbered-menu options (when promptKind === 'menu'), each carrying the
   *  exact keystroke to send (e.g. '1\r'). Legacy terminal-scrape path only. */
  menuItems?: Array<{ index: number; label: string; send: string }>;
  actions: Array<{
    label: string;
    kind: 'approve' | 'deny' | 'neutral';
    /** keystroke to type into the pty on click (e.g. '1\r' / 'y\r') — legacy path */
    send?: string;
    /** verdict to send via respondPermission when `requestId` is set — hook path */
    decision?: 'allow' | 'deny';
  }>;
}

export interface Agent {
  id: string;
  name: string;
  /** which Office character represents this agent on the floor */
  character: OfficeCharacterName;
  accent: AccentColorName;
  /** persistent short context — what is this agent for (shown on the floor) */
  description: string;
  project: string;
  cwd: string;
  goal?: string;
  status: StatusKind;
  action: string;
  progress: number;
  currentStation?: StationKind;
  carrying?: ToolKind;
  /** True only while this agent is actively driving the shared Browser pane via its
   *  mcp__browser__* tools — distinguishes a live browser session from a plain text
   *  WebSearch/WebFetch (which also walks the avatar to the 'web' station but renders
   *  no browser content). Drives the per-agent "watch the browser" attention cue. */
  browsing?: boolean;
  /** latest assistant message, streamed character-by-character in the sidebar */
  recentAssistantText?: string;
  /** epoch ms — used to drive the typewriter so identical strings still re-stream */
  recentTextTs?: number;
  /** populated when status === 'blocked' */
  blockReason?: BlockReason;
  /** present iff this agent has a real PTY in the main process */
  ptyId?: string;
  /** the command being run in the PTY (e.g. 'claude') */
  command?: string;
  /** the model this agent runs on (e.g. 'claude-sonnet-4-6[1m]'); drives the
   *  model selector + the --model arg used when (re)spawning the agent */
  model?: string;
  /** the effort level this agent runs at; drives the effort selector + the
   *  --effort arg used when (re)spawning the agent. undefined = CLI default. */
  effort?: EffortLevel;
  /** the last prompt the user submitted to this agent in Claude Code —
   *  shown on the floor as a card above the seated avatar */
  lastPrompt?: string;
  /** the orchestrator ("god") agent — seated in Michael's room, runs the floor */
  isGod?: boolean;
  /** Michael's co-orchestrator ("Dwight"). Acts on the todos/batches Michael
   *  delegates to him and can delegate to workers; still excluded from broadcasts. */
  isAssistant?: boolean;
  /** When git isolation is enabled, the dedicated worktree path the agent runs
   *  in (its own `agent/<id>` branch); undefined for shared-cwd agents. */
  worktreePath?: string;
  /** True once this agent's terminal was closed. Archived agents are retained
   *  (in the store's `archivedAgents` list + the hive registry) but flagged and
   *  kept off the floor; only live-PTY agents are 'active'. */
  archived?: boolean;
}

/** A message the user has parked for an agent while its terminal was busy.
 *  Queued messages are drained one at a time when the agent next goes idle (see
 *  useProject's flush loop). */
export interface QueuedMessage {
  id: string;
  text: string;
  /** epoch ms the message was queued — drives ordering and the "queued 2m ago" hint */
  ts: number;
}

/** Which view fills the left column. `office` is the floor + memory overlay and
 *  `browser` is the shared native browser pane; the next two are the selected
 *  agent's workspace (its terminal and messages); `task` is the
 *  transient full-card view opened from the Kanban board (see `openTaskId`);
 *  `file` is the transient file viewer opened from the files tab (see
 *  `openFilePath`). */
export type LeftTab = 'office' | 'terminal' | 'browser' | 'messages' | 'task' | 'file';

/** Sentinel `openTaskId` value meaning "the left task panel is in CREATE mode"
 *  (no real task yet). `shortId()` only ever emits `t-…` ids, so this can never
 *  collide with a real task id. Reuses the whole open/close/transient-tab flow. */
export const NEW_TASK_ID = '__new__';

/** A prefill handed to the CREATE-mode task form — e.g. when a user turns a
 *  selected sentence from a finished task's result into a new task. */
export interface NewTaskSeed {
  description?: string;
  /** Task ids the new task should depend on (the source task, for provenance). */
  dependsOn?: string[];
}

/** A persisted, in-progress CREATE-mode task draft. Lives in the store (not local
 *  component state) so the new-task form survives a left-tab switch: the `task`
 *  tab is conditionally mounted (App.tsx), so flipping to another tab unmounts the
 *  form and would otherwise drop whatever was typed. Reset whenever a card is
 *  started/opened/closed (see `openTask`); deliberately preserved across
 *  `setLeftTab`. Not persisted to localStorage — a draft should outlive a tab
 *  flick, not an app restart. */
export interface TaskDraft {
  title?: string;
  description?: string;
  assignee?: string;
  priority?: number;
  deps?: string[];
  /** Stable id minted once for a CREATE-mode draft so attachments written to disk
   *  under `attachments/<id>/` survive a tab-flick remount and match the id the
   *  task is finally created with. */
  id?: string;
  /** Attachments added before the task is created (survive the same tab flick). */
  attachments?: TaskAttachment[];
  /** Plan-mode flag, preserved across a tab flick like the other draft fields. */
  planMode?: boolean;
}

/** The left tabs that render the selected agent's workspace (vs the shared
 *  `office`/`browser` views). */
export const AGENT_LEFT_TABS = ['terminal', 'messages'] as const;
export function isAgentTab(tab: LeftTab): boolean {
  return (AGENT_LEFT_TABS as readonly string[]).includes(tab);
}

/** Lifecycle of the god agent ("Michael") bootstrap on launch.
 *  'booting' until his PTY is confirmed live, then 'ready' (or 'failed' if the
 *  spawn errored). The empty-floor UI shows a loader while 'booting' so users
 *  don't see the "add agent" prompt before Michael has clocked in. */
export type GodStatus = 'booting' | 'ready' | 'failed';

/** Which compute backend the dictation Whisper worker actually initialized on —
 *  surfaced in Settings as the human's in-app proof of GPU vs CPU (task 5z52).
 *  `device` is the real device the worker ended up using ('webgpu' | 'wasm'),
 *  `adapter` the GPU description when on webgpu. null = no model loaded yet this
 *  session (the worker only warms on the first dictation). */
export interface SttBackend { device: string; adapter?: string }

interface State {
  agents: Agent[];
  /** Agents whose terminal was closed — retained + flagged, kept off the active
   *  roster/floor. The hive registry retains them durably; this mirrors them for
   *  the renderer's "Archived" view. */
  archivedAgents: Agent[];
  selectedId: string | null;
  feeds: Record<string, string[]>;
  addAgentOpen: boolean;
  fullscreenAgentId: string | null;
  fullscreenFilePath: string | null;
  sidebarWidth: number;
  /** Which view fills the left column (office floor vs browser pane). Persisted
   *  (except the transient `task` view, which is never persisted). */
  leftTab: LeftTab;
  /** The task whose full card is open in the left-column `task` view, or null.
   *  May be the `NEW_TASK_ID` sentinel to mean CREATE mode (no real task yet).
   *  Transient (not persisted). */
  openTaskId: string | null;
  /** Absolute path of the file open in the left-column transient `file` view, or
   *  null. Set by clicking a file in the right-panel files tab; mirrors
   *  `fullscreenFilePath` but drives the LEFT pane. Transient (not persisted). */
  openFilePath: string | null;
  /** Prefill for the next CREATE-mode task form — set when spinning a new task
   *  out of selected result text, consumed by AddTaskForm. Cleared whenever the
   *  full-card view closes OR the user opens any other card / a blank "add task"
   *  create, so it never leaks into a later unrelated create. Transient. */
  newTaskSeed: NewTaskSeed | null;
  /** In-progress CREATE-mode task draft, persisted in the store so the new-task
   *  form survives a left-tab switch (the `task` tab unmounts on switch). Transient. */
  taskDraft: TaskDraft | null;
  /** The left tab that was active before a card was opened, so closing the
   *  full-card view returns the user where they were. Transient. */
  prevLeftTab: LeftTab;
  /** True while an agent is actively using the browser — drives the Browser tab
   *  badge so the user knows to flick over. Transient (not persisted). */
  browserActive: boolean;
  /** When set, the user has PINNED this agent's browser to the pane: auto-follow
   *  won't switch the on-screen view to another agent that acts. null = unpinned
   *  (the pane auto-follows whoever browses). Transient. */
  browserPinnedAgentId: string | null;
  godStatus: GodStatus;
  /** The compute backend the STT worker reported on its last model load (5z52). */
  sttBackend: SttBackend | null;
  /** True while a dictation is decoding (model ensure + transcribe). OfficeFloor pauses
   *  its Pixi render loop while set, so the office floor's WebGL rendering doesn't contend
   *  with the STT WebGPU/WASM compute for the shared GPU process. Transient (not persisted). */
  sttBusy: boolean;
  /** Per-agent outgoing message queue (agent id → messages awaiting delivery).
   *  Lets the user keep "talking" to a busy agent: messages park here and are
   *  drained to the terminal one-by-one once the agent is free. */
  messageQueues: Record<string, QueuedMessage[]>;
  /** Has the user engaged the floor this session (dispatched/queued a task)?
   *  Transient (not persisted) — starts false every launch. When auto-pilot is
   *  off, the inbox wake-nudge stays silent until this flips true, keeping
   *  startup passive until the user kicks something off. */
  floorStarted: boolean;
  startFloor: () => void;
  /** Per-agent tool-call count this session — a lightweight activity/usage proxy
   *  shown in the command center (interactive sessions don't expose billed $). */
  toolCounts: Record<string, number>;
  bumpToolCount: (id: string) => void;
  setGodStatus: (status: GodStatus) => void;
  setSttBackend: (b: SttBackend | null) => void;
  setSttBusy: (busy: boolean) => void;
  select: (id: string) => void;
  updateAgent: (id: string, patch: Partial<Agent>) => void;
  pushFeed: (id: string, line: string) => void;
  addAgent: (agent: Agent) => void;
  removeAgent: (id: string) => void;
  /** Archive an agent (its terminal was closed): move it from the active roster
   *  into `archivedAgents` with its PTY cleared. Retained + flagged, NOT deleted. */
  archiveAgent: (id: string) => void;
  /** Permanently forget an archived agent (drops the renderer entry only; the
   *  hive registry keeps its record). */
  removeArchivedAgent: (id: string) => void;
  /** Park a message for an agent. Returns nothing; the flush loop delivers it. */
  enqueueMessage: (agentId: string, text: string) => void;
  /** Drop a single queued message (user removed it, or it was just delivered). */
  removeQueuedMessage: (agentId: string, messageId: string) => void;
  /** Clear an agent's entire pending queue. */
  clearQueue: (agentId: string) => void;
  setAddAgentOpen: (open: boolean) => void;
  setFullscreen: (id: string | null) => void;
  setFullscreenFile: (path: string | null) => void;
  /** Open a file in the left-column transient `file` view (absolute path), or
   *  close it (null) and restore the previous tab — mirrors `openTask`. */
  setOpenFile: (path: string | null) => void;
  setSidebarWidth: (px: number) => void;
  setLeftTab: (tab: LeftTab) => void;
  /** Open a task's full card (a single editable view) in the left column,
   *  stashing the current tab to return to — or close it (null) and restore the
   *  previous tab. Use the `NEW_TASK_ID` sentinel as `id` to open CREATE mode. */
  openTask: (id: string | null) => void;
  /** Stash a prefill for the next CREATE-mode task form (used by "new task from
   *  selection"). Pass null to clear. */
  setNewTaskSeed: (seed: NewTaskSeed | null) => void;
  /** Replace the persisted CREATE-mode task draft (null to clear). */
  setTaskDraft: (draft: TaskDraft | null) => void;
  setBrowserActive: (active: boolean) => void;
  /** Pin (or unpin, with null) the browser pane to one agent's view. */
  setBrowserPinned: (agentId: string | null) => void;
  /** Drop persisted agents whose PTY is no longer alive in the main process.
   *  Called once at startup so a renderer reload (e.g. after the laptop sleeps)
   *  restores still-running agents and only removes truly-dead ones. */
  reconcileWithLivePtys: (livePtyIds: string[]) => void;
  /** Load this project's persisted agents/queues/selection (scoped per project) and
   *  swap them into the store. Called once the renderer learns activeProjectPath, so
   *  switching projects never bleeds one team's roster into another. Idempotent. */
  hydrateForProject: (projectPath: string) => void;
}

const LS_SIDEBAR_WIDTH = 'cth.sidebarWidth';
const LS_LEFT_TAB = 'cth.leftTab';
const LS_AGENTS = 'cth.agents';
const LS_ARCHIVED = 'cth.archivedAgents';
const LS_SELECTED = 'cth.selectedId';
const LS_QUEUES = 'cth.messageQueues';

// Per-project persistence: agents / queues / selection are scoped to the ACTIVE
// project so switching never bleeds one team's roster into another. `currentProjectKey`
// is set by hydrateForProject() once the renderer learns activeProjectPath; until then
// the persist helpers below no-op (nothing mutates agents before hydration). The UI
// prefs `cth.sidebarWidth` / `cth.leftTab` stay global on purpose — not per-project.
let currentProjectKey: string | null = null;
/** Scope a base key to the active project, or null before hydration. */
function scopedKey(base: string): string | null {
  return currentProjectKey ? `${base}::${currentProjectKey}` : null;
}
/** One-time migration from the pre-scoping global keys into the current project's
 *  scoped keys (the globals belonged to whatever project was active when they were
 *  written = this project at upgrade time), then drop the globals. Call AFTER
 *  currentProjectKey is set. */
function migrateLegacyAgentKeys(): void {
  try {
    if (window.localStorage.getItem(LS_AGENTS) === null) return; // already migrated / fresh
    for (const base of [LS_AGENTS, LS_ARCHIVED, LS_SELECTED, LS_QUEUES]) {
      const legacy = window.localStorage.getItem(base);
      const to = scopedKey(base);
      if (legacy !== null && to && window.localStorage.getItem(to) === null) {
        window.localStorage.setItem(to, legacy);
      }
      window.localStorage.removeItem(base);
    }
  } catch { /* noop */ }
}

// Fields that are large or transient — not worth persisting across reloads.
type PersistedAgent = Omit<Agent, 'recentAssistantText' | 'recentTextTs' | 'blockReason'>;

function persistAgents(agents: Agent[], selectedId: string | null): void {
  const aKey = scopedKey(LS_AGENTS), sKey = scopedKey(LS_SELECTED);
  if (!aKey || !sKey) return; // not hydrated yet → nothing to scope to
  try {
    const slim: PersistedAgent[] = agents.map(({ recentAssistantText, recentTextTs, blockReason, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason;
      return rest;
    });
    window.localStorage.setItem(aKey, JSON.stringify(slim));
    window.localStorage.setItem(sKey, selectedId ?? '');
  } catch { /* noop */ }
}

function loadPersistedAgents(): Agent[] {
  const key = scopedKey(LS_AGENTS);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
    // Reset volatile run-state; the PTY stream / mock loop will repopulate it.
    return parsed.map((a) => ({
      ...a,
      status: 'idle',
      action: 'reconnecting…',
      currentStation: 'desk',
      carrying: undefined,
      recentTextTs: Date.now(),
    }));
  } catch {
    return [];
  }
}

function persistArchived(archived: Agent[]): void {
  const key = scopedKey(LS_ARCHIVED);
  if (!key) return;
  try {
    const slim: PersistedAgent[] = archived.map(({ recentAssistantText, recentTextTs, blockReason, ...rest }) => {
      void recentAssistantText; void recentTextTs; void blockReason;
      return rest;
    });
    window.localStorage.setItem(key, JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedArchived(): Agent[] {
  const key = scopedKey(LS_ARCHIVED);
  if (!key) return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as PersistedAgent[];
    if (!Array.isArray(parsed)) return [];
    // Archived agents have no live process — force the flag + clear run-state.
    return parsed.map((a) => ({
      ...a,
      archived: true,
      status: 'idle',
      ptyId: undefined,
      carrying: undefined,
      currentStation: undefined
    }));
  } catch {
    return [];
  }
}

function persistQueues(queues: Record<string, QueuedMessage[]>): void {
  const key = scopedKey(LS_QUEUES);
  if (!key) return;
  try {
    // Only keep non-empty queues so the key stays small.
    const slim: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(queues)) if (q.length) slim[id] = q;
    window.localStorage.setItem(key, JSON.stringify(slim));
  } catch { /* noop */ }
}

function loadPersistedQueues(): Record<string, QueuedMessage[]> {
  const key = scopedKey(LS_QUEUES);
  if (!key) return {};
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, QueuedMessage[]>;
    if (!parsed || typeof parsed !== 'object') return {};
    // Defensively keep only well-formed entries.
    const out: Record<string, QueuedMessage[]> = {};
    for (const [id, q] of Object.entries(parsed)) {
      if (Array.isArray(q)) {
        out[id] = q.filter((m) => m && typeof m.text === 'string' && typeof m.id === 'string');
      }
    }
    return out;
  } catch {
    return {};
  }
}

function loadPersistedSelectedId(agents: Agent[]): string | null {
  const key = scopedKey(LS_SELECTED);
  try {
    const id = key ? window.localStorage.getItem(key) : null;
    return id && agents.some((a) => a.id === id) ? id : (agents[0]?.id ?? null);
  } catch {
    return agents[0]?.id ?? null;
  }
}
const initialSidebarWidth = (() => {
  try {
    const v = window.localStorage.getItem(LS_SIDEBAR_WIDTH);
    const n = v ? parseInt(v, 10) : NaN;
    if (!Number.isNaN(n) && n >= 320 && n <= 1200) return n;
  } catch { /* noop */ }
  // No saved width → open with an even 50/50 split. The split container has 16px
  // padding on each side and a 10px divider, so each pane = (viewport − 42) / 2.
  // Clamp to the same [320, 1200] bounds the splitter + persistence use.
  try {
    const half = Math.round((window.innerWidth - 42) / 2);
    return Math.min(1200, Math.max(320, half));
  } catch { /* noop */ }
  return 420;
})();
const initialLeftTab: LeftTab = (() => {
  try {
    const v = window.localStorage.getItem(LS_LEFT_TAB);
    if (v === 'office' || v === 'terminal' || v === 'browser'
      || v === 'messages') return v;
  } catch { /* noop */ }
  return 'office';
})();

// Agents/queues/selection are NOT loaded at module init anymore — the active project
// isn't known yet (it arrives async via getConfig). The store starts empty and is
// filled by hydrateForProject() once App learns activeProjectPath. See store.ts header.
let queuedSeq = 0;
/** Process-unique id for a queued message (timestamp + counter avoids collisions
 *  when several are queued within the same millisecond). */
function newQueuedId(): string {
  queuedSeq += 1;
  return `q-${Date.now()}-${queuedSeq}`;
}

export const useStore = create<State>((set) => ({
  agents: [],
  archivedAgents: [],
  selectedId: null,
  feeds: {},
  addAgentOpen: false,
  fullscreenAgentId: null,
  fullscreenFilePath: null,
  sidebarWidth: initialSidebarWidth,
  leftTab: initialLeftTab,
  openTaskId: null,
  openFilePath: null,
  newTaskSeed: null,
  taskDraft: null,
  prevLeftTab: initialLeftTab,
  browserActive: false,
  browserPinnedAgentId: null,
  godStatus: 'booting',
  sttBackend: null,
  sttBusy: false,
  messageQueues: {},
  floorStarted: false,
  startFloor: () => set({ floorStarted: true }),
  toolCounts: {},
  bumpToolCount: (id) =>
    set((s) => ({ toolCounts: { ...s.toolCounts, [id]: (s.toolCounts[id] ?? 0) + 1 } })),
  setGodStatus: (status) => set({ godStatus: status }),
  setSttBackend: (b) => set({ sttBackend: b }),
  setSttBusy: (busy) => set({ sttBusy: busy }),
  hydrateForProject: (projectPath) => {
    const key = projectPath || '';
    if (currentProjectKey === key) return; // already hydrated for this project
    currentProjectKey = key;
    migrateLegacyAgentKeys();
    const agents = loadPersistedAgents();
    const archivedAgents = loadPersistedArchived();
    const selectedId = loadPersistedSelectedId(agents);
    const messageQueues = loadPersistedQueues();
    const feeds: Record<string, string[]> = {};
    for (const a of agents) feeds[a.id] = [];
    set({ agents, archivedAgents, selectedId, messageQueues, feeds });
  },
  select: (id) => set((s) => { persistAgents(s.agents, id); return { selectedId: id }; }),
  updateAgent: (id, patch) =>
    set((s) => ({ agents: s.agents.map(a => a.id === id ? { ...a, ...patch } : a) })),
  pushFeed: (id, line) =>
    set((s) => ({ feeds: { ...s.feeds, [id]: [...(s.feeds[id] ?? []), line] } })),
  addAgent: (agent) =>
    set((s) => {
      const agents = [...s.agents, agent];
      // Re-spawning an archived agent un-archives it: an id is active xor archived.
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== agent.id);
      persistAgents(agents, agent.id);
      persistArchived(archivedAgents);
      return {
        agents,
        archivedAgents,
        selectedId: agent.id,
        feeds: { ...s.feeds, [agent.id]: s.feeds[agent.id] ?? [] }
      };
    }),
  removeAgent: (id) =>
    set((s) => {
      const agents = s.agents.filter(a => a.id !== id);
      const { [id]: _gone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      persistAgents(agents, selectedId);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, feeds, selectedId, messageQueues };
    }),
  archiveAgent: (id) =>
    set((s) => {
      const target = s.agents.find((a) => a.id === id);
      if (!target) return s;
      const agents = s.agents.filter((a) => a.id !== id);
      // Retain a flagged copy; the PTY is gone, so clear all live run-state.
      const archivedEntry: Agent = {
        ...target,
        archived: true,
        ptyId: undefined,
        status: 'idle',
        action: 'archived',
        carrying: undefined,
        currentStation: undefined
      };
      const archivedAgents = [...s.archivedAgents.filter((a) => a.id !== id), archivedEntry];
      const { [id]: _feedGone, ...feeds } = s.feeds;
      const { [id]: _queueGone, ...messageQueues } = s.messageQueues;
      const selectedId = s.selectedId === id ? (agents[0]?.id ?? null) : s.selectedId;
      persistAgents(agents, selectedId);
      persistArchived(archivedAgents);
      if (_queueGone) persistQueues(messageQueues);
      return { agents, archivedAgents, feeds, selectedId, messageQueues };
    }),
  removeArchivedAgent: (id) =>
    set((s) => {
      if (!s.archivedAgents.some((a) => a.id === id)) return s;
      const archivedAgents = s.archivedAgents.filter((a) => a.id !== id);
      persistArchived(archivedAgents);
      return { archivedAgents };
    }),
  enqueueMessage: (agentId, text) =>
    set((s) => {
      const trimmed = text.trim();
      if (!trimmed) return s;
      const msg: QueuedMessage = { id: newQueuedId(), text: trimmed, ts: Date.now() };
      const messageQueues = { ...s.messageQueues, [agentId]: [...(s.messageQueues[agentId] ?? []), msg] };
      persistQueues(messageQueues);
      // The user (or an inbound Slack task) engaged the floor — let the wake-nudge
      // loop resume even when auto-pilot is off.
      return { messageQueues, floorStarted: true };
    }),
  removeQueuedMessage: (agentId, messageId) =>
    set((s) => {
      const current = s.messageQueues[agentId];
      if (!current) return s;
      const next = current.filter((m) => m.id !== messageId);
      const messageQueues = { ...s.messageQueues, [agentId]: next };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  clearQueue: (agentId) =>
    set((s) => {
      if (!s.messageQueues[agentId]?.length) return s;
      const messageQueues = { ...s.messageQueues, [agentId]: [] };
      persistQueues(messageQueues);
      return { messageQueues };
    }),
  reconcileWithLivePtys: (livePtyIds) =>
    set((s) => {
      const live = new Set(livePtyIds);
      // Keep agents with no PTY (synthetic), a still-alive PTY, OR any non-archived
      // agent — those get RE-SPAWNED on startup (god/assistant via useProject effects
      // #1/#1b, manually-added workers via #1d). Pruning a dead worker here would
      // orphan its inbox (the Kevin-zombie bug); only archived dead agents are dropped.
      const agents = s.agents.filter((a) => !a.ptyId || live.has(a.ptyId) || !a.archived);
      if (agents.length === s.agents.length) return s;
      const feeds: Record<string, string[]> = {};
      for (const a of agents) feeds[a.id] = s.feeds[a.id] ?? [];
      const selectedId = agents.some((a) => a.id === s.selectedId)
        ? s.selectedId
        : (agents[0]?.id ?? null);
      persistAgents(agents, selectedId);
      return { agents, feeds, selectedId };
    }),
  setAddAgentOpen: (open) => set({ addAgentOpen: open }),
  setFullscreen: (id) => set({ fullscreenAgentId: id }),
  setFullscreenFile: (path) => set({ fullscreenFilePath: path }),
  setSidebarWidth: (px) => {
    const clamped = Math.min(1200, Math.max(320, Math.round(px)));
    try { window.localStorage.setItem(LS_SIDEBAR_WIDTH, String(clamped)); } catch { /* noop */ }
    set({ sidebarWidth: clamped });
  },
  setLeftTab: (tab) => {
    // The transient `task` / `file` views are never persisted — a reload must
    // never land on a full-card view for a task or a file path that may no longer
    // exist (initialLeftTab's whitelist also excludes them as a second line of
    // defense).
    if (tab !== 'task' && tab !== 'file') {
      try { window.localStorage.setItem(LS_LEFT_TAB, tab); } catch { /* noop */ }
    }
    set({ leftTab: tab });
  },
  openTask: (id) =>
    set((s) => {
      if (id === null) {
        // Closing always wipes any pending create-seed + draft so neither can leak
        // into a later unrelated CREATE opened from the board's "add task" button.
        return { openTaskId: null, leftTab: s.prevLeftTab, newTaskSeed: null, taskDraft: null };
      }
      // Stash the current real tab once so reopening doesn't lose it.
      const prevLeftTab = s.leftTab === 'task' ? s.prevLeftTab : s.leftTab;
      // Only a CREATE opened straight from a selection carries a seed; opening a
      // real card means the user left that pending create, so drop the seed
      // rather than let it leak into the next create. The draft is always reset
      // here too, so STARTING a create begins blank — RETURNING to an in-progress
      // one goes through setLeftTab('task'), which preserves the draft.
      return {
        openTaskId: id,
        leftTab: 'task',
        prevLeftTab,
        newTaskSeed: id === NEW_TASK_ID ? s.newTaskSeed : null,
        taskDraft: null
      };
    }),
  setOpenFile: (path) =>
    set((s) => {
      if (path === null) {
        // Closing returns to the tab the user was on before opening the file.
        return { openFilePath: null, leftTab: s.leftTab === 'file' ? s.prevLeftTab : s.leftTab };
      }
      // Stash the current real tab once so closing restores it — but don't stash
      // a transient view (task/file) as the "return to" tab.
      const prevLeftTab = (s.leftTab === 'task' || s.leftTab === 'file') ? s.prevLeftTab : s.leftTab;
      return { openFilePath: path, leftTab: 'file', prevLeftTab };
    }),
  setNewTaskSeed: (seed) => set({ newTaskSeed: seed }),
  setTaskDraft: (draft) => set({ taskDraft: draft }),
  setBrowserActive: (active) => set({ browserActive: active }),
  setBrowserPinned: (agentId) => set({ browserPinnedAgentId: agentId })
}));

export function selectedAgent(s: State): Agent | undefined {
  return s.agents.find(a => a.id === s.selectedId);
}
