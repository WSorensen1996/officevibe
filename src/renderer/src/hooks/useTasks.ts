import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '@/store/store';
import {
  type ProjectTask,
  type ScheduledMission,
  type ScheduleSpec,
  type Status,
  POLL_MS,
  parseTasks,
  isTaskUnread
} from '@/components/tasks/taskShared';

/**
 * Single source of truth for the live task ledger, shared by the right-column
 * Kanban board (TasksKanban) and the left-column full-card view (TaskDetailPanel).
 *
 * The state + every mutation live in a module-scoped Zustand store; the poller
 * and the IPC subscriptions are started ONCE (ref-counted by `useTasks`) so two
 * mounted consumers don't double-poll or double-subscribe. Mutations write
 * optimistically to the shared array, so a change made in the detail view shows
 * on the board instantly and vice-versa. Consumers must always look the task up
 * by id from `tasks` each render — never snapshot it — to stay in sync.
 */

interface TasksStore {
  tasks: ProjectTask[];
  missions: ScheduledMission[];
  /** Transient feedback from a card/detail dispatch (auto-clears after 5s). */
  dispatchMsg: string | null;

  refresh: () => Promise<void>;
  loadMissions: () => void;
  persist: (next: ProjectTask[]) => Promise<void>;
  persistMissions: (next: ScheduledMission[]) => Promise<void>;
  missionFor: (taskId: string) => ScheduledMission | undefined;
  syncTaskMission: (task: ProjectTask, spec: ScheduleSpec) => void;
  addTask: (t: ProjectTask, schedule: ScheduleSpec) => void;
  saveEdit: (t: ProjectTask, schedule: ScheduleSpec) => void;
  deleteTask: (id: string) => void;
  moveTask: (id: string, status: Status) => void;
  /** Set a task's priority (1-5) in place — one persist, no status re-stamp. */
  setPriority: (id: string, priority: number) => void;
  archiveTask: (id: string) => void;
  /** Archive every non-archived task in the `done` column in one write. */
  archiveAllDone: () => void;
  unarchiveTask: (id: string) => void;
  markTaskRead: (id: string) => void;
  dispatchTask: (t: ProjectTask) => Promise<void>;
  /** Dispatch every not-yet-dispatched `todo` task in one batch (one persist + one toast). */
  dispatchAllTodo: () => Promise<void>;
}

let dispatchMsgTimer: ReturnType<typeof setTimeout> | null = null;

/** Plan-mode dispatch addendum: tells the agent to PLAN, not implement, and park
 *  the task in Needs Approval (status='needs-approval') for human sign-off when the
 *  plan is ready. Appended to the dispatch body only for tasks flagged planMode. */
const PLAN_MODE_BLOCK =
  '\nPLAN MODE — produce a concise implementation PLAN for this task and DO NOT implement it. '
  + "When the plan is ready, post a task-update with kind 'needs-approval' whose text is the plan "
  + 'summary, to park this task in Needs Approval for human sign-off.\n';

/** The inbox body for dispatching a task: the standard `Task: … [task:id]\nContext: …`
 *  shell, plus the plan-mode block when the task is flagged planMode. Shared by
 *  dispatchTask and dispatchAllTodo so both honor plan mode identically. */
function dispatchBody(t: ProjectTask): string {
  const desc = t.description?.trim() ? t.description.trim() : '(no description)';
  return `Task: ${t.title} [task:${t.id}]\nContext: ${desc}\n${t.planMode ? PLAN_MODE_BLOCK : ''}`;
}

const useTasksStore = create<TasksStore>((set, get) => ({
  tasks: [],
  missions: [],
  dispatchMsg: null,

  refresh: async () => {
    try { set({ tasks: parseTasks(await window.cth.projectTasks()) }); } catch { /* keep last good */ }
  },

  loadMissions: () => {
    window.cth.listMissions().then((m) => set({ missions: m })).catch(() => { /* noop */ });
  },

  persist: async (next) => {
    set({ tasks: next }); // optimistic
    try { await window.cth.projectWriteTasks(next); } catch { get().refresh(); }
  },

  persistMissions: async (next) => {
    set({ missions: next }); // optimistic
    try { await window.cth.saveMissions(next); } catch { /* noop */ }
  },

  missionFor: (taskId) => get().missions.find((m) => m.taskId === taskId),

  // Reconcile a task's linked schedule from the form's ScheduleSpec: 'none' drops
  // any existing mission; otherwise upsert one keyed to the task. The scheduler
  // re-reads the live task at fire time, so label/to here are only a best-effort
  // snapshot. A freshly-set one-time fire clears lastFiredAt so it can arm;
  // recurring keeps its cadence (lastFiredAt) across edits.
  syncTaskMission: (task, spec) => {
    const { missions, persistMissions } = get();
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
  },

  addTask: (t, schedule) => {
    get().persist([...get().tasks, t]);
    get().syncTaskMission(t, schedule);
  },

  // Replace a task in place. Preserve harness-owned `updates` (the form never
  // carries them) and only re-stamp `statusUpdatedAt` when the human actually
  // changed the column, so the main-process merge keeps the latest writer.
  saveEdit: (t, schedule) => {
    get().persist(get().tasks.map((x) => (x.id === t.id
      ? { ...t, updates: x.updates, statusUpdatedAt: x.status === t.status ? x.statusUpdatedAt : new Date().toISOString() }
      : x)));
    get().syncTaskMission(t, schedule);
  },

  deleteTask: (id) => {
    const { missions, persistMissions, persist, tasks } = get();
    const m = missions.find((x) => x.taskId === id);
    if (m) persistMissions(missions.filter((x) => x.id !== m.id)); // drop its schedule too
    persist(tasks.filter((x) => x.id !== id)); // dropping the task drops its updates — intended
  },

  moveTask: (id, status) => {
    get().persist(get().tasks.map((t) => (t.id === id ? { ...t, status, statusUpdatedAt: new Date().toISOString() } : t)));
  },

  // Set priority in place from the board card. Clamp to 1-5 (the range the form
  // and PriorityDots assume) and persist with a single map. Priority is orthogonal
  // to status, so unlike moveTask this leaves statusUpdatedAt untouched.
  setPriority: (id, priority) => {
    const p = Math.max(1, Math.min(5, Math.round(priority)));
    get().persist(get().tasks.map((t) => (t.id === id ? { ...t, priority: p } : t)));
  },

  // Archive: hide the card from the board (kept on disk, restorable) and drop its
  // linked schedule so it stops auto-dispatching — same mission cleanup as delete.
  // Status is left untouched so a restore returns it to its original column.
  archiveTask: (id) => {
    const { missions, persistMissions, persist, tasks } = get();
    const m = missions.find((x) => x.taskId === id);
    if (m) persistMissions(missions.filter((x) => x.id !== m.id));
    persist(tasks.map((t) => (t.id === id ? { ...t, archived: true } : t)));
  },

  // Bulk-archive the whole Done column in ONE write (vs N racing single archives):
  // collect the non-archived done ids, drop their linked schedules, then persist
  // the array with all of them flagged. Status is left untouched so a later
  // restore returns each to the Done column.
  archiveAllDone: () => {
    const { tasks, missions, persist, persistMissions } = get();
    const doneIds = new Set(tasks.filter((t) => t.status === 'done' && !t.archived).map((t) => t.id));
    if (doneIds.size === 0) return;
    const remaining = missions.filter((m) => !(m.taskId && doneIds.has(m.taskId)));
    if (remaining.length !== missions.length) persistMissions(remaining);
    persist(tasks.map((t) => (doneIds.has(t.id) ? { ...t, archived: true } : t)));
  },

  unarchiveTask: (id) => {
    get().persist(get().tasks.map((t) => (t.id === id ? { ...t, archived: false } : t)));
  },

  // Stamp a card as read when the human opens its full view. Sets viewedAt to the
  // newest update's ts (not `now`) so an agent update landing between open and
  // persist still reads as unread on the next poll — it genuinely IS newer. The
  // guard makes this a no-op when already read, so the open-effect can't loop.
  markTaskRead: (id) => {
    const { tasks, persist } = get();
    const task = tasks.find((t) => t.id === id);
    if (!task || !isTaskUnread(task)) return;
    const ups = task.updates ?? [];
    const newest = ups.length ? ups[ups.length - 1].ts : new Date().toISOString();
    persist(tasks.map((t) => (t.id === id ? { ...t, viewedAt: newest } : t)));
  },

  // Send a card straight to its assignee's inbox (Michael if unassigned). Embeds
  // [task:id] so the worker can post status updates back onto THIS card, and
  // flips the floor started so the inbox wake-nudge loop delivers it even when
  // auto-pilot is off (same gate the old Floor dispatch box relied on).
  dispatchTask: async (t) => {
    const setMsg = (msg: string | null): void => {
      set({ dispatchMsg: msg });
      if (dispatchMsgTimer) clearTimeout(dispatchMsgTimer);
      if (msg !== null) dispatchMsgTimer = setTimeout(() => set({ dispatchMsg: null }), 5000);
    };
    const to = t.assignee ?? 'god';
    const body = dispatchBody(t);
    const res = await window.cth.projectSend(
      { to, act: 'request', subject: 'Task from you', body }, 'human');
    if (!res.ok) {
      setMsg(`dispatch failed: ${res.error ?? '?'}`);
    } else {
      // Stamp the card so the dispatch button hides; persisted, so it survives
      // reloads until the task's status next changes (re-nudgeable when blocked).
      // Map over the live store array, not the captured `t`, to avoid clobbering
      // a concurrent edit.
      await get().persist(get().tasks.map((x) =>
        (x.id === t.id ? { ...x, dispatchedAt: new Date().toISOString() } : x)));
      useStore.getState().startFloor();
      const agents = useStore.getState().agents;
      const name = to === 'god' ? 'Michael' : (agents.find((a) => a.id === to)?.name ?? to);
      setMsg((res.delivered ?? 0) === 0
        ? '⚠ no active agent received this'
        : `dispatched to ${name}`);
    }
  },

  // Bulk version of dispatchTask for the TODO column: send every not-yet-dispatched
  // todo task to its assignee (Michael if unassigned), then ONE persist stamping all
  // of them + ONE startFloor + ONE summary toast. Already-dispatched todos are
  // skipped so it can never re-spam. Modeled on dispatchTask, not a loop over it.
  dispatchAllTodo: async () => {
    const setMsg = (msg: string | null): void => {
      set({ dispatchMsg: msg });
      if (dispatchMsgTimer) clearTimeout(dispatchMsgTimer);
      if (msg !== null) dispatchMsgTimer = setTimeout(() => set({ dispatchMsg: null }), 5000);
    };
    const todo = get().tasks.filter((t) => t.status === 'todo' && !t.archived && !t.dispatchedAt);
    if (todo.length === 0) return;
    const sent = new Set<string>();
    let delivered = 0;
    let failed = 0;
    for (const t of todo) {
      const to = t.assignee ?? 'god';
      const body = dispatchBody(t);
      const res = await window.cth.projectSend(
        { to, act: 'request', subject: 'Task from you', body }, 'human');
      if (res.ok) { sent.add(t.id); delivered += res.delivered ?? 0; }
      else { failed += 1; }
    }
    if (sent.size > 0) {
      const stamp = new Date().toISOString();
      // Map over the live store array (not the captured list) so a concurrent edit
      // isn't clobbered; stamp only the ones that actually went out.
      await get().persist(get().tasks.map((x) =>
        (sent.has(x.id) ? { ...x, dispatchedAt: stamp } : x)));
      useStore.getState().startFloor();
    }
    setMsg(
      `dispatched ${sent.size} task${sent.size === 1 ? '' : 's'}` +
      (failed ? ` · ${failed} failed` : '') +
      (sent.size > 0 && delivered === 0 ? ' · ⚠ no active agent received them' : ''));
  }
}));

// ─── Ref-counted lifecycle: one poller + one subscription set, no matter how
//     many components mount the hook ────────────────────────────────────────--
let refCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let unsubTaskUpdated: (() => void) | null = null;
let unsubSchedulerFired: (() => void) | null = null;

function startLifecycle(): void {
  const { refresh, loadMissions } = useTasksStore.getState();
  refresh();
  loadMissions();
  pollTimer = setInterval(() => useTasksStore.getState().refresh(), POLL_MS);
  // An agent posting a task-update flips the card live (~1.5s) instead of waiting
  // on the 5s poll: re-pull so the view stays byte-identical to disk.
  unsubTaskUpdated = window.cth.onProjectTaskUpdated(() => useTasksStore.getState().refresh());
  // Re-list schedules whenever one fires so a spent one-shot flips to "fired".
  unsubSchedulerFired = window.cth.onSchedulerFired(() => useTasksStore.getState().loadMissions());
}

function stopLifecycle(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  unsubTaskUpdated?.(); unsubTaskUpdated = null;
  unsubSchedulerFired?.(); unsubSchedulerFired = null;
}

/** Subscribe to the shared task ledger + mutations. Starts the poller/IPC subs
 *  on the first mounted consumer and stops them when the last one unmounts. */
export function useTasks() {
  const tasks = useTasksStore((s) => s.tasks);
  const missions = useTasksStore((s) => s.missions);
  const dispatchMsg = useTasksStore((s) => s.dispatchMsg);

  useEffect(() => {
    refCount += 1;
    if (refCount === 1) startLifecycle();
    return () => {
      refCount -= 1;
      if (refCount === 0) stopLifecycle();
    };
  }, []);

  const s = useTasksStore.getState();
  return {
    tasks,
    missions,
    dispatchMsg,
    refresh: s.refresh,
    persist: s.persist,
    persistMissions: s.persistMissions,
    missionFor: s.missionFor,
    syncTaskMission: s.syncTaskMission,
    addTask: s.addTask,
    saveEdit: s.saveEdit,
    deleteTask: s.deleteTask,
    moveTask: s.moveTask,
    setPriority: s.setPriority,
    archiveTask: s.archiveTask,
    archiveAllDone: s.archiveAllDone,
    unarchiveTask: s.unarchiveTask,
    markTaskRead: s.markTaskRead,
    dispatchTask: s.dispatchTask,
    dispatchAllTodo: s.dispatchAllTodo
  };
}
