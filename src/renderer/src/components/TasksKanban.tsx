import { useCallback, useEffect, useRef, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { MicButton } from './MicButton';
import { useStore, NEW_TASK_ID } from '@/store/store';
import { useTasks } from '@/hooks/useTasks';
import {
  type ProjectTask,
  type TaskAttachment,
  type Status,
  type ScheduledMission,
  type ScheduleSpec,
  COLUMNS,
  NEEDS_APPROVAL,
  UPDATE_COLOR,
  INTERVAL_OPTS,
  intervalLabel,
  toLocalInput,
  shortWhen,
  shortId,
  canDispatchTask,
  isTaskUnread,
  isTaskStale
} from './tasks/taskShared';

export type { ProjectTask, TaskUpdate } from './tasks/taskShared';

// Platform-aware label for the GLOBAL new-task shortcut (App.tsx capture-phase
// Ctrl/Cmd+Enter → openTask(NEW_TASK_ID)). Mirrors App.tsx's IS_MAC convention.
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');
const NEW_TASK_HINT = IS_MAC ? '⌘⏎' : 'Ctrl ⏎';

// Workload-aware default assignee for NEW tasks (task bii2). New tasks used to
// always default to Michael (god), so he piled up while other agents sat idle.
// Policy = the human-APPROVED recommended defaults (tweak the marked spots):
//   • pool   = Michael + live WORKERS (assistant/Dwight excluded from the auto
//              default — he's inert; still MANUALLY selectable in the <select>)
//   • busy   = Michael's status ∈ {working, thinking}  ← add 'waiting' to widen
//   • load   = an agent's OPEN tasks (already archived-filtered upstream; drop done)
//   • result = an EDITABLE default — the assignee <select> still overrides freely
// If Michael is free (or absent) → default to Michael (he picks up / delegates).
// If Michael is busy → the least-loaded live teammate, ties → Michael (he stays
// the fallback), so counts stay roughly even. Ghost (gone) agents are skipped.
const WORKING_STATUSES = new Set(['working', 'thinking']); // ← Michael "is working"
function pickAutoAssignee(tasks: ProjectTask[]): string {
  const roster = useStore.getState().agents;
  const god = roster.find((a) => a.isGod);
  const godId = god?.id ?? 'god';
  if (!god || !WORKING_STATUSES.has(god.status)) return godId; // Michael free → Michael
  // Michael busy → spread to the least-loaded live teammate. Seed with Michael so
  // a strict tie resolves to him; only a STRICTLY lighter teammate wins.
  const openCount = (id: string) =>
    tasks.filter((t) => t.assignee === id && t.status !== 'done').length;
  let best = godId;
  let bestLoad = openCount(godId);
  for (const a of roster) {
    // skip Michael (seeded), the inert assistant (Dwight — won't pick work up), + gone agents
    if (a.id === godId || a.isAssistant || a.status === 'ghost') continue;
    const load = openCount(a.id);
    if (load < bestLoad) { best = a.id; bestLoad = load; }
  }
  return best;
}

/**
 * Task kanban over hive/tasks.json. The live ledger + every mutation live in the
 * shared `useTasks` hook (one poller, one subscription) so this board and the
 * left-column full-card view (TaskDetailPanel) stay in sync. The human can add
 * tasks (assignee from the live roster, priority, dependsOn), dispatch a card
 * directly to its assignee's inbox, or open a card in full — the board is the
 * dispatch control surface.
 */
export function TasksKanban() {
  const agents = useStore((s) => s.agents);
  const openTask = useStore((s) => s.openTask);
  const setNewTaskSeed = useStore((s) => s.setNewTaskSeed);
  const {
    tasks,
    dispatchMsg,
    missionFor,
    deleteTask,
    moveTask,
    setPriority,
    archiveTask,
    archiveAllDone,
    clearAllArchived,
    unarchiveTask,
    dispatchTask,
    dispatchAllTodo,
    approveTask,
    rejectTask
  } = useTasks();

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

  // Auto-approve toggle, persisted in HarnessConfig (survives restart, like sttModel).
  // Seeded once from the main config; toggling writes straight back via updateConfig.
  const [autoApprove, setAutoApprove] = useState(false);
  useEffect(() => {
    let live = true;
    window.cth.getConfig().then((c) => { if (live) setAutoApprove(c?.autoApprove === true); }).catch(() => { /* noop */ });
    return () => { live = false; };
  }, []);
  const toggleAutoApprove = useCallback(() => {
    setAutoApprove((prev) => {
      const next = !prev;
      window.cth.updateConfig({ autoApprove: next }).catch(() => { /* best-effort */ });
      return next;
    });
  }, []);

  // Archived tasks live off the board (their own collapsible section); the four
  // columns and the toolbar count only ever see the active set.
  const active = tasks.filter((t) => !t.archived);
  const archived = tasks.filter((t) => t.archived);

  // One card-wiring shared by the normal column bodies and the BLOCKED column's
  // two stacked sub-sections (NEEDS APPROVAL + BLOCKED), so they stay identical.
  const renderCard = (t: ProjectTask) => (
    <TaskCard
      key={t.id}
      task={t}
      assigneeName={nameFor(t.assignee)}
      mission={missionFor(t.id)}
      onMove={(s) => moveTask(t.id, s)}
      onSetPriority={(p) => setPriority(t.id, p)}
      onDispatch={() => dispatchTask(t)}
      onArchive={() => archiveTask(t.id)}
      onEdit={() => openTask(t.id)}
    />
  );

  // Needs Approval cards get an extra APPROVE / REJECT row under the standard card.
  const renderApprovalCard = (t: ProjectTask) => (
    <div key={t.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {renderCard(t)}
      <div style={{ display: 'flex', gap: 4 }}>
        <button
          onClick={() => void approveTask(t)}
          title="Approve the plan: return to TODO and dispatch it for implementation"
          style={approvalBtnStyle('var(--cth-mint)')}
        >
          <Icon name="check" /> approve
        </button>
        <button
          onClick={() => rejectTask(t)}
          title="Reject the plan: send back to TODO without dispatching"
          style={approvalBtnStyle('var(--cth-coral)')}
        >
          <Icon name="x" /> reject
        </button>
      </div>
    </div>
  );

  // Auto-approve: when the toggle is on, any card that ENTERS Needs Approval is
  // approved immediately (no human click). The ref guards against double-firing —
  // a transient 5s-poll read of stale disk could momentarily re-show a just-moved
  // card as needs-approval, and approveTask dispatches, so we approve each id at
  // most once per session. moveTask clears planMode, so it can't loop back in.
  const autoApprovedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!autoApprove) return;
    const pending = active.filter((t) => t.status === 'needs-approval' && !autoApprovedRef.current.has(t.id));
    pending.forEach((t) => {
      autoApprovedRef.current.add(t.id);
      void approveTask(t);
    });
  }, [autoApprove, active, approveTask]);

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
        <span title="New task (⌘/Ctrl+Enter)" style={{ marginLeft: 'auto', display: 'inline-flex' }}>
          <PixelButton
            variant="primary"
            size="sm"
            onClick={() => { setNewTaskSeed(null); openTask(NEW_TASK_ID); }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <Icon name="plus" /> add task
              {/* Subtle keycap hint for the global new-task shortcut (bfy3). */}
              <span style={{
                marginLeft: 2, padding: '1px 4px',
                fontFamily: 'var(--cth-font-mono, monospace)',
                fontSize: 9, lineHeight: '12px', letterSpacing: '0.04em',
                color: 'var(--cth-cream-300)',
                background: 'rgba(255,255,255,0.10)',
                boxShadow: 'inset 0 0 0 1px rgba(255,255,255,0.25)',
                whiteSpace: 'nowrap'
              }}>{NEW_TASK_HINT}</span>
            </span>
          </PixelButton>
        </span>
      </div>

      {/* Columns */}
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', gap: 8, padding: 10, overflowX: 'auto'
      }}>
        {COLUMNS.map((col) => {
          const cards = active.filter((t) => t.status === col.key);
          const unread = cards.filter(isTaskUnread).length;
          // TODO column only: how many todos haven't been dispatched yet (drives DISPATCH ALL).
          const undispatched = col.key === 'todo' ? cards.filter((t) => !t.dispatchedAt).length : 0;
          // The BLOCKED column is split in half into two stacked, independently
          // scrolling sub-sections: NEEDS APPROVAL (waiting-for-human, e.g. a
          // plan-mode sign-off) on top, then BLOCKED below. needs-approval is a
          // first-class status, not a 5th column (see NEEDS_APPROVAL in taskShared).
          if (col.key === 'blocked') {
            const approvalCards = active.filter((t) => t.status === 'needs-approval');
            return (
              <div key={col.key} style={{
                flex: '1 1 0', minWidth: 170, display: 'flex', flexDirection: 'column',
                background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>
                <ColumnSubSection
                  label={NEEDS_APPROVAL.label}
                  accent={NEEDS_APPROVAL.accent}
                  cards={approvalCards}
                  renderCard={renderApprovalCard}
                  headerExtra={
                    <label
                      title="Auto-approve: instantly approve + dispatch any task that enters Needs Approval (persisted)"
                      style={{
                        display: 'inline-flex', alignItems: 'center', gap: 3, cursor: 'pointer',
                        fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)'
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={autoApprove}
                        onChange={toggleAutoApprove}
                        style={{ cursor: 'pointer', margin: 0 }}
                      />
                      AUTO
                    </label>
                  }
                />
                <div style={{ height: 2, flexShrink: 0, background: 'var(--cth-ink-300)' }} />
                <ColumnSubSection
                  label={col.label}
                  accent={col.accent}
                  cards={cards}
                  renderCard={renderCard}
                />
              </div>
            );
          }
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
                {unread > 0 && (
                  <span
                    title={`${unread} unread`}
                    style={{
                      marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      minWidth: 14, height: 14, padding: '0 4px',
                      background: 'var(--cth-coral)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)'
                    }}
                  >{unread}</span>
                )}
                <span style={{ marginLeft: unread > 0 ? 4 : 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
                {/* Archive-all: clears the whole Done column in one write (restorable
                    from the ARCHIVED section). Only on Done, only when it has cards. */}
                {col.key === 'done' && cards.length > 0 && (
                  <button
                    onClick={archiveAllDone}
                    title="Archive all done tasks (restorable from the ARCHIVED section)"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4,
                      padding: '1px 6px 0', border: 'none', cursor: 'pointer',
                      background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
                      color: 'var(--cth-ink-900)'
                    }}
                  >
                    <Icon name="folder" /> archive all
                  </button>
                )}
                {/* Dispatch-all: send every not-yet-dispatched TODO to its assignee in
                    one batch. Only on TODO, only when something's undispatched. */}
                {col.key === 'todo' && undispatched > 0 && (
                  <button
                    onClick={dispatchAllTodo}
                    title="Dispatch every not-yet-dispatched task in this column to its assignee"
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 4,
                      padding: '1px 6px 0', border: 'none', cursor: 'pointer',
                      background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
                      color: 'var(--cth-ink-900)'
                    }}
                  >
                    <Icon name="arrow-right" /> dispatch all
                  </button>
                )}
              </div>
              <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {cards.length === 0 && (
                  <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>—</div>
                )}
                {cards.map(renderCard)}
              </div>
            </div>
          );
        })}
      </div>

      <ArchivedTasksSection tasks={archived} onRestore={unarchiveTask} onDelete={deleteTask} onClearAll={clearAllArchived} />
    </div>
  );
}

// ─── Column sub-section — one labelled, independently-scrolling list inside a
//     column. Used to split the BLOCKED column into NEEDS APPROVAL (top) +
//     BLOCKED (bottom); each gets its own accent header, unread badge, count,
//     and empty-state. Mirrors the normal column header/body styling. ──────────-

/** Shared pixel-button style for the Needs Approval card's approve/reject row.
 *  Mirrors the column-header action buttons (archive-all / dispatch-all) but each
 *  half-fills the row and takes an accent background (mint=approve, coral=reject). */
function approvalBtnStyle(bg: string): React.CSSProperties {
  return {
    flex: 1, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 3,
    padding: '2px 6px 1px', border: 'none', cursor: 'pointer',
    background: bg, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
    fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
    color: 'var(--cth-ink-900)'
  };
}

function ColumnSubSection({ label, accent, cards, renderCard, headerExtra }: {
  label: string;
  accent: string;
  cards: ProjectTask[];
  renderCard: (t: ProjectTask) => React.ReactNode;
  /** Optional control rendered at the right edge of the sub-section header
   *  (e.g. the Needs Approval auto-approve checkbox). */
  headerExtra?: React.ReactNode;
}) {
  const unread = cards.filter(isTaskUnread).length;
  return (
    <div style={{ flex: '1 1 0', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px 4px', flexShrink: 0,
        background: accent, boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)',
        fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-900)'
      }}>
        {label}
        {unread > 0 && (
          <span
            title={`${unread} unread`}
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 14, height: 14, padding: '0 4px',
              background: 'var(--cth-coral)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)'
            }}
          >{unread}</span>
        )}
        <span style={{ marginLeft: unread > 0 ? 4 : 'auto', fontSize: 11, fontFamily: 'var(--cth-font-ui)' }}>{cards.length}</span>
        {headerExtra && (
          <span style={{ marginLeft: 6, display: 'inline-flex', alignItems: 'center' }}>{headerExtra}</span>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
        {cards.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-300)', textAlign: 'center', padding: '8px 0' }}>—</div>
        )}
        {cards.map(renderCard)}
      </div>
    </div>
  );
}

// ─── Archived section — tasks filed off the board, restorable to their column
//     (mirrors AgentsTab's ArchivedSection) ──────────────────────────────────--

function ArchivedTasksSection({ tasks, onRestore, onDelete, onClearAll }: {
  tasks: ProjectTask[];
  onRestore: (id: string) => void;
  onDelete: (id: string) => void;
  onClearAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (tasks.length === 0) return null;
  // PERMANENT bulk delete (irreversible) — gate behind an explicit confirm.
  const clearAll = () => {
    if (!window.confirm(`Permanently delete all ${tasks.length} archived tasks? This cannot be undone.`)) return;
    onClearAll();
  };
  return (
    <div style={{ flexShrink: 0, maxHeight: '38%', overflowY: 'auto', padding: '8px 10px 10px', borderTop: '1px solid var(--cth-ink-300)' }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>
        ARCHIVED ({tasks.length})
      </div>
      {/* Toggle + bulk-clear share one row; clear-all sits in the empty space at right. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: open ? 6 : 0 }}>
        <button
          onClick={() => setOpen((v) => !v)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
          }}
        >{open ? '▾' : '▸'} {open ? 'hide' : 'show'} archived tasks</button>
        <button
          onClick={clearAll}
          title="Permanently delete every archived task (cannot be undone)"
          style={{
            marginLeft: 'auto', flexShrink: 0,
            padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
            background: 'transparent', boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-coral)'
          }}
        >clear all</button>
      </div>
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
        <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayTitle(task)}</div>
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

function TaskCard({ task, assigneeName, mission, onMove, onSetPriority, onDispatch, onArchive, onEdit }: {
  task: ProjectTask;
  assigneeName?: string;
  mission?: ScheduledMission;
  onMove: (s: Status) => void;
  onSetPriority: (p: number) => void;
  onDispatch: () => void;
  onArchive: () => void;
  onEdit: () => void;
}) {
  const pr = Math.max(1, Math.min(5, task.priority));
  // Dispatch sends the card to its assignee's inbox; once a task is moving
  // (doing) or finished (done) it's effectively already dispatched — and once a
  // todo/blocked card has been dispatched it hides until its status next changes,
  // so it can't be dispatched twice (see canDispatchTask).
  const canDispatch = canDispatchTask(task);
  // Stale = in-flight column with no activity for 20m+ (e.g. a dead/idle assignee
  // that never posted, or a never-picked-up card). Recomputed every render, so the
  // existing 5s poll re-render refreshes it — no new timer. The reaper
  // (useTasks lifecycle) re-routes such cards to god; this badge is the human tell.
  const stale = isTaskStale(task);
  const [showHistory, setShowHistory] = useState(false);
  const updates = task.updates ?? [];
  const last = updates.length ? updates[updates.length - 1] : undefined;
  const hasHistory = updates.length > 1;
  const unread = isTaskUnread(task);
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
        }}>{displayTitle(task)}</span>
        {unread && (
          <span
            title="New activity since you last opened this"
            style={{
              flexShrink: 0, marginTop: 1, padding: '1px 4px 0',
              background: 'var(--cth-coral)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              fontFamily: 'var(--cth-font-display)', fontSize: 7, color: 'var(--cth-ink-900)'
            }}
          >NEW</span>
        )}
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
        {task.planMode && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px 0',
            background: 'var(--cth-lilac)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)'
          }} title="Plan mode — agent plans only, then parks in Needs Approval">
            <Icon name="sparkle" /> PLAN
          </span>
        )}
        {stale && (
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px 0',
            boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-coral)'
          }} title="No activity for 20m+ — nobody picked this up (assignee may be offline). Re-nudging god automatically; click dispatch to re-send now.">
            ⏳ stale · not picked up 20m+
          </span>
        )}
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
          // Width fits the lane label rather than stretching across the card.
          style={{
            width: 'auto', minWidth: 0, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
            fontSize: 11, color: 'var(--cth-ink-900)', cursor: 'pointer'
          }}
        >
          {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>))}
          {/* needs-approval has no column of its own — it lives in the BLOCKED
              column's top sub-section, so append it as an extra lane option. */}
          <option value={NEEDS_APPROVAL.key}>{NEEDS_APPROVAL.label.toLowerCase()}</option>
        </select>
        {/* Inline priority (1-5), editable straight from the board — mirrors the
            form's priority picker. Tiny 'P' label + compact select, matching the
            lane select's styling. */}
        <span
          title={`Priority ${pr}/5`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
            fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)'
          }}
        >
          P
          <select
            value={pr}
            onChange={(e) => onSetPriority(Number(e.target.value))}
            style={{
              width: 'auto', minWidth: 0, padding: '2px 4px', background: 'var(--cth-paper-100)', border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', fontFamily: 'var(--cth-font-ui)',
              fontSize: 11, color: 'var(--cth-ink-900)', cursor: 'pointer'
            }}
          >
            {[1, 2, 3, 4, 5].map((p) => (<option key={p} value={p}>{p}</option>))}
          </select>
        </span>
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
            marginLeft: 'auto',
            padding: '3px 7px 2px', border: 'none', cursor: 'pointer',
            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            color: 'var(--cth-ink-900)'
          }}
        ><Icon name="folder" /></button>
      </div>
    </div>
  );
}

export function PriorityDots({ level }: { level: number }) {
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

// ─── Attachments ─────────────────────────────────────────────────────────────

/** Read a File as base64 (strip the data: URL prefix) for the attachment IPC. */
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const res = reader.result;
      resolve(typeof res === 'string' ? res.slice(res.indexOf(',') + 1) : '');
    };
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

/** One attachment tile: image attachments load their bytes lazily (via the
 *  attachment:read IPC → data URL) and render as a thumbnail; non-images show a
 *  filename chip. Each carries a remove (×) button when `onRemove` is given. */
function AttachmentTile({ att, onRemove }: { att: TaskAttachment; onRemove?: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (att.kind !== 'image') return;
    let alive = true;
    window.cth.attachmentRead(att.path)
      .then((r) => { if (alive) { if (r.ok) setUrl(r.dataUrl); else setErr(r.error); } })
      .catch((e) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [att.path, att.kind]);

  const remove = onRemove && (
    <button
      type="button"
      onClick={onRemove}
      title="Remove attachment"
      style={{
        position: 'absolute', top: -6, right: -6, width: 16, height: 16, padding: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: 'none', cursor: 'pointer', borderRadius: 0,
        background: 'var(--cth-coral)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
        color: 'var(--cth-ink-900)', fontSize: 10, lineHeight: '10px', fontWeight: 700
      }}
    >×</button>
  );

  if (att.kind === 'image') {
    return (
      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <span
          title={att.name}
          style={{
            width: 64, height: 64, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            overflow: 'hidden', background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
          }}
        >
          {url
            ? <img src={url} alt={att.name} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            : <span style={{ fontSize: 9, color: 'var(--cth-ink-300)', padding: 2, textAlign: 'center' }}>{err ? 'error' : '…'}</span>}
        </span>
        {remove}
      </span>
    );
  }
  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <span
        title={att.name}
        style={{
          maxWidth: 170, display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '4px 8px', overflow: 'hidden', whiteSpace: 'nowrap',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
        }}
      >
        <Icon name="folder" />
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{att.name}</span>
      </span>
      {remove}
    </span>
  );
}

// ─── Add-task form ─────────────────────────────────────────────────────────--

// The title is optional for new tasks: when it's blank we name the task from the
// first non-empty line of its description so board cards never render nameless.
function deriveTitleFromDescription(description: string): string {
  const firstLine = description.split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  if (!firstLine) return 'Untitled task';
  return firstLine.length > 80 ? `${firstLine.slice(0, 79).trimEnd()}…` : firstLine;
}

// What to SHOW for a task's title. Titles are optional, so an empty one falls back
// to the description's first line (then 'Untitled task') — never a blank card.
function displayTitle(task: ProjectTask): string {
  return task.title?.trim() ? task.title : deriveTitleFromDescription(task.description ?? '');
}

export function AddTaskForm({ agents, existing, initial, seed, initialMission, onCancel, onSubmit, onCreateAndDispatch, onDelete, onArchive, onDispatch }: {
  agents: { id: string; name: string; isGod?: boolean }[];
  existing: ProjectTask[];
  /** When set, the form edits this task instead of creating a new one. */
  initial?: ProjectTask;
  /** Prefill for a NEW task (create mode only — never sets `editing`). Used by
   *  "new task from selection" to seed the description + a back-reference dep. */
  seed?: { description?: string; dependsOn?: string[] };
  /** The task's current schedule, if any — seeds the SCHEDULE controls. */
  initialMission?: ScheduledMission;
  onCancel: () => void;
  onSubmit: (t: ProjectTask, schedule: ScheduleSpec) => void;
  /** Create the task and immediately dispatch it (new tasks only). */
  onCreateAndDispatch?: (t: ProjectTask, schedule: ScheduleSpec) => void;
  onDelete?: () => void;
  /** Archive the task being edited (reversible; existing tasks only). */
  onArchive?: () => void;
  /** Dispatch the task to its assignee now (existing, not-yet-running tasks). */
  onDispatch?: () => void;
}) {
  const editing = !!initial;
  // CREATE-mode draft persistence: the `task` left tab is conditionally mounted
  // (App.tsx), so flipping to another tab and back unmounts/remounts this form and
  // would drop what was typed. We read the persisted draft ONCE at mount (a lazy
  // initializer, non-reactive so typing never re-seeds) and mirror changes back to
  // the store below. Edit mode never touches the draft (its fields come from the
  // task being edited). See store `TaskDraft` / `openTask`.
  const setTaskDraft = useStore((s) => s.setTaskDraft);
  const [draft0] = useState(() => (initial ? null : useStore.getState().taskDraft));
  const [title, setTitle] = useState(initial?.title ?? draft0?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? draft0?.description ?? seed?.description ?? '');
  // New tasks get a WORKLOAD-AWARE default (pickAutoAssignee, task bii2): Michael
  // when he's free, else the least-loaded live teammate — so work spreads instead
  // of always piling on Michael. Still an editable <select> (the human overrides).
  // Lazy initializer = computed ONCE when the form opens (same pattern as draft0);
  // a persisted draft or an edit's existing assignee take precedence.
  const [assignee, setAssignee] = useState(() =>
    initial?.assignee ?? draft0?.assignee ?? (editing ? '' : pickAutoAssignee(existing))
  );
  const [priority, setPriority] = useState(initial?.priority ?? draft0?.priority ?? 3);
  const [deps, setDeps] = useState<string[]>(initial?.dependsOn ?? draft0?.deps ?? seed?.dependsOn ?? []);
  const [status, setStatus] = useState<Status>(initial?.status ?? 'todo');
  // Plan mode: when dispatched, the agent produces a PLAN (not an implementation)
  // and parks the task in Needs Approval for sign-off (see useTasks.dispatchBody).
  const [planMode, setPlanMode] = useState<boolean>(initial?.planMode ?? draft0?.planMode ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Dispatch is offered only for not-yet-running tasks (mirrors the board card),
  // and hidden once an existing card has been dispatched until its status next
  // changes. Gate on the form's live status + the persisted dispatch stamps.
  const canDispatch = initial
    ? canDispatchTask({ ...initial, status })
    : status === 'todo' || status === 'blocked';
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

  // Attachments: pasted images + attached files. A CREATE-mode draft mints a
  // stable id ONCE (lazy initializer, restored from the draft on a tab-flick
  // remount) so files written to `attachments/<id>/` land in the folder the task
  // is ultimately saved with. Edit mode reuses the real task id.
  const [createId] = useState(() => draft0?.id ?? shortId());
  const attachTaskId = initial?.id ?? createId;
  const [attachments, setAttachments] = useState<TaskAttachment[]>(
    initial?.attachments ?? draft0?.attachments ?? []
  );
  const [attaching, setAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Persist each dropped/pasted/picked file to disk and append its reference.
  // The on-disk name is uniquified (pasted images often share "image.png") while
  // the displayed name keeps the original.
  const addFiles = useCallback(async (files: File[]) => {
    const list = files.filter((f) => f && f.size > 0);
    if (!list.length) return;
    setAttaching(true);
    setAttachError(null);
    try {
      for (const file of list) {
        try {
          const b64 = await fileToBase64(file);
          const isImg = file.type.startsWith('image/');
          const extMatch = file.name.match(/\.[a-z0-9]+$/i);
          const ext = extMatch ? extMatch[0] : (isImg ? `.${(file.type.split('/')[1] || 'png')}` : '');
          const uniq = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}${ext}`;
          const res = await window.cth.attachmentWrite(attachTaskId, uniq, b64);
          if (res.ok) {
            const att: TaskAttachment = { name: file.name || uniq, path: res.rel, kind: isImg ? 'image' : 'file' };
            setAttachments((prev) => [...prev, att]);
          } else {
            setAttachError(res.error);
          }
        } catch (e) {
          setAttachError(e instanceof Error ? e.message : String(e));
        }
      }
    } finally {
      setAttaching(false);
    }
  }, [attachTaskId]);

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path));

  // Programmatic setDescription() (dictation) updates the controlled textarea's
  // value, but the new text isn't *painted* until the user interacts:
  // the Pixi WebGL canvas (scene/office) runs a continuous ticker on its own
  // compositor layer, and Chromium/Electron doesn't flush the textarea's layer
  // after a non-input-driven update. Focusing on the next frame (plus a reflow
  // read) forces that layer to repaint so the text shows immediately.
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nudgeRepaint = useCallback(() => {
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();           // primary: invalidates + repaints this layer
      void el.offsetHeight; // backup: forces a synchronous reflow
    });
  }, []);

  // Deliberately omit `updates`/`statusUpdatedAt` — the form never carries
  // agent-owned data; the main-process writeTasks merge restores them from disk.
  const buildTask = (): ProjectTask => ({
    id: attachTaskId,
    // Title is optional — fall back to a title derived from the description so a
    // task is never stored (or shown on the board) without a name.
    title: title.trim() || deriveTitleFromDescription(description),
    description: description.trim() || undefined,
    assignee: assignee || undefined,
    status: editing ? status : 'todo',
    dependsOn: deps,
    priority,
    createdAt: initial?.createdAt ?? new Date().toISOString(),
    // Carry the archive flag through an edit so saving the form can't un-archive.
    archived: initial?.archived,
    attachments: attachments.length ? attachments : undefined,
    planMode: planMode || undefined
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

  // Mirror the live CREATE-mode draft into the store on every change so it survives
  // a left-tab switch (read back by `draft0` on remount). No-op while editing.
  useEffect(() => {
    if (editing) return;
    setTaskDraft({ title, description, assignee, priority, deps, id: createId, attachments, planMode });
  }, [editing, setTaskDraft, title, description, assignee, priority, deps, createId, attachments, planMode]);

  // The title is optional when CREATING — a new task just needs *something*
  // (a title or a description), and a blank title is derived from the description
  // in buildTask. EDITING still requires a title so a saved task can't lose its
  // name by clearing the field.
  const canSubmit = editing ? !!title.trim() : !!(title.trim() || description.trim());

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(buildTask(), buildSchedule());
  };

  // Keyboard submit. In CREATE mode "create & dispatch" is the primary action
  // (Enter in the title, or ⌘/Ctrl+Enter anywhere in the form); EDIT mode has no
  // dispatch-on-create, so it falls back to saving.
  const submitPrimary = () => {
    if (!canSubmit) return;
    if (!editing && onCreateAndDispatch) onCreateAndDispatch(buildTask(), buildSchedule());
    else submit();
  };

  const toggleDep = (id: string) => {
    setDeps((d) => (d.includes(id) ? d.filter((x) => x !== id) : [...d, id]));
  };

  return (
    <div
      style={{
        padding: '0 10px 8px', flexShrink: 0,
        // Highlight the whole form as a drop target while dragging files over it.
        outline: dragOver ? '2px dashed var(--cth-sky)' : 'none', outlineOffset: -2
      }}
      // ⌘/Ctrl+Enter from ANY field (incl. the description textarea, where plain
      // Enter must stay a newline) creates & dispatches. The title's own handler
      // ignores modifier+Enter, so it bubbles here and fires exactly once.
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submitPrimary(); }
      }}
      // Drag-drop files anywhere onto the form to attach them.
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) {
          e.preventDefault();
          if (!dragOver) setDragOver(true);
        }
      }}
      onDragLeave={(e) => { if (e.currentTarget === e.target) setDragOver(false); }}
      onDrop={(e) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (!files.length) return;
        e.preventDefault();
        setDragOver(false);
        void addFiles(files);
      }}
    >
      <PixelPanel variant="inset" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          // Plain Enter in the single-line title creates & dispatches the task
          // (the requested shortcut). Modifier+Enter is left to the form-level
          // handler above so it works from the textarea too.
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
              e.preventDefault();
              submitPrimary();
            }
          }}
          placeholder={editing ? 'Task title…' : 'Task title… (optional)'}
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <textarea
            ref={textareaRef}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            // Paste an image from the clipboard to attach it. Only intercept when
            // the clipboard actually holds image files — plain text paste flows
            // through to the textarea untouched.
            onPaste={(e) => {
              const imgs = Array.from(e.clipboardData?.items ?? [])
                .filter((it) => it.kind === 'file' && it.type.startsWith('image/'));
              if (!imgs.length) return;
              e.preventDefault();
              const files = imgs.map((it) => it.getAsFile()).filter((f): f is File => !!f);
              void addFiles(files);
            }}
            rows={5}
            placeholder="Description / context (optional) — paste or drop images here"
            style={{ ...inputStyle, flex: 1, resize: 'vertical', fontFamily: 'var(--cth-font-mono)' }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'stretch', flexShrink: 0 }}>
            <MicButton onTranscript={(t) => { setDescription((p) => (p ? `${p} ${t}` : t)); nudgeRepaint(); }} />
            {/* Attach files via a hidden picker (paste/drag also work). */}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={attaching}
              title="Attach files — or paste an image / drop files onto the form"
              style={{
                height: 30, padding: '0 8px',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5,
                border: 'none', cursor: attaching ? 'progress' : 'pointer',
                background: 'var(--cth-cream-100)', color: 'var(--cth-ink-900)',
                boxShadow: 'inset 0 0 0 2px var(--cth-ink-700), 0 2px 0 var(--cth-ink-700)',
                fontFamily: 'var(--cth-font-ui)', fontSize: 13
              }}
            >
              <Icon name="folder" /> {attaching ? 'saving…' : 'attach'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = ''; // allow re-picking the same file
              }}
            />
          </div>
        </div>
        {attachError && (
          <div style={{ fontSize: 11, lineHeight: '14px', color: 'var(--cth-coral)' }}>attach failed: {attachError}</div>
        )}
        {attachments.length > 0 && (
          <div>
            <div style={{ ...labelStyle, marginBottom: 4 }}>attachments ({attachments.length})</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'flex-start' }}>
              {attachments.map((att) => (
                <AttachmentTile key={att.path} att={att} onRemove={() => removeAttachment(att.path)} />
              ))}
            </div>
          </div>
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
                {/* needs-approval lives in the BLOCKED column's top sub-section,
                    not its own column — offer it as an extra lane option. */}
                <option value={NEEDS_APPROVAL.key}>{NEEDS_APPROVAL.label.toLowerCase()}</option>
              </select>
            </>
          )}
        </div>

        {/* Plan mode: dispatch tells the agent to PLAN (not implement), then park
            the task in Needs Approval for sign-off (mirrors AddAgentModal's
            isolate checkbox). */}
        <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={planMode}
            onChange={(e) => setPlanMode(e.target.checked)}
            style={{ width: 16, height: 16, cursor: 'pointer' }}
          />
          <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-900)' }}>
            Plan mode — agent plans only, then parks in Needs Approval
          </span>
        </label>

        {existing.length > 0 && (
          <div>
            {/* Dependencies are OPT-IN: a fresh task starts with NONE selected (deps
                init is `[] `). This box lists existing tasks as togglable chips —
                a dimmed `+` chip is an AVAILABLE option (not a dependency), a bold
                `✓` sky chip is a SELECTED dependency. The count + "clear" make it
                unambiguous that nothing is depended-on until you tap it. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={labelStyle}>depends on{deps.length > 0 ? ` (${deps.length})` : ''}</span>
              {deps.length > 0 && (
                <button
                  type="button"
                  onClick={() => setDeps([])}
                  title="Clear all dependencies"
                  style={{
                    padding: '1px 7px 0', border: 'none', cursor: 'pointer',
                    background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
                    color: 'var(--cth-ink-700)'
                  }}
                >clear</button>
              )}
              <span style={{ fontSize: 10, color: 'var(--cth-ink-300)' }}>
                {deps.length === 0 ? 'none — tap a task to add' : 'tap to toggle'}
              </span>
            </div>
            <div style={{
              display: 'flex', flexWrap: 'wrap', gap: 4, maxHeight: 84, overflowY: 'auto',
              padding: 4, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              {existing.map((t) => {
                const on = deps.includes(t.id);
                return (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => toggleDep(t.id)}
                    title={on ? `Remove dependency: ${t.title}` : `Add dependency: ${t.title}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', gap: 4,
                      maxWidth: 170, overflow: 'hidden', whiteSpace: 'nowrap',
                      padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                      background: on ? 'var(--cth-sky)' : 'var(--cth-cream-200)',
                      boxShadow: `inset 0 0 0 1px ${on ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)'}`,
                      fontFamily: 'var(--cth-font-ui)', fontSize: 11,
                      color: on ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
                      opacity: on ? 1 : 0.7, fontWeight: on ? 700 : 400
                    }}
                  >
                    <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, flexShrink: 0 }}>{on ? '✓' : '+'}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
                  </button>
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
          <PixelButton variant="primary" size="sm" onClick={submit} disabled={!canSubmit}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="check" /> {editing ? 'save' : 'create'}
            </span>
          </PixelButton>
          {editing && onDispatch && canDispatch && (
            <PixelButton variant="primary" size="sm" onClick={onDispatch}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Icon name="arrow-right" /> dispatch
              </span>
            </PixelButton>
          )}
          {!editing && onCreateAndDispatch && (
            <PixelButton
              variant="primary"
              size="sm"
              onClick={() => { if (canSubmit) onCreateAndDispatch(buildTask(), buildSchedule()); }}
              disabled={!canSubmit}
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
