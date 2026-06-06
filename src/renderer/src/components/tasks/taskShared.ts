// Shared task types, constants, and pure helpers for the Kanban board
// (TasksKanban) and the full-card detail view (TaskDetailPanel). Extracted so
// both surfaces import one canonical source instead of re-declaring drift-prone
// copies. Nothing here is React — just data shapes + normalization.

/** A short agent-posted status note shown on a card (mirrors main/preload TaskUpdate). */
export interface TaskUpdate {
  ts: string;
  by: string;
  kind: 'doing' | 'blocked' | 'needs-approval' | 'done' | 'note';
  text: string;
}

/** A file or image the human attached to a task. The binary lives on disk under
 *  `<projectRoot>/attachments/<taskId>/`; only this reference is stored in
 *  tasks.json. `path` is RELATIVE to the project root (e.g.
 *  `attachments/<taskId>/<file>`); written by the `attachment:write` IPC and read
 *  back as a data: URL by `attachment:read` for thumbnails. */
export interface TaskAttachment {
  name: string;
  path: string;
  kind: 'image' | 'file';
}

/** A card on the task kanban. Mirrors ProjectTask in the main/preload process —
 *  re-declared locally so the renderer doesn't reach into the preload package
 *  (same convention as store/config.ts). Structurally compatible with
 *  window.cth.projectWriteTasks. */
export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'needs-approval' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** Agent status notes (display-only here; the harness owns the truth on disk). */
  updates?: TaskUpdate[];
  /** ISO of the last status change — stamped on a manual move/edit so the
   *  main-process merge keeps whichever of human/agent changed status last. */
  statusUpdatedAt?: string;
  /** ISO of the last assignee change — its own recency clock (decoupled from
   *  statusUpdatedAt). Stamped by the renderer on a reassign and by the harness on
   *  an agent's 'doing' claim, so the merge keeps the latest assignee writer. */
  assigneeUpdatedAt?: string;
  /** ISO of the last UI dispatch — hides the dispatch button until the task's
   *  status next changes (re-nudgeable when blocked). */
  dispatchedAt?: string;
  /** Human-set: hidden from the 4 columns and shown in the ARCHIVED section.
   *  Independent of `status`, so restoring returns the card to its column. */
  archived?: boolean;
  /** ISO of the last time the human opened this card's full view. Drives the
   *  unread/"just finished" indicator: any update newer than this is unread.
   *  Round-trips via the writeTasks `...t` spread + the parseTasks whitelist. */
  viewedAt?: string;
  /** Files/images the human pasted or attached. Binary lives on disk under
   *  `attachments/<id>/`; only these references persist here. Load-bearing in
   *  parseTasks's whitelist — drop it there and the 5s poll wipes attachments. */
  attachments?: TaskAttachment[];
  /** Human-set: when true, dispatch tells the agent to PRODUCE A PLAN (not
   *  implement) and park the task in NEEDS APPROVAL for sign-off (see
   *  useTasks.dispatchTask). Round-trips via the writeTasks `...t` spread + the
   *  parseTasks whitelist — drop it there and the 5s poll clears the flag. */
  planMode?: boolean;
}

export type Status = ProjectTask['status'];

/** A card is "stale" if it was dispatched but has shown no activity for a while —
 *  the safety net for cards that stall despite the auto-advance (e.g. a dead agent
 *  that never posts a status update). Only in-flight columns can go stale
 *  (todo/doing); blocked/done/needs-approval are deliberately parked, not stalled.
 *  20 minutes with no newer of {statusUpdatedAt, dispatchedAt, last update ts}. */
export const STALE_AFTER_MS = 20 * 60 * 1000;

export function isTaskStale(task: ProjectTask, now: number = Date.now()): boolean {
  if (task.archived) return false;
  if (task.status !== 'todo' && task.status !== 'doing') return false;
  if (!task.dispatchedAt) return false;
  const ups = task.updates ?? [];
  const lastUpdateTs = ups.length ? ups[ups.length - 1].ts : undefined;
  const latest = Math.max(
    Date.parse(task.statusUpdatedAt ?? '') || 0,
    Date.parse(task.dispatchedAt) || 0,
    lastUpdateTs ? (Date.parse(lastUpdateTs) || 0) : 0
  );
  return latest > 0 && latest < now - STALE_AFTER_MS;
}

/** Whether the dispatch button should show. Dispatchable columns only
 *  (todo/blocked), and hidden once dispatched until the task's status changes
 *  again — so a freshly dispatched card can't be re-dispatched, but a stuck or
 *  blocked one stays re-nudgeable. A STALE card is ALWAYS re-nudgeable (even when
 *  status==='doing'), so a stalled card can be kicked again. ISO-8601 UTC strings
 *  compare chronologically as plain strings (same convention the writeTasks merge
 *  relies on). */
export function canDispatchTask(task: ProjectTask): boolean {
  if (isTaskStale(task)) return true;
  if (task.status !== 'todo' && task.status !== 'blocked') return false;
  const dispatched = !!task.dispatchedAt
    && (!task.statusUpdatedAt || task.statusUpdatedAt <= task.dispatchedAt);
  return !dispatched;
}

export const COLUMNS: { key: Status; label: string; accent: string }[] = [
  { key: 'todo',    label: 'TODO',    accent: 'var(--cth-sky)' },
  { key: 'doing',   label: 'DOING',   accent: 'var(--cth-lemon)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)' },
  { key: 'done',    label: 'DONE',    accent: 'var(--cth-mint)' }
];

/** 'needs-approval' is a first-class status but NOT a top-level column: it renders
 *  as the TOP sub-section of the BLOCKED column (a waiting-for-human state — e.g. a
 *  plan-mode agent parks its task here for sign-off). Kept out of COLUMNS so the
 *  board stays 4 columns, but described here so the board sub-header, the per-card
 *  lane <select>, and the detail-panel badge all share one label + accent. */
export const NEEDS_APPROVAL: { key: Status; label: string; accent: string } = {
  key: 'needs-approval', label: 'NEEDS APPROVAL', accent: 'var(--cth-lilac)'
};

export const POLL_MS = 5000;

/** Accent per agent-reported update kind (matches the column accents). */
export const UPDATE_COLOR: Record<TaskUpdate['kind'], string> = {
  doing: 'var(--cth-lemon)',
  blocked: 'var(--cth-coral)',
  // Matches the NEEDS_APPROVAL sub-section accent so a plan-mode park reads lilac.
  'needs-approval': 'var(--cth-lilac)',
  done: 'var(--cth-mint)',
  note: 'var(--cth-ink-500)'
};

/** A scheduled auto-dispatch for a task. Mirrors ScheduledMission in
 *  main/config.ts and preload/index.ts — keep the three in sync. Here it is
 *  always task-linked (taskId set); label/to are a snapshot the scheduler
 *  refreshes from the live task at fire time. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  lastFiredAt?: number;
  taskId?: string;
  mode?: 'recurring' | 'once';
  runAt?: number;
}

/** What the SCHEDULE controls in the task form resolve to on submit. */
export type ScheduleSpec =
  | { mode: 'none' }
  | { mode: 'once'; runAt: number }
  | { mode: 'recurring'; intervalMs: number; enabled: boolean };

/** Recurring interval presets (ms) — shown in the form and as card badges. */
export const INTERVAL_OPTS: { ms: number; label: string }[] = [
  { ms: 3600000, label: '1h' },
  { ms: 21600000, label: '6h' },
  { ms: 86400000, label: '24h' },
  { ms: 604800000, label: 'weekly' }
];

export const intervalLabel = (ms: number): string =>
  INTERVAL_OPTS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 3600000)}h`;

/** epoch ms → `YYYY-MM-DDTHH:mm` in LOCAL time for <input type="datetime-local">. */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** epoch ms → compact local stamp for a card badge (e.g. "Jun 7, 14:30"). */
export function shortWhen(ms?: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function shortId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
export function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Keep only well-formed agent updates (display-only; the harness owns the truth). */
export function parseUpdates(raw: unknown): TaskUpdate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kinds = ['doing', 'blocked', 'needs-approval', 'done', 'note'] as const;
  const out = raw.filter((u): u is TaskUpdate =>
    !!u && typeof u === 'object'
    && typeof (u as TaskUpdate).text === 'string'
    && typeof (u as TaskUpdate).by === 'string'
    && kinds.includes((u as TaskUpdate).kind));
  return out.length ? out.slice(-20) : undefined;
}

/** Keep only well-formed attachment references (name + rel path + image|file). */
export function parseAttachments(raw: unknown): TaskAttachment[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out = raw.filter((a): a is TaskAttachment =>
    !!a && typeof a === 'object'
    && typeof (a as TaskAttachment).name === 'string'
    && typeof (a as TaskAttachment).path === 'string'
    && ((a as TaskAttachment).kind === 'image' || (a as TaskAttachment).kind === 'file'));
  return out.length ? out : undefined;
}

/** Whether a task has agent activity the human hasn't seen yet: it has at least
 *  one update whose timestamp is newer than the last time the card was opened
 *  (`viewedAt`). Covers "just finished" (a fresh `done` update) and any progress
 *  note since the last view. ISO strings compare chronologically as plain strings
 *  (the same convention writeTasks/canDispatchTask rely on). */
export function isTaskUnread(task: ProjectTask): boolean {
  const ups = task.updates ?? [];
  if (ups.length === 0) return false;
  const newest = ups[ups.length - 1].ts ?? '';
  return newest > (task.viewedAt ?? '');
}

/** Knowledge deliverables this task references — the bare `knowledge/<file>.md`
 *  paths the agent named in the description or any update. Returns slugs (filename
 *  without `.md`), de-duped in first-seen order, for the RESULT section to load via
 *  `knowledgeGet()`. Text-based by design: a deliverable the agent never named in an
 *  update won't be detected (acceptable — agents cite the file they wrote). */
export function extractDeliverableSlugs(task: ProjectTask): string[] {
  const haystack = [task.description ?? '', ...(task.updates ?? []).map((u) => u.text)].join('\n');
  const re = /knowledge\/([\w.-]+)\.md\b/gi;
  const out: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    const slug = m[1].toLowerCase();
    if (!seen.has(slug)) { seen.add(slug); out.push(slug); }
  }
  return out;
}

/** Normalize whatever hive:tasks returns into a typed task array. */
export function parseTasks(raw: unknown): ProjectTask[] {
  const list = (raw && typeof raw === 'object' && Array.isArray((raw as { tasks?: unknown }).tasks))
    ? (raw as { tasks: unknown[] }).tasks
    : [];
  return list
    .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
    .map((t, i) => ({
      id: typeof t.id === 'string' && t.id
        ? t.id
        : stableId(`${typeof t.title === 'string' ? t.title : ''}|${typeof t.createdAt === 'string' ? t.createdAt : ''}|${i}`),
      title: typeof t.title === 'string' ? t.title : '(untitled)',
      description: typeof t.description === 'string' ? t.description : undefined,
      assignee: typeof t.assignee === 'string' ? t.assignee : undefined,
      status: (['todo', 'doing', 'blocked', 'needs-approval', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      updates: parseUpdates(t.updates),
      statusUpdatedAt: typeof t.statusUpdatedAt === 'string' ? t.statusUpdatedAt : undefined,
      // Load-bearing: drop this on poll and the assignee-recency merge loses its clock.
      assigneeUpdatedAt: typeof t.assigneeUpdatedAt === 'string' ? t.assigneeUpdatedAt : undefined,
      dispatchedAt: typeof t.dispatchedAt === 'string' ? t.dispatchedAt : undefined,
      // Load-bearing: drop this on poll and the next human persist() un-archives.
      archived: t.archived === true ? true : undefined,
      // Load-bearing: drop this on poll and the unread indicator never settles.
      viewedAt: typeof t.viewedAt === 'string' ? t.viewedAt : undefined,
      // Load-bearing: drop this on poll and the next human persist() wipes attachments.
      attachments: parseAttachments(t.attachments),
      // Load-bearing: drop this on poll and the 5s poll clears the plan-mode flag.
      planMode: t.planMode === true ? true : undefined
    }));
}
