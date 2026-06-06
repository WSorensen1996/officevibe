import { useEffect, useRef, useState } from 'react';
import { useStore, NEW_TASK_ID } from '@/store/store';
import { useTasks } from '@/hooks/useTasks';
import { Markdown } from './Markdown';
import { Section, Scroll, Muted } from './CommandCenterPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { PriorityDots, AddTaskForm } from './TasksKanban';
import {
  COLUMNS,
  UPDATE_COLOR,
  shortWhen,
  intervalLabel,
  extractDeliverableSlugs,
  isTaskUnread
} from './tasks/taskShared';

/** The agent update history (display-only). Shared by the read view and the edit
 *  view so the full progress log is visible however the card was opened. Renders
 *  every update at full length (Markdown) with its kind, author, and timestamp. */
function TaskUpdates({ updates, nameFor }: {
  updates: { kind: keyof typeof UPDATE_COLOR; by?: string; ts?: string; text: string }[];
  nameFor: (id?: string) => string | undefined;
}) {
  return (
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
  );
}

/** The full markdown body of one deliverable, loaded on demand via knowledgeGet
 *  (which — post knowledge.ts fix — resolves bare `knowledge/<slug>.md` files too).
 *  Rendered inline so the full conclusion sits right under the task that produced it. */
function DeliverableReader({ slug }: { slug: string }) {
  const [state, setState] = useState<{ body?: string; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let alive = true;
    setState({ loading: true });
    window.cth.knowledgeGet(slug)
      .then((r) => {
        if (!alive) return;
        if (r.ok && r.skill) setState({ loading: false, body: r.skill.body });
        else setState({ loading: false, error: r.error ?? 'could not load deliverable' });
      })
      .catch((e) => { if (alive) setState({ loading: false, error: e instanceof Error ? e.message : String(e) }); });
    return () => { alive = false; };
  }, [slug]);

  return (
    <div style={{ marginTop: 6, padding: 10, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
      {state.loading && <Muted>loading…</Muted>}
      {state.error && <div style={{ fontSize: 13, color: 'var(--cth-coral)' }}>{state.error}</div>}
      {state.body !== undefined && <Markdown>{state.body}</Markdown>}
    </div>
  );
}

/** The RESULT section: the knowledge deliverables this task produced, each
 *  expandable to its full markdown. A lone deliverable auto-expands so the
 *  conclusion is visible immediately; multiples list collapsed. Renders nothing
 *  when the task referenced no deliverable (no noise on ordinary tasks). */
function Deliverables({ slugs }: { slugs: string[] }) {
  const [open, setOpen] = useState<string | null>(slugs.length === 1 ? slugs[0] : null);
  if (slugs.length === 0) return null;
  return (
    <Section title="RESULT">
      {slugs.map((slug) => {
        const expanded = open === slug;
        return (
          <div key={slug} style={{ marginBottom: 8 }}>
            <button
              onClick={() => setOpen((s) => (s === slug ? null : slug))}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, width: '100%', textAlign: 'left',
                padding: '6px 8px', border: 'none', cursor: 'pointer',
                background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)', fontSize: 13
              }}
            >
              <Icon name={expanded ? 'minimize' : 'expand'} />
              <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {slug}.md
              </span>
            </button>
            {expanded && <DeliverableReader slug={slug} />}
          </div>
        );
      })}
    </Section>
  );
}

/** Wraps the result/updates region and, on a non-empty text selection, floats a
 *  "new task from selection" button next to the cursor. Clicking seeds the CREATE
 *  form with the selected text + a back-reference, links the new task as depending
 *  on this one, and opens create mode. The button stops mousedown propagation so
 *  the wrapper's clear-on-mousedown doesn't kill it before the click lands. */
function SelectionToTask({ task, children }: { task: { id: string; title: string }; children: React.ReactNode }) {
  const setNewTaskSeed = useStore((s) => s.setNewTaskSeed);
  const openTask = useStore((s) => s.openTask);
  const ref = useRef<HTMLDivElement>(null);
  const [pin, setPin] = useState<{ text: string; x: number; y: number } | null>(null);

  const onMouseUp = (e: React.MouseEvent): void => {
    const sel = window.getSelection()?.toString().trim() ?? '';
    if (!sel) { setPin(null); return; }
    const rect = ref.current?.getBoundingClientRect();
    setPin({ text: sel, x: e.clientX - (rect?.left ?? 0), y: e.clientY - (rect?.top ?? 0) });
  };

  const create = (): void => {
    if (!pin) return;
    const description = `${pin.text}\n\n— from task "${task.title}" [task:${task.id}]`;
    setNewTaskSeed({ description, dependsOn: [task.id] });
    setPin(null);
    openTask(NEW_TASK_ID);
  };

  return (
    <div ref={ref} style={{ position: 'relative' }} onMouseUp={onMouseUp} onMouseDown={() => setPin(null)}>
      {children}
      {pin && (
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={create}
          style={{
            position: 'absolute', left: pin.x, top: pin.y + 10, zIndex: 20,
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px',
            border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
            background: 'var(--cth-ink-900)', color: 'var(--cth-cream-100)',
            fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
          }}
        >
          <Icon name="plus" /> new task from selection
        </button>
      )}
    </div>
  );
}

/**
 * The full-card view for a single task, opened from the Kanban board into the
 * spacious left column (the transient `task` left tab). Shows the whole title +
 * description and EVERY agent update at full length (rendered as Markdown), and
 * carries the same interactions as the card (status, dispatch, edit, archive,
 * delete) — driven through the shared `useTasks` hook so the board stays in sync.
 */
export function TaskDetailPanel() {
  const openTaskId = useStore((s) => s.openTaskId);
  const openTask = useStore((s) => s.openTask);
  const newTaskSeed = useStore((s) => s.newTaskSeed);
  const setNewTaskSeed = useStore((s) => s.setNewTaskSeed);
  const agents = useStore((s) => s.agents);
  const {
    tasks,
    missionFor,
    addTask,
    dispatchTask,
    archiveTask,
    deleteTask,
    markTaskRead,
    saveEdit
  } = useTasks();

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

  // Opening a card marks it read (clears its NEW pill). markTaskRead no-ops when
  // already read, so this won't loop; a new update arriving while the card is open
  // re-flags it unread (updates.length changes) and this re-marks it once.
  useEffect(() => {
    if (task && isTaskUnread(task)) markTaskRead(task.id);
  }, [task?.id, task?.updates?.length, task?.viewedAt, markTaskRead]);

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
            seed={newTaskSeed ?? undefined}
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
  const deliverables = extractDeliverableSlugs(task);
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

      {/* Body — a single always-editable view in a two-pane column: the edit form
          takes its natural height (caps at 60% and scrolls) while the update
          history fills the rest and scrolls on its own. Keyed by task id so the
          form re-seeds when a different task is opened. */}
      <div style={bodyColumn}>
        <div style={{ ...topPane, padding: 0 }}>
          <AddTaskForm
            key={task.id}
            agents={agents}
            existing={tasks.filter((t) => t.id !== task.id)}
            initial={task}
            initialMission={mission}
            onCancel={() => openTask(null)}
            onSubmit={(t, schedule) => saveEdit(t, schedule)}
            onDelete={() => { deleteTask(task.id); openTask(null); }}
            onArchive={() => { archiveTask(task.id); openTask(null); }}
            onDispatch={() => dispatchTask(task)}
          />
        </div>
        <div style={bottomPane}>
          <SelectionToTask task={task}>
            <Deliverables slugs={deliverables} />
            <TaskUpdates updates={updates} nameFor={nameFor} />
          </SelectionToTask>
        </div>
      </div>
    </div>
  );
}

const emptyWrap: React.CSSProperties = {
  height: '100%', display: 'flex', flexDirection: 'column',
  justifyContent: 'center', alignItems: 'center', gap: 12, padding: 16,
  background: 'var(--cth-paper-200)'
};

// Two-pane body: top pane (form/description) sits above the update history.
const bodyColumn: React.CSSProperties = {
  flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)'
};
// Natural height, but caps at 60% and scrolls so it never starves the history.
const topPane: React.CSSProperties = {
  flex: '0 1 auto', minHeight: 0, maxHeight: '60%', overflowY: 'auto'
};
// Fills the remaining height and scrolls independently.
const bottomPane: React.CSSProperties = {
  flex: '1 1 0', minHeight: 0, overflowY: 'auto', padding: '0 10px 10px'
};
