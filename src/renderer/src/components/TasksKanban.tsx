import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { MicButton } from './MicButton';
import { useStore } from '@/store/store';

/** A short agent-posted status note shown on a card (mirrors main/preload TaskUpdate). */
export interface TaskUpdate {
  ts: string;
  by: string;
  kind: 'doing' | 'blocked' | 'done' | 'note';
  text: string;
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
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** Agent status notes (display-only here; the harness owns the truth on disk). */
  updates?: TaskUpdate[];
  /** ISO of the last status change — stamped on a manual move/edit so the
   *  main-process merge keeps whichever of human/agent changed status last. */
  statusUpdatedAt?: string;
  /** Human-set: hidden from the 4 columns and shown in the ARCHIVED section.
   *  Independent of `status`, so restoring returns the card to its column. */
  archived?: boolean;
}

type Status = ProjectTask['status'];

const COLUMNS: { key: Status; label: string; accent: string }[] = [
  { key: 'todo',    label: 'TODO',    accent: 'var(--cth-sky)' },
  { key: 'doing',   label: 'DOING',   accent: 'var(--cth-lemon)' },
  { key: 'blocked', label: 'BLOCKED', accent: 'var(--cth-coral)' },
  { key: 'done',    label: 'DONE',    accent: 'var(--cth-mint)' }
];

const POLL_MS = 5000;

/** A scheduled auto-dispatch for a task. Mirrors ScheduledMission in
 *  main/config.ts and preload/index.ts — keep the three in sync. Here it is
 *  always task-linked (taskId set); label/to are a snapshot the scheduler
 *  refreshes from the live task at fire time. */
interface ScheduledMission {
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
type ScheduleSpec =
  | { mode: 'none' }
  | { mode: 'once'; runAt: number }
  | { mode: 'recurring'; intervalMs: number; enabled: boolean };

/** Recurring interval presets (ms) — shown in the form and as card badges. */
const INTERVAL_OPTS: { ms: number; label: string }[] = [
  { ms: 3600000, label: '1h' },
  { ms: 21600000, label: '6h' },
  { ms: 86400000, label: '24h' },
  { ms: 604800000, label: 'weekly' }
];

const intervalLabel = (ms: number): string =>
  INTERVAL_OPTS.find((o) => o.ms === ms)?.label ?? `${Math.round(ms / 3600000)}h`;

/** epoch ms → `YYYY-MM-DDTHH:mm` in LOCAL time for <input type="datetime-local">. */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** epoch ms → compact local stamp for a card badge (e.g. "Jun 7, 14:30"). */
function shortWhen(ms?: number): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function shortId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** Deterministic fallback id derived from a task's content (djb2 → base36).
 *  Used for tasks lacking a valid string id so re-parsing tasks.json on every
 *  5s poll yields the SAME id — no React key churn / card remount. Unlike
 *  shortId() (random, for brand-new tasks), this never changes across polls. */
function stableId(seed: string): string {
  let h = 5381;
  for (let i = 0; i < seed.length; i++) h = (((h << 5) + h) ^ seed.charCodeAt(i)) | 0;
  return `t-${(h >>> 0).toString(36)}`;
}

/** Keep only well-formed agent updates (display-only; the harness owns the truth). */
function parseUpdates(raw: unknown): TaskUpdate[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const kinds = ['doing', 'blocked', 'done', 'note'] as const;
  const out = raw.filter((u): u is TaskUpdate =>
    !!u && typeof u === 'object'
    && typeof (u as TaskUpdate).text === 'string'
    && typeof (u as TaskUpdate).by === 'string'
    && kinds.includes((u as TaskUpdate).kind));
  return out.length ? out.slice(-20) : undefined;
}

/** Normalize whatever hive:tasks returns into a typed task array. */
function parseTasks(raw: unknown): ProjectTask[] {
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
      status: (['todo', 'doing', 'blocked', 'done'] as const).includes(t.status as Status)
        ? (t.status as Status) : 'todo',
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.filter((d): d is string => typeof d === 'string') : [],
      priority: typeof t.priority === 'number' ? t.priority : 3,
      createdAt: typeof t.createdAt === 'string' ? t.createdAt : new Date().toISOString(),
      updates: parseUpdates(t.updates),
      statusUpdatedAt: typeof t.statusUpdatedAt === 'string' ? t.statusUpdatedAt : undefined,
      // Load-bearing: drop this on poll and the next human persist() un-archives.
      archived: t.archived === true ? true : undefined
    }));
}

/**
 * Task kanban over hive/tasks.json. Polls every 5s, lets the human add tasks
 * (assignee from the live roster, priority, dependsOn), and dispatch a card
 * directly to its assignee's inbox — the board is the dispatch control surface.
 */
export function TasksKanban() {
  const agents = useStore((s) => s.agents);
  const [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [adding, setAdding] = useState(false);
  // Transient feedback from a card/create dispatch (auto-clears after 5s).
  const [dispatchMsg, setDispatchMsg] = useState<string | null>(null);
  // The task currently open in the edit form (null = not editing). Mutually
  // exclusive with `adding` — the same inline form serves both.
  const [editing, setEditing] = useState<ProjectTask | null>(null);
  // Task schedules — these live in main-process config (the scheduler owns them).
  const [missions, setMissions] = useState<ScheduledMission[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    try { setTasks(parseTasks(await window.cth.projectTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    refresh();
    timer.current = setInterval(refresh, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [refresh]);

  // An agent posting a task-update flips the card live (~1.5s) instead of waiting
  // on the 5s poll: re-pull so the view stays byte-identical to disk.
  useEffect(() => window.cth.onProjectTaskUpdated(() => refresh()), [refresh]);

  // Load schedules once, then re-list whenever one fires so a spent one-shot
  // flips to "fired" on its card without a manual refresh.
  useEffect(() => {
    const load = (): void => { window.cth.listMissions().then(setMissions).catch(() => { /* noop */ }); };
    load();
    return window.cth.onSchedulerFired(() => load());
  }, []);

  const persist = useCallback(async (next: ProjectTask[]) => {
    setTasks(next); // optimistic
    try { await window.cth.projectWriteTasks(next); } catch { refresh(); }
  }, [refresh]);

  const persistMissions = useCallback(async (next: ScheduledMission[]) => {
    setMissions(next); // optimistic
    try { await window.cth.saveMissions(next); } catch { /* noop */ }
  }, []);

  const missionFor = useCallback(
    (taskId: string): ScheduledMission | undefined => missions.find((m) => m.taskId === taskId),
    [missions]
  );

  // Reconcile a task's linked schedule from the form's ScheduleSpec: 'none'
  // drops any existing mission; otherwise upsert one keyed to the task. The
  // scheduler re-reads the live task at fire time, so label/to here are only a
  // best-effort snapshot. A freshly-set one-time fire clears lastFiredAt so it
  // can arm; recurring keeps its cadence (lastFiredAt) across edits.
  const syncTaskMission = useCallback((task: ProjectTask, spec: ScheduleSpec) => {
    const existing = missions.find((m) => m.taskId === task.id);
    if (spec.mode === 'none') {
      if (existing) persistMissions(missions.filter((m) => m.id !== existing.id));
      return;
    }
    const next: ScheduledMission = {
      id: existing?.id ?? `m_${Date.now().toString(36)}`,
      taskId: task.id,
      label: task.title,
      to: task.assignee ?? 'god',
      body: '',
      mode: spec.mode,
      intervalMs: spec.mode === 'recurring' ? spec.intervalMs : 0,
      runAt: spec.mode === 'once' ? spec.runAt : undefined,
      enabled: spec.mode === 'recurring' ? spec.enabled : true,
      lastFiredAt: spec.mode === 'recurring' ? existing?.lastFiredAt : undefined
    };
    persistMissions(existing
      ? missions.map((m) => (m.id === existing.id ? next : m))
      : [...missions, next]);
  }, [missions, persistMissions]);

  const addTask = useCallback((t: ProjectTask, schedule: ScheduleSpec) => {
    persist([...tasks, t]);
    syncTaskMission(t, schedule);
    setAdding(false);
  }, [tasks, persist, syncTaskMission]);

  // Replace a task in place. Preserve harness-owned `updates` (the form never
  // carries them) and only re-stamp `statusUpdatedAt` when the human actually
  // changed the column, so the main-process merge keeps the latest writer.
  const saveEdit = useCallback((t: ProjectTask, schedule: ScheduleSpec) => {
    persist(tasks.map((x) => (x.id === t.id
      ? { ...t, updates: x.updates, statusUpdatedAt: x.status === t.status ? x.statusUpdatedAt : new Date().toISOString() }
      : x)));
    syncTaskMission(t, schedule);
    setEditing(null);
  }, [tasks, persist, syncTaskMission]);

  const deleteTask = useCallback((id: string) => {
    const m = missions.find((x) => x.taskId === id);
    if (m) persistMissions(missions.filter((x) => x.id !== m.id)); // drop its schedule too
    persist(tasks.filter((x) => x.id !== id)); // dropping the task drops its updates — intended
    setEditing(null);
  }, [tasks, persist, missions, persistMissions]);

  const moveTask = useCallback((id: string, status: Status) => {
    persist(tasks.map((t) => (t.id === id ? { ...t, status, statusUpdatedAt: new Date().toISOString() } : t)));
  }, [tasks, persist]);

  // Archive: hide the card from the board (kept on disk, restorable) and drop its
  // linked schedule so it stops auto-dispatching — same mission cleanup as delete.
  // Status is left untouched so a restore returns it to its original column.
  const archiveTask = useCallback((id: string) => {
    const m = missions.find((x) => x.taskId === id);
    if (m) persistMissions(missions.filter((x) => x.id !== m.id));
    persist(tasks.map((t) => (t.id === id ? { ...t, archived: true } : t)));
    setEditing(null);
  }, [tasks, persist, missions, persistMissions]);

  const unarchiveTask = useCallback((id: string) => {
    persist(tasks.map((t) => (t.id === id ? { ...t, archived: false } : t)));
  }, [tasks, persist]);

  // Send a card straight to its assignee's inbox (Michael if unassigned). Embeds
  // [task:id] so the worker can post status updates back onto THIS card, and
  // flips the floor started so the inbox wake-nudge loop delivers it even when
  // auto-pilot is off (same gate the old Floor dispatch box relied on).
  const dispatchTask = useCallback(async (t: ProjectTask) => {
    const desc = t.description?.trim() ? t.description.trim() : '(no description)';
    const to = t.assignee ?? 'god';
    const body = `Task: ${t.title} [task:${t.id}]\nContext: ${desc}\n`;
    const res = await window.cth.projectSend(
      { to, act: 'request', subject: 'Task from you', body }, 'human');
    if (!res.ok) {
      setDispatchMsg(`dispatch failed: ${res.error ?? '?'}`);
    } else {
      useStore.getState().startFloor();
      const name = to === 'god' ? 'Michael' : (agents.find((a) => a.id === to)?.name ?? to);
      setDispatchMsg((res.delivered ?? 0) === 0
        ? '⚠ no active agent received this'
        : `dispatched to ${name}`);
    }
    setTimeout(() => setDispatchMsg(null), 5000);
  }, [agents]);

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

  // Archived tasks live off the board (their own collapsible section); the four
  // columns and the toolbar count only ever see the active set.
  const active = tasks.filter((t) => !t.archived);
  const archived = tasks.filter((t) => t.archived);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {active.length} task{active.length === 1 ? '' : 's'}{archived.length > 0 ? ` · ${archived.length} archived` : ''}
        </span>
        {dispatchMsg && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{dispatchMsg}</span>}
        <PixelButton
          variant={adding ? 'secondary' : 'primary'}
          size="sm"
          onClick={() => { setEditing(null); setAdding((v) => !v); }}
          style={{ marginLeft: 'auto' }}
        >
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name={adding ? 'x' : 'plus'} /> {adding ? 'cancel' : 'add task'}
          </span>
        </PixelButton>
      </div>

      {(adding || editing) && (
        <AddTaskForm
          key={editing?.id ?? 'new'}
          agents={agents}
          existing={editing ? tasks.filter((t) => t.id !== editing.id) : tasks}
          initial={editing ?? undefined}
          initialMission={editing ? missionFor(editing.id) : undefined}
          onCancel={() => { setAdding(false); setEditing(null); }}
          onSubmit={editing ? saveEdit : addTask}
          onCreateAndDispatch={editing ? undefined : (t, schedule) => { addTask(t, schedule); dispatchTask(t); }}
          onDelete={editing ? () => deleteTask(editing.id) : undefined}
          onArchive={editing ? () => archiveTask(editing.id) : undefined}
        />
      )}

      {/* Columns */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 10, overflowX: 'auto'
      }}>
        {COLUMNS.map((col) => {
          const cards = active.filter((t) => t.status === col.key);
          return (
            <div key={col.key} style={{
              flex: '1 1 0', minWidth: 170, display: 'flex', flexDirection: 'column',
              background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 4px',
                background: col.accent, boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
                fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
              }}>
                {col.label}
                <span style={{ marginLeft: 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>—</div>
                )}
                {cards.map((t) => (
                  <TaskCard
                    key={t.id}
                    task={t}
                    assigneeName={nameFor(t.assignee)}
                    mission={missionFor(t.id)}
                    onMove={(s) => moveTask(t.id, s)}
                    onDispatch={() => dispatchTask(t)}
                    onArchive={() => archiveTask(t.id)}
                    onEdit={() => { setAdding(false); setEditing(t); }}
                  />
                ))}
              </div>
            </div>
          );
        })}
      </div>

      <ArchivedTasksSection tasks={archived} onRestore={unarchiveTask} onDelete={deleteTask} />
    </div>
  );
}

// ─── Archived section — tasks filed off the board, restorable to their column
//     (mirrors AgentsTab's ArchivedSection) ──────────────────────────────────--

function ArchivedTasksSection({ tasks, onRestore, onDelete }: {
  tasks: ProjectTask[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
  return (
    <div style={{ flexShrink: 0, maxHeight: '38%', overflowY: 'auto', padding: '8px 10px 10px', borderTop: '1px solid var(--cth-ink-300)' }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>
        ARCHIVED ({tasks.length})
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
          marginBottom: open ? 6 : 0
        }}
      >{open ? '▾' : '▸'} {open ? 'hide' : 'show'} archived tasks</button>
      {open && tasks.map((t) => (
        <ArchivedTaskRow key={t.id} task={t} onRestore={() => onRestore(t.id)} onDelete={() => onDelete(t.id)} />
      ))}
    </div>
  );
}

function ArchivedTaskRow({ task, onRestore, onDelete }: {
  task: ProjectTask;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const last = task.updates?.length ? task.updates[task.updates.length - 1] : undefined;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: 6, marginBottom: 6, opacity: 0.7,
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
    }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{task.title}</div>
        {last && (
          <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ textTransform: 'uppercase', fontFamily: 'var(--cth-font-display)', fontSize: 8, marginRight: 4 }}>{last.kind}</span>{last.text}
          </div>
        )}
      </div>
      <button
        onClick={onRestore}
        title="Restore to its column"
        style={{
          flexShrink: 0, padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
        }}
      >restore</button>
      <button
        onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
        onBlur={() => setConfirmDelete(false)}
        title="Delete permanently"
        style={{
          flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 7px 1px',
          border: 'none', cursor: 'pointer',
          background: confirmDelete ? 'var(--cth-coral)' : 'transparent',
          boxShadow: confirmDelete ? 'inset 0 0 0 1px var(--cth-ink-900)' : 'none',
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: confirmDelete ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)'
        }}
      ><Icon name="x" />{confirmDelete ? ' confirm' : ''}</button>
    </div>
  );
}

// ─── Card ────────────────────────────────────────────────────────────────────

/** Accent per agent-reported update kind (matches the column accents). */
const UPDATE_COLOR: Record<TaskUpdate['kind'], string> = {
  doing: 'var(--cth-lemon)',
  blocked: 'var(--cth-coral)',
  done: 'var(--cth-mint)',
  note: 'var(--cth-ink-500)'
};

function TaskCard({ task, assigneeName, mission, onMove, onDispatch, onArchive, onEdit }: {
  task: ProjectTask;
  assigneeName?: string;
  mission?: ScheduledMission;
  onMove: (s: Status) => void;
  onDispatch: () => void;
  onArchive: () => void;
  onEdit: () => void;
}) {
  const pr = Math.max(1, Math.min(5, task.priority));
  // Dispatch sends the card to its assignee's inbox; once a task is moving
  // (doing) or finished (done) it's effectively already dispatched, so only
  // offer the button for not-yet-started (todo) or re-nudgeable (blocked) cards.
  const canDispatch = task.status === 'todo' || task.status === 'blocked';
  const [showHistory, setShowHistory] = useState(false);
  const updates = task.updates ?? [];
  const last = updates.length ? updates[updates.length - 1] : undefined;
  const hasHistory = updates.length > 1;
  // A human moved the card after the agent's last status note (e.g. reopened a
  // DONE card back to TODO): mute the now-stale TLDR so the card reads as its
  // new column instead of looking unchanged. History stays in the +n toggle.
  const staleUpdate = !!last && last.kind !== 'note'
    && last.kind !== task.status
    && (task.statusUpdatedAt ?? '') > (last.ts ?? '');
  const lastColor = last ? (staleUpdate ? 'var(--cth-ink-300)' : UPDATE_COLOR[last.kind]) : '';
  return (
    <div style={{
      padding: 7, background: 'var(--cth-paper-100)',
      boxShadow: last?.kind === 'blocked' ? 'inset 0 0 0 1px var(--cth-coral)' : 'inset 0 0 0 1px var(--cth-ink-700)',
      display: 'flex', flexDirection: 'column', gap: 5
    }}>
      {/* Title row — click to edit. Kept separate from the controls row below so
          the status select / dispatch button are never swallowed by this click. */}
      <div
        onClick={onEdit}
        role="button"
        title="Edit task"
        style={{ display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer' }}
      >
        <PriorityDots level={pr} />
        <span style={{
          flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 13,
          lineHeight: '16px', color: 'var(--cth-ink-900)'
        }}>{task.title}</span>
      </div>

      {/* Latest agent TLDR — its own click toggles the history (never edits). */}
      {last && (
        <>
          <div
            onClick={(e) => { e.stopPropagation(); if (hasHistory) setShowHistory((v) => !v); }}
            title={hasHistory ? 'Show update history' : last.text}
            style={{
              display: 'flex', alignItems: 'baseline', gap: 5, padding: '2px 5px',
              background: 'var(--cth-cream-100)', boxShadow: `inset 0 0 0 1px ${lastColor}`,
              cursor: hasHistory ? 'pointer' : 'default'
            }}
          >
            <span style={{
              fontFamily: 'var(--cth-font-display)', fontSize: 8, color: lastColor,
              flexShrink: 0, textTransform: 'uppercase'
            }}>{last.kind}</span>
            <span style={{
              flex: 1, minWidth: 0, fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-700)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: showHistory ? 'normal' : 'nowrap'
            }}>{last.text}</span>
            {hasHistory && (
              <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--cth-ink-300)' }}>{showHistory ? '▾' : `+${updates.length - 1}`}</span>
            )}
          </div>
          {showHistory && hasHistory && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '0 2px 2px' }}>
              {updates.slice(0, -1).reverse().map((u, i) => (
                <div key={i} style={{ display: 'flex', gap: 4, fontSize: 11, lineHeight: '14px', color: 'var(--cth-ink-500)' }}>
                  <span style={{ flexShrink: 0, color: UPDATE_COLOR[u.kind], textTransform: 'uppercase', fontSize: 8, fontFamily: 'var(--cth-font-display)', alignSelf: 'center' }}>{u.kind}</span>
                  <span style={{ minWidth: 0 }}>{u.text}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
        {assigneeName
          ? <PixelBadge status="working" label={assigneeName} />
          : <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>unassigned</span>}
        {task.dependsOn.length > 0 && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px 0',
            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)'
          }} title={`Depends on ${task.dependsOn.length} task(s)`}>
            <Icon name="arrow-right" /> {task.dependsOn.length}
          </span>
        )}
        {mission && (() => {
          const fired = mission.mode === 'once' && !!mission.lastFiredAt;
          const paused = !fired && mission.enabled === false;
          const text = mission.mode === 'once'
            ? (fired ? 'fired' : shortWhen(mission.runAt))
            : intervalLabel(mission.intervalMs);
          return (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px 0',
              background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 11,
              color: (fired || paused) ? 'var(--cth-ink-300)' : 'var(--cth-ink-700)'
            }} title={fired ? 'One-time schedule already fired'
              : paused ? 'Schedule paused'
              : mission.mode === 'once' ? 'Scheduled to auto-dispatch once' : 'Recurring auto-dispatch'}>
              <Icon name="bell" /> {text}{paused ? ' off' : ''}
            </span>
          );
        })()}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <select
          value={task.status}
          onChange={(e) => onMove(e.target.value as Status)}
          style={{
            flex: 1, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
            fontSize: 11, color: 'var(--cth-ink-900)', cursor: 'pointer'
          }}
        >
          {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>))}
        </select>
        {canDispatch && (
          <PixelButton variant="primary" size="sm" onClick={onDispatch}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="arrow-right" /> dispatch
            </span>
          </PixelButton>
        )}
        <button
          onClick={onArchive}
          title="Archive task (file it away — restorable from the ARCHIVED section)"
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
            padding: '3px 7px 2px', border: 'none', cursor: 'pointer',
            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            color: 'var(--cth-ink-900)'
          }}
        ><Icon name="folder" /></button>
      </div>
    </div>
  );
}

function PriorityDots({ level }: { level: number }) {
  // 1 = lowest, 5 = highest. Warmer fill as priority climbs.
  const color = level >= 4 ? 'var(--cth-coral)' : level === 3 ? 'var(--cth-lemon)' : 'var(--cth-mint)';
  return (
    <span title={`Priority ${level}/5`} style={{ display: 'inline-flex', gap: 1, flexShrink: 0, marginTop: 2 }}>
      {[1, 2, 3, 4, 5].map((i) => (
        <span key={i} style={{
          width: 4, height: 8,
          background: i <= level ? color : 'var(--cth-cream-200)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }} />
      ))}
    </span>
  );
}

// ─── Add-task form ─────────────────────────────────────────────────────────--

function AddTaskForm({ agents, existing, initial, initialMission, onCancel, onSubmit, onCreateAndDispatch, onDelete, onArchive }: {
  agents: { id: string; name: string; isGod?: boolean }[];
  existing: ProjectTask[];
  /** When set, the form edits this task instead of creating a new one. */
  initial?: ProjectTask;
  /** The task's current schedule, if any — seeds the SCHEDULE controls. */
  initialMission?: ScheduledMission;
  onCancel: () => void;
  onSubmit: (t: ProjectTask, schedule: ScheduleSpec) => void;
  /** Create the task and immediately dispatch it (new tasks only). */
  onCreateAndDispatch?: (t: ProjectTask, schedule: ScheduleSpec) => void;
  onDelete?: () => void;
  /** Archive the task being edited (reversible; existing tasks only). */
  onArchive?: () => void;
}) {
  const editing = !!initial;
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [assignee, setAssignee] = useState(initial?.assignee ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 3);
  const [deps, setDeps] = useState<string[]>(initial?.dependsOn ?? []);
  const [status, setStatus] = useState<Status>(initial?.status ?? 'todo');
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Schedule controls. A one-shot that already fired seeds as 'none' (it's done,
  // not still-pending); the user can pick a fresh time to re-arm it.
  const firedOnce = initialMission?.mode === 'once' && !!initialMission.lastFiredAt;
  const [schedMode, setSchedMode] = useState<'none' | 'once' | 'recurring'>(
    !initialMission || firedOnce ? 'none' : (initialMission.mode ?? 'recurring')
  );
  const [schedInterval, setSchedInterval] = useState(String(initialMission?.intervalMs || INTERVAL_OPTS[0].ms));
  const [schedAt, setSchedAt] = useState(
    initialMission?.runAt && !firedOnce ? toLocalInput(initialMission.runAt) : ''
  );
  const [schedEnabled, setSchedEnabled] = useState(
    initialMission?.mode === 'recurring' ? initialMission.enabled : true
  );
  // Enrich: the read-only assistant rewrites the description into a concrete,
  // self-contained task. `preEnrich` stashes the prior text for a single undo.
  const [enriching, setEnriching] = useState(false);
  const [preEnrich, setPreEnrich] = useState<string | null>(null);
  const [enrichError, setEnrichError] = useState<string | null>(null);

  // Deliberately omit `updates`/`statusUpdatedAt` — the form never carries
  // agent-owned data; the main-process writeTasks merge restores them from disk.
  const buildTask = (): ProjectTask => ({
    id: initial?.id ?? shortId(),
    title: title.trim(),
    description: description.trim() || undefined,
    assignee: assignee || undefined,
    status: editing ? status : 'todo',
    dependsOn: deps,
    priority,
    createdAt: initial?.createdAt ?? new Date().toISOString(),
    // Carry the archive flag through an edit so saving the form can't un-archive.
    archived: initial?.archived
  });

  const buildSchedule = (): ScheduleSpec => {
    if (schedMode === 'recurring') {
      return { mode: 'recurring', intervalMs: Number(schedInterval), enabled: schedEnabled };
    }
    if (schedMode === 'once') {
      const runAt = schedAt ? new Date(schedAt).getTime() : NaN; // local wall-clock → epoch ms
      // No / invalid time ⇒ treat as unscheduled rather than firing on NaN.
      return Number.isFinite(runAt) ? { mode: 'once', runAt } : { mode: 'none' };
    }
    return { mode: 'none' };
  };

  const submit = () => {
    if (!title.trim()) return;
    onSubmit(buildTask(), buildSchedule());
  };

  // Send the task intent (title + description) to the headless assistant and
  // replace the description with the returned, context-rich version. cwd is left
  // empty so the main process falls back to the active project directory.
  const enrich = useCallback(async () => {
    if (enriching) return; // re-entrancy guard
    const t = title.trim();
    const d = description.trim();
    if (!t && !d) { setEnrichError('add a title or description first'); return; }
    const message = t && d ? `${t}\n\n${d}` : (t || d);
    setEnriching(true);
    setEnrichError(null);
    try {
      const res = await window.cth.enrichMessage({ message, cwd: '', mode: 'task' });
      if (res.ok && res.prompt) {
        setPreEnrich(description); // stash current text for undo
        setDescription(res.prompt);
      } else {
        setEnrichError(res.error || 'enrich failed');
      }
    } catch (e) {
      setEnrichError(e instanceof Error ? e.message : String(e));
    } finally {
      setEnriching(false);
    }
  }, [enriching, title, description]);

  const undoEnrich = useCallback(() => {
    if (preEnrich === null) return;
    setDescription(preEnrich);
    setPreEnrich(null);
    setEnrichError(null);
  }, [preEnrich]);

  const toggleDep = (id: string) => {
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  };

  return (
    <div style={{ padding: '0 10px 8px', flexShrink: 0 }}>
      <PixelPanel variant="inset" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); }}
          placeholder="Task title…"
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <textarea
            value={description}
            // Manually editing the enriched text retires the undo — restoring an
            // ambiguous "previous" version would be surprising after hand-edits.
            onChange={(e) => { setDescription(e.target.value); if (preEnrich !== null) setPreEnrich(null); }}
            rows={2}
            placeholder="Description / context (optional)"
            style={{ ...inputStyle, flex: 1, resize: 'none', fontFamily: 'var(--cth-font-mono)' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch', flexShrink: 0 }}>
            <MicButton onTranscript={(t) => setDescription((p) => (p ? `${p} ${t}` : t))} />
            <button
              type="button"
              onClick={enrich}
              disabled={enriching || (!title.trim() && !description.trim())}
              title={enriching
                ? 'Enriching — reading the repo read-only to build a concrete task description (can take a bit)'
                : 'Enrich — rewrite this into a concrete, self-contained task description'}
              style={{
                height: 30, padding: '0 8px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 'none', cursor: enriching ? 'progress' : 'pointer',
                background: enriching ? 'var(--cth-lemon)' : 'var(--cth-cream-100)',
                color: 'var(--cth-ink-900)',
                boxShadow: enriching
                  ? 'inset 0 0 0 2px var(--cth-ink-900), 0 2px 0 var(--cth-ink-900)'
                  : 'inset 0 0 0 2px var(--cth-ink-700), 0 2px 0 var(--cth-ink-700)',
                opacity: (enriching || (!title.trim() && !description.trim())) ? 0.6 : 1,
                fontFamily: 'var(--cth-font-ui)', fontSize: 13
              }}
            >
              <Icon name="sparkle" /> {enriching ? 'enriching…' : 'enrich'}
            </button>
            {preEnrich !== null && !enriching && (
              <button
                type="button"
                onClick={undoEnrich}
                title="Undo enrich — restore the previous description"
                style={{
                  height: 22, border: 'none', cursor: 'pointer',
                  background: 'var(--cth-cream-200)', color: 'var(--cth-ink-700)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 11
                }}
              >undo</button>
            )}
          </div>
        </div>
        {enrichError && (
          <div style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cth-coral)' }}>{enrichError}</div>
        )}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={labelStyle}>assignee</label>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} style={selectStyle}>
            <option value="">unassigned</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}{a.isGod ? ' (god)' : ''}</option>
            ))}
          </select>
          <label style={labelStyle}>priority</label>
          <select value={String(priority)} onChange={(e) => setPriority(Number(e.target.value))} style={selectStyle}>
            {[1, 2, 3, 4, 5].map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
          {editing && (
            <>
              <label style={labelStyle}>status</label>
              <select value={status} onChange={(e) => setStatus(e.target.value as Status)} style={selectStyle}>
                {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>))}
              </select>
            </>
          )}
        </div>

        {existing.length > 0 && (
          <div>
            <div style={{ ...labelStyle, marginBottom: 4 }}>depends on</div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 84, overflowY: 'auto',
              padding: 4, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              {existing.map((t) => {
                const on = deps.includes(t.id);
                return (
                  <button
                    key={t.id}
                    onClick={() => toggleDep(t.id)}
                    title={t.title}
                    style={{
                      maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                      background: on ? 'var(--cth-sky)' : 'var(--cth-cream-200)',
                      boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                      fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
                    }}
                  >{t.title}</button>
                );
              })}
            </div>
          </div>
        )}

        {/* SCHEDULE — auto-dispatch this task once at a chosen time, or recurring. */}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
          <label style={labelStyle}>schedule</label>
          <select
            value={schedMode}
            onChange={(e) => setSchedMode(e.target.value as 'none' | 'once' | 'recurring')}
            style={selectStyle}
          >
            <option value="none">none</option>
            <option value="once">once</option>
            <option value="recurring">recurring</option>
          </select>
          {schedMode === 'once' && (
            <input
              type="datetime-local"
              value={schedAt}
              onChange={(e) => setSchedAt(e.target.value)}
              style={{ ...selectStyle, fontFamily: 'var(--cth-font-ui)' }}
            />
          )}
          {schedMode === 'recurring' && (
            <>
              <select value={schedInterval} onChange={(e) => setSchedInterval(e.target.value)} style={selectStyle}>
                {INTERVAL_OPTS.map((o) => <option key={o.ms} value={String(o.ms)}>{o.label}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setSchedEnabled((v) => !v)}
                title={schedEnabled ? 'Schedule active — click to pause' : 'Schedule paused — click to enable'}
                style={{
                  padding: '3px 9px 2px', border: 'none', cursor: 'pointer',
                  background: schedEnabled ? 'var(--cth-lemon)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 1px ${schedEnabled ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
                }}
              >{schedEnabled ? 'on' : 'off'}</button>
            </>
          )}
          {schedMode !== 'none' && (
            <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
              {schedMode === 'once' ? 'auto-dispatches once' : 'auto-dispatches to the assignee'}
            </span>
          )}
        </div>

        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <PixelButton variant="primary" size="sm" onClick={submit} disabled={!title.trim() || enriching}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="check" /> {editing ? 'save' : 'create'}
            </span>
          </PixelButton>
          {!editing && onCreateAndDispatch && (
            <PixelButton
              variant="primary"
              size="sm"
              onClick={() => { if (title.trim()) onCreateAndDispatch(buildTask(), buildSchedule()); }}
              disabled={!title.trim() || enriching}
            >
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Icon name="arrow-right" /> create &amp; dispatch
              </span>
            </PixelButton>
          )}
          <PixelButton variant="ghost" size="sm" onClick={onCancel}>cancel</PixelButton>
          {editing && onArchive && (
            <button
              onClick={onArchive}
              title="Archive this task (file it away — restorable from the ARCHIVED section)"
              style={{
                marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 9px 2px', border: 'none', cursor: 'pointer',
                background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="folder" /> archive
            </button>
          )}
          {editing && onDelete && (
            <button
              onClick={() => (confirmDelete ? onDelete() : setConfirmDelete(true))}
              onBlur={() => setConfirmDelete(false)}
              title="Delete this task"
              style={{
                marginLeft: onArchive ? 0 : 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
                padding: '3px 9px 2px', border: 'none', cursor: 'pointer',
                background: confirmDelete ? 'var(--cth-coral)' : 'var(--cth-cream-200)',
                boxShadow: `inset 0 0 0 1px ${confirmDelete ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
                fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
              }}
            >
              <Icon name="x" /> {confirmDelete ? 'confirm delete' : 'delete'}
            </button>
          )}
        </div>
      </PixelPanel>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 13, lineHeight: '17px', color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

const selectStyle: React.CSSProperties = {
  padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
  fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)'
};
