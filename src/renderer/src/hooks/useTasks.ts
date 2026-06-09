import { useEffect } from 'react';
import { create } from 'zustand';
import { useStore } from '@/store/store';
import {
  type ProjectTask,
  type ScheduledMission,
  type ScheduleSpec,
  type Status,
  POLL_MS,
  STALE_AFTER_MS,
  parseTasks,
  isTaskUnread,
  isTaskStale
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
  /** PERMANENTLY delete every archived task (+ their schedules) in one write. */
  clearAllArchived: () => void;
  unarchiveTask: (id: string) => void;
  markTaskRead: (id: string) => void;
  dispatchTask: (t: ProjectTask) => Promise<void>;
  /** Dispatch every not-yet-dispatched `todo` task in one batch (one persist + one toast). */
  dispatchAllTodo: () => Promise<void>;
  /** Approve a parked plan: sign off → return the card to TODO (moveTask clears
   *  planMode + drops the PLAN chip) and dispatch it to its assignee so
   *  implementation starts. */
  approveTask: (t: ProjectTask) => Promise<void>;
  /** Reject a parked plan: send the card back to TODO without dispatching
   *  (moveTask clears planMode); the human edits / re-plans / re-dispatches. */
  rejectTask: (t: ProjectTask) => void;
}

let dispatchMsgTimer: ReturnType<typeof setTimeout> | null = null;

/** Plan-mode dispatch addendum: tells the agent to PLAN, not implement, and park
 *  the task in Needs Approval (status='needs-approval') for human sign-off when the
 *  plan is ready. Appended to the dispatch body only for tasks flagged planMode. */
const PLAN_MODE_BLOCK =
  '\nPLAN MODE — produce a concise implementation PLAN for this task and DO NOT implement it. '
  + "When the plan is ready, post a task-update with kind 'needs-approval' (NOT 'done') whose text "
  + 'is the plan summary, to park this task in Needs Approval for human sign-off. Do not mark this '
  + 'task done — wait for the human to approve the plan first.\n';

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
    // Baseline the assignee-recency clock at creation so a later agent 'doing' claim
    // (which stamps assigneeUpdatedAt) doesn't silently outrank the original human
    // assignment in the writeTasks merge.
    const seeded = { ...t, assigneeUpdatedAt: t.assignee ? new Date().toISOString() : undefined };
    get().persist([...get().tasks, seeded]);
    get().syncTaskMission(seeded, schedule);
    // Notify the orchestrator on CREATE so a task doesn't sit in TODO unseen — no
    // code watches the column, and historically only an explicit dispatch ever
    // told god a task exists, so a created-but-undispatched card rotted (the #1
    // "stuck in todo" cause). Only when unassigned or god-owned (an assigned task
    // is the worker's via the dispatch/delegate path). This is a triage nudge: it
    // does NOT stamp dispatchedAt or advance the column — the card stays in TODO
    // until god delegates or it's dispatched. startFloor() lets the wake-nudge loop
    // deliver it even with auto-pilot off. (When the human picks "create & dispatch"
    // a second dispatch message also goes out — harmless: god dedups by task id.)
    if (!seeded.assignee || seeded.assignee === 'god') {
      window.cth
        .projectSend({ to: 'god', act: 'request', subject: 'New task to triage', body: dispatchBody(seeded) }, 'human')
        .catch(() => { /* best-effort nudge */ });
      useStore.getState().startFloor();
    }
  },

  // Replace a task in place. Preserve harness-owned `updates` (the form never
  // carries them) and only re-stamp `statusUpdatedAt`/`assigneeUpdatedAt` when the
  // human actually changed the column / the assignee, so the main-process merge
  // keeps the latest writer of each (the two clocks are independent).
  saveEdit: (t, schedule) => {
    get().persist(get().tasks.map((x) => (x.id === t.id
      ? {
          ...t,
          updates: x.updates,
          statusUpdatedAt: x.status === t.status ? x.statusUpdatedAt : new Date().toISOString(),
          assigneeUpdatedAt: x.assignee === t.assignee ? x.assigneeUpdatedAt : new Date().toISOString()
        }
      : x)));
    get().syncTaskMission(t, schedule);
  },

  deleteTask: (id) => {
    const { missions, persistMissions, persist, tasks } = get();
    const m = missions.find((x) => x.taskId === id);
    if (m) persistMissions(missions.filter((x) => x.id !== m.id)); // drop its schedule too
    persist(tasks.filter((x) => x.id !== id)); // dropping the task drops its updates — intended
  },

  // Move a card to a new column. Moving a task OUT of needs-approval is the human's
  // "plan approved" gesture, so clear planMode there: the planning phase is over, the
  // PLAN chip/dispatch addendum drop, and the eventual real 'done' is no longer
  // coerced back to needs-approval (see main appendTaskUpdate's plan-mode auto-park).
  moveTask: (id, status) => {
    get().persist(get().tasks.map((t) => (t.id === id
      ? {
          ...t,
          status,
          statusUpdatedAt: new Date().toISOString(),
          planMode: t.status === 'needs-approval' && status !== 'needs-approval' ? undefined : t.planMode
        }
      : t)));
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

  // Bulk-PERMANENTLY-delete every archived task in ONE write (vs N racing
  // deleteTask calls). Drops their linked schedules too, then persists only the
  // surviving (non-archived) tasks — like deleteTask this removes them from
  // tasks.json and is NOT recoverable. The caller gates this behind a confirm.
  clearAllArchived: () => {
    const { tasks, missions, persist, persistMissions } = get();
    const archivedIds = new Set(tasks.filter((t) => t.archived).map((t) => t.id));
    if (archivedIds.size === 0) return;
    const remaining = missions.filter((m) => !(m.taskId && archivedIds.has(m.taskId)));
    if (remaining.length !== missions.length) persistMissions(remaining);
    persist(tasks.filter((t) => !t.archived));
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
      // Mark the card dispatched but LEAVE it in its column: a dispatched task stays
      // in TODO (assigned to its owner) and only advances to DOING when the assigned
      // agent posts its OWN 'doing' task-update. We stamp dispatchedAt — which hides
      // the re-dispatch button until the status changes, and feeds isTaskStale so a
      // card that never starts re-surfaces after 20 min — but DO NOT touch status: the
      // human wants an honest TODO until work actually begins, not an optimistic DOING.
      // Map over the live store array, not the captured `t`, to avoid clobbering a
      // concurrent edit.
      const stamp = new Date().toISOString();
      await get().persist(get().tasks.map((x) =>
        (x.id === t.id ? { ...x, dispatchedAt: stamp } : x)));
      useStore.getState().startFloor();
      const agents = useStore.getState().agents;
      const name = to === 'god' ? 'Michael' : (agents.find((a) => a.id === to)?.name ?? to);
      // Honest delivery feedback: `delivered>0` only means the inbox FOLDER exists
      // (an archived/idle agent still has one), not that anyone is live to read it.
      // So check for a live pty and say "queued · offline" when the assignee isn't
      // running — the reaper will re-route it; the human isn't falsely reassured.
      const live = agents.some((a) => a.id === to && !!a.ptyId && !a.archived);
      setMsg((res.delivered ?? 0) === 0
        ? '⚠ no active agent received this'
        : live
          ? `dispatched to ${name}`
          : `queued for ${name} · ⚠ offline, will run when it wakes`);
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
      // Mark each dispatched card dispatched but LEAVE it in TODO (same behavior as
      // dispatchTask): a card only advances to DOING when its assigned agent posts its
      // OWN 'doing' task-update. dispatchedAt hides the re-dispatch button and feeds
      // isTaskStale (a card that never starts re-surfaces after 20 min); status is left
      // untouched so the column reflects real work, not dispatch.
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
  },

  // Approve a parked plan: the plan is signed off, so return the card to TODO and
  // dispatch it for implementation. moveTask('todo') is the human-approval gesture
  // that clears planMode (and drops the PLAN chip), so the dispatched body carries
  // the plain implement instruction (no plan-mode addendum) and the eventual 'done'
  // is no longer coerced back to needs-approval. dispatchTask maps over the live
  // store array (already reflecting the move), so the two persists don't clobber.
  approveTask: async (t) => {
    get().moveTask(t.id, 'todo');
    await get().dispatchTask({ ...t, status: 'todo', planMode: undefined });
  },

  // Reject a parked plan: send it back to TODO WITHOUT dispatching (moveTask clears
  // planMode). The human then edits, re-enables plan mode, or re-dispatches as they
  // see fit. Same single-field move as the lane <select>; just a one-click shortcut.
  rejectTask: (t) => {
    get().moveTask(t.id, 'todo');
  }
}));

// ─── Ref-counted lifecycle: one poller + one subscription set, no matter how
//     many components mount the hook ────────────────────────────────────────--
let refCount = 0;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let reaperTimer: ReturnType<typeof setInterval> | null = null;
let unsubTaskUpdated: (() => void) | null = null;
let unsubSchedulerFired: (() => void) | null = null;

// ─── Stale-task reaper ───────────────────────────────────────────────────────
// The active half of the stale safety net: dispatch advances a card to DOING, but
// the actual owner can still be gone (archived/idle/never-spawned), in which case
// the renderer wake-nudge loop — which only pokes LIVE idle ptys — never reaches it
// and the card silently rots. Every minute, scan in-flight cards that have gone
// stale (20m+ no activity, see isTaskStale); for any whose assignee is NOT a live
// pty (or is unassigned/god), re-route a fresh nudge to god and start the floor so
// it gets re-picked-up instead of sitting forever. De-duped to at most one ping per
// STALE window per task, so a persistently-stuck card pings god ~every 20m (not
// every tick) and a transient stall isn't spammed.
const REAPER_INTERVAL_MS = 60_000;
const lastReaped: Record<string, number> = {}; // taskId → epoch ms we last nudged god

function reapStaleTasks(): void {
  const { tasks } = useTasksStore.getState();
  const agents = useStore.getState().agents;
  const now = Date.now();
  const isLive = (id: string): boolean => agents.some((a) => a.id === id && !!a.ptyId && !a.archived);
  for (const t of tasks) {
    if (!isTaskStale(t, now)) continue;
    // A live, non-god assignee is already handled by the wake-nudge loop; the
    // reaper only rescues cards whose owner is gone/idle-dead, unassigned, or god.
    if (t.assignee && t.assignee !== 'god' && isLive(t.assignee)) continue;
    const since = lastReaped[t.id];
    if (since && now - since < STALE_AFTER_MS) continue; // already nudged this window
    lastReaped[t.id] = now;
    const who = t.assignee ? `assignee "${t.assignee}" is not live` : 'no assignee';
    window.cth
      .projectSend({
        to: 'god',
        act: 'request',
        subject: 'Stale task — not picked up',
        body: `${dispatchBody(t)}(Auto-flag: no activity for 20m+, ${who} — please re-route to a live worker or pick it up.)\n`
      }, 'system')
      .catch(() => { /* best-effort */ });
    useStore.getState().startFloor();
  }
}

function startLifecycle(): void {
  const { refresh, loadMissions } = useTasksStore.getState();
  refresh();
  loadMissions();
  pollTimer = setInterval(() => useTasksStore.getState().refresh(), POLL_MS);
  reaperTimer = setInterval(reapStaleTasks, REAPER_INTERVAL_MS);
  // An agent posting a task-update flips the card live (~1.5s) instead of waiting
  // on the 5s poll: re-pull so the view stays byte-identical to disk.
  unsubTaskUpdated = window.cth.onProjectTaskUpdated(() => useTasksStore.getState().refresh());
  // Re-list schedules whenever one fires so a spent one-shot flips to "fired".
  unsubSchedulerFired = window.cth.onSchedulerFired(() => useTasksStore.getState().loadMissions());
}

function stopLifecycle(): void {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (reaperTimer) { clearInterval(reaperTimer); reaperTimer = null; }
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
    clearAllArchived: s.clearAllArchived,
    unarchiveTask: s.unarchiveTask,
    markTaskRead: s.markTaskRead,
    dispatchTask: s.dispatchTask,
    dispatchAllTodo: s.dispatchAllTodo,
    approveTask: s.approveTask,
    rejectTask: s.rejectTask
  };
}
