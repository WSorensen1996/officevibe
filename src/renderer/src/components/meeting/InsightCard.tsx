import { useState } from 'react';
import { useStore, NEW_TASK_ID } from '@/store/store';
import { useTasks } from '@/hooks/useTasks';
import { shortId } from '../tasks/taskShared';
import { PixelButton } from '../PixelButton';
import type { MeetingInsight, InsightKind } from '@/lib/meeting/types';

/** Kind → accent color, echoing the task-update palette so insight cards read
 *  like the rest of the app's status language. */
const KIND_COLOR: Record<InsightKind, string> = {
  'recommendation': 'var(--cth-sky)',
  'proposal': 'var(--cth-lemon, #EAB308)',
  'action-item': 'var(--cth-status-doing, #14B8A6)',
  'note': 'var(--cth-ink-300)',
  'question': 'var(--cth-status-blocked)'
};

/** The reference block a meeting task carries: provenance back to the meeting +
 *  the analyst's quote, sent to the agent on dispatch but kept out of the
 *  visible description (the same contract as "new task from selection"). */
function taskReference(insight: MeetingInsight, meetingTitle?: string): string {
  const lines = [
    `From meeting${meetingTitle ? ` "${meetingTitle}"` : ''} (${insight.meetingId}) — ${insight.kind} by the meeting analyst:`,
    insight.text
  ];
  if (insight.quote) lines.push(`Transcript quote: "${insight.quote}"`);
  return lines.join('\n');
}

/**
 * One analyst insight, with the task kick-off actions:
 *   create task        → seeds the CREATE form (title/description/reference) for review
 *   create & dispatch  → lands a TODO card AND dispatches it through the normal
 *                        flow ([task:id] marker, god triage, reroute safety)
 */
export function InsightCard({ insight, meetingTitle }: { insight: MeetingInsight; meetingTitle?: string }) {
  const setNewTaskSeed = useStore((s) => s.setNewTaskSeed);
  const openTask = useStore((s) => s.openTask);
  const startFloor = useStore((s) => s.startFloor);
  const { addTask, dispatchTask } = useTasks();
  const [done, setDone] = useState<string | null>(null);

  const title = insight.suggestedTask?.title ?? '';
  const description = insight.suggestedTask?.description ?? insight.text;

  const openCreateForm = (): void => {
    setNewTaskSeed({
      title: title || undefined,
      description,
      reference: taskReference(insight, meetingTitle)
    });
    openTask(NEW_TASK_ID);
  };

  const createAndDispatch = (): void => {
    const t = {
      id: shortId(),
      title: title || insight.text.slice(0, 80),
      description,
      reference: taskReference(insight, meetingTitle),
      status: 'todo' as const,
      dependsOn: [],
      priority: 3,
      createdAt: new Date().toISOString()
    };
    addTask(t, { mode: 'none' });
    void dispatchTask(t);
    startFloor(); // let the wake-nudge loop deliver even with auto-pilot off
    setDone('task dispatched');
    setTimeout(() => setDone(null), 4000);
  };

  const color = KIND_COLOR[insight.kind] ?? 'var(--cth-ink-300)';
  return (
    <div style={{
      background: 'var(--cth-cream-100)',
      boxShadow: `inset 2px 0 0 ${color}, inset 0 0 0 1px var(--cth-ink-300)`,
      padding: '8px 10px',
      display: 'flex', flexDirection: 'column', gap: 6
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
          color: 'var(--cth-ink-700)', textTransform: 'uppercase'
        }}>
          {insight.kind.replace('-', ' ')}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--cth-ink-500)' }}>
          {new Date(insight.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap' }}>
        {insight.text}
      </div>
      {insight.quote && (
        <div style={{
          fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)',
          fontStyle: 'italic', boxShadow: 'inset 2px 0 0 var(--cth-ink-300)', paddingLeft: 6
        }}>
          “{insight.quote}”
        </div>
      )}
      {insight.suggestedTask && (
        <div style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>
          ↳ suggested task: <strong>{insight.suggestedTask.title}</strong>
        </div>
      )}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <PixelButton variant="secondary" size="sm" onClick={openCreateForm}>create task</PixelButton>
        <PixelButton variant="primary" size="sm" onClick={createAndDispatch}>create &amp; dispatch</PixelButton>
        {done && <span style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>{done} ✓</span>}
      </div>
    </div>
  );
}
