import { useRef, useState, type ReactNode } from 'react';
import { useStore, NEW_TASK_ID } from '@/store/store';
import { Icon } from '../Icon';

/**
 * Wraps a transcript pane and, on a non-empty text selection, floats a
 * "create task from selection" button next to the cursor — the meeting twin of
 * TaskDetailPanel's SelectionToTask. The selected lines ride as the new task's
 * `reference` (sent to the agent on dispatch, kept out of the description) with
 * meeting provenance, so "let's also fix the export bug" becomes a dispatchable
 * card in two clicks.
 */
export function TranscriptSelectionToTask({ meeting, children, style }: {
  meeting: { id: string; title: string };
  children: ReactNode;
  /** Layout of the wrapper itself (flex sizing etc.) — position:relative is fixed. */
  style?: React.CSSProperties;
}) {
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
    const reference = `Transcript excerpt from meeting "${meeting.title}" (${meeting.id}):\n${pin.text}`;
    setNewTaskSeed({ reference });
    setPin(null);
    openTask(NEW_TASK_ID);
  };

  return (
    <div ref={ref} style={{ display: 'flex', minWidth: 0, minHeight: 0, ...style, position: 'relative' }} onMouseUp={onMouseUp} onMouseDown={() => setPin(null)}>
      {children}
      {pin && (
        <button
          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); }}
          onClick={create}
          style={{
            position: 'absolute', left: Math.max(0, pin.x), top: pin.y + 10, zIndex: 20,
            display: 'inline-flex', alignItems: 'center', gap: 4, padding: '4px 8px',
            border: 'none', cursor: 'pointer', whiteSpace: 'nowrap',
            background: 'var(--cth-ink-900)', color: 'var(--cth-cream-100)',
            fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
            boxShadow: '0 2px 6px rgba(0,0,0,0.3)'
          }}
        >
          <Icon name="plus" /> create task from selection
        </button>
      )}
    </div>
  );
}
