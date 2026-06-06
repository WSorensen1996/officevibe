import { useEffect, useState } from 'react';
import { useStore, NEW_TASK_ID } from '@/store/store';
import { useTasks } from '@/hooks/useTasks';
import { Markdown } from './Markdown';
import { Section, Scroll, Muted } from './CommandCenterPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { PriorityDots, AddTaskForm } from './TasksKanban';
import {
  type Status,
  COLUMNS,
  UPDATE_COLOR,
  shortWhen,
  intervalLabel
} from './tasks/taskShared';

/**
 * The full-card view for a single task, opened from the Kanban board into the
 * spacious left column (the transient `task` left tab). Shows the whole title +
 * description and EVERY agent update at full length (rendered as Markdown), and
 * carries the same interactions as the card (status, dispatch, edit, archive,
 * delete) — driven through the shared `useTasks` hook so the board stays in sync.
 */
export function TaskDetailPanel() {
  const openTaskId = useStore((s) => s.openTaskId);
  const openTaskMode = useStore((s) => s.openTaskMode);
  const openTask = useStore((s) => s.openTask);
  const agents = useStore((s) => s.agents);
  const {
    tasks,
    dispatchMsg,
    missionFor,
    addTask,
    moveTask,
    dispatchTask,
    archiveTask,
    deleteTask,
    saveEdit
  } = useTasks();

  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The sentinel id means "create a brand-new task" — there's no real task to find.
  const creating = openTaskId === NEW_TASK_ID;
  const task = tasks.find((t) => t.id === openTaskId);

  // Esc closes the full-card view (mirrors FullscreenFileEditor / Terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') { e.preventDefault(); openTask(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openTask]);

  // Reset the local confirm state and seed the edit toggle from the open mode
  // whenever the open task changes — a board title-click (mode 'edit') lands
  // straight in the form; the expand button (mode 'view') lands in the read view.
  useEffect(() => { setEditing(openTaskMode === 'edit'); setConfirmDelete(false); }, [openTaskId, openTaskMode]);

  // Create mode — the spacious left panel hosts the new-task form (the board's
  // "add task" button opens this instead of an inline form). Submitting closes
  // the panel and returns to the previous tab.
  if (creating) {
    return (
      <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
        <div style={{
          flexShrink: 0, padding: '10px 12px', background: 'var(--cth-cream-100)',
          borderBottom: '2px solid var(--cth-ink-900)', display: 'flex', alignItems: 'center', gap: 8
        }}>
          <h1 style={{
            flex: 1, minWidth: 0, margin: 0,
            fontFamily: 'var(--cth-font-display)', fontSize: 12, color: 'var(--cth-ink-900)'
          }}>NEW TASK</h1>
          <button
            onClick={() => openTask(null)}
            title="Close (esc)"
            style={{
              flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '4px 8px', border: 'none', cursor: 'pointer',
              background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              color: 'var(--cth-ink-900)'
            }}
          ><Icon name="x" /></button>
        </div>
        <Scroll>
          <AddTaskForm
            agents={agents}
            existing={tasks}
            onCancel={() => openTask(null)}
            onSubmit={(t, schedule) => { addTask(t, schedule); openTask(null); }}
            onCreateAndDispatch={(t, schedule) => { addTask(t, schedule); dispatchTask(t); openTask(null); }}
          />
        </Scroll>
      </div>
    );
  }

  // The open task vanished (archived/deleted from the board or by an agent).
  if (!task) {
    return (
      <div style={emptyWrap}>
        <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-500)' }}>
          TASK UNAVAILABLE
        </div>
        <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
          This task is no longer on the board.
        </p>
        <PixelButton variant="secondary" size="md" onClick={() => openTask(null)}>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="minimize" /> back to board
          </span>
        </PixelButton>
      </div>
    );
  }

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? id) : undefined;

  const pr = Math.max(1, Math.min(5, task.priority));
  const updates = task.updates ?? [];
  const canDispatch = task.status === 'todo' || task.status === 'blocked';
  const statusCol = COLUMNS.find((c) => c.key === task.status);
  const mission = missionFor(task.id);

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      {/* Header */}
      <div style={{
        flexShrink: 0, padding: '10px 12px', background: 'var(--cth-cream-100)',
        borderBottom: '2px solid var(--cth-ink-900)', display: 'flex', flexDirection: 'column', gap: 8
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <span style={{ marginTop: 3 }}><PriorityDots level={pr} /></span>
          <h1 style={{
            flex: 1, minWidth: 0, margin: 0,
            fontFamily: 'var(--cth-font-ui)', fontSize: 17, lineHeight: '22px',
            color: 'var(--cth-ink-900)', wordBreak: 'break-word'
          }}>{task.title}</h1>
          <button
            onClick={() => openTask(null)}
            title="Close (esc)"
            style={{
              flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              padding: '4px 8px', border: 'none', cursor: 'pointer',
              background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              color: 'var(--cth-ink-900)'
            }}
          ><Icon name="x" /></button>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {task.assignee
            ? <PixelBadge status="working" label={nameFor(task.assignee) ?? task.assignee} />
            : <span style={{ fontSize: 11, color: 'var(--cth-ink-300)' }}>unassigned</span>}
          <span style={{
            display: 'inline-flex', alignItems: 'center', padding: '1px 8px 0',
            background: statusCol?.accent ?? 'var(--cth-cream-200)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)'
          }}>{statusCol?.label ?? task.status.toUpperCase()}</span>
          {task.dependsOn.length > 0 && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3, padding: '1px 6px 0',
              background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-700)'
            }} title={`Depends on ${task.dependsOn.length} task(s)`}>
              <Icon name="arrow-right" /> {task.dependsOn.length} dep{task.dependsOn.length === 1 ? '' : 's'}
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
              }}>
                <Icon name="bell" /> {text}{paused ? ' off' : ''}
              </span>
            );
          })()}
        </div>
      </div>

      {/* Body — read view or in-place edit form */}
      {editing ? (
        <Scroll>
          <AddTaskForm
            agents={agents}
            existing={tasks.filter((t) => t.id !== task.id)}
            initial={task}
            initialMission={mission}
            onCancel={() => setEditing(false)}
            onSubmit={(t, schedule) => { saveEdit(t, schedule); setEditing(false); }}
            onDelete={() => { deleteTask(task.id); openTask(null); }}
            onArchive={() => { archiveTask(task.id); openTask(null); }}
          />
        </Scroll>
      ) : (
        <Scroll>
          <Section title="DESCRIPTION">
            {task.description?.trim()
              ? <Markdown>{task.description}</Markdown>
              : <Muted>No description.</Muted>}
          </Section>

          <Section title={`UPDATES (${updates.length})`}>
            {updates.length === 0 && <Muted>No updates yet.</Muted>}
            {updates.map((u, i) => (
              <div key={i} style={{
                marginBottom: 10, padding: 8,
                background: 'var(--cth-paper-100)', boxShadow: `inset 0 0 0 1px ${UPDATE_COLOR[u.kind]}`
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <span style={{
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
                    color: UPDATE_COLOR[u.kind]
                  }}>{u.kind}</span>
                  <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
                    {nameFor(u.by) ?? u.by}
                    {u.ts ? ` · ${new Date(u.ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : ''}
                  </span>
                </div>
                <Markdown>{u.text}</Markdown>
              </div>
            ))}
          </Section>
        </Scroll>
      )}

      {/* Action bar (hidden while the edit form owns the controls) */}
      {!editing && (
        <div style={{
          flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
          padding: '8px 12px', borderTop: '1px solid var(--cth-ink-300)', background: 'var(--cth-cream-100)'
        }}>
          <label style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-500)' }}>status</label>
          <select
            value={task.status}
            onChange={(e) => moveTask(task.id, e.target.value as Status)}
            style={{
              padding: '3px 6px', background: 'var(--cth-paper-100)', border: 'none',
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', fontFamily: 'var(--cth-font-ui)',
              fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer'
            }}
          >
            {COLUMNS.map((c) => (<option key={c.key} value={c.key}>{c.label.toLowerCase()}</option>))}
          </select>
          {canDispatch && (
            <PixelButton variant="primary" size="sm" onClick={() => dispatchTask(task)}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
                <Icon name="arrow-right" /> dispatch
              </span>
            </PixelButton>
          )}
          <PixelButton variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3 }}>
              <Icon name="gear" /> edit
            </span>
          </PixelButton>
          {dispatchMsg && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{dispatchMsg}</span>}
          <button
            onClick={() => { archiveTask(task.id); openTask(null); }}
            title="Archive (file it away — restorable from the ARCHIVED section)"
            style={{
              marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 9px 2px', border: 'none', cursor: 'pointer',
              background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
            }}
          ><Icon name="folder" /> archive</button>
          <button
            onClick={() => {
              if (confirmDelete) { deleteTask(task.id); openTask(null); }
              else setConfirmDelete(true);
            }}
            onBlur={() => setConfirmDelete(false)}
            title="Delete this task"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '3px 9px 2px', border: 'none', cursor: 'pointer',
              background: confirmDelete ? 'var(--cth-coral)' : 'var(--cth-cream-200)',
              boxShadow: `inset 0 0 0 1px ${confirmDelete ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)'}`,
              fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
            }}
          ><Icon name="x" /> {confirmDelete ? 'confirm delete' : 'delete'}</button>
        </div>
      )}
    </div>
  );
}

const emptyWrap: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  justifyContent: 'center', alignItems: 'center', gap: 12, padding: 16,
  background: 'var(--cth-paper-200)'
};
