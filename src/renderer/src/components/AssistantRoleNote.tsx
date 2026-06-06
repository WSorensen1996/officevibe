import { Icon } from './Icon';
import { useStore } from '@/store/store';

/** Footer shown under the assistant's terminal in place of a message composer.
 *  Dwight is Michael's co-orchestrator — work is delegated to him by Michael
 *  rather than typed here, so this explains his role and points to Michael. */
export function AssistantRoleNote() {
  const select = useStore((s) => s.select);

  return (
    <div style={{
      flexShrink: 0,
      borderTop: '1px solid var(--cth-ink-700)',
      background: 'var(--cth-cream-100)',
      padding: 8,
      display: 'flex', alignItems: 'center', gap: 8
    }}>
      <Icon name="sparkle" />
      <div style={{ flex: 1, minWidth: 0, fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)' }}>
        Dwight is Michael's co-orchestrator — he handles the todo batches Michael delegates and can fan them out to the team. Michael stays primary (owns the board + the human channel).
      </div>
      <button
        onClick={() => select('god')}
        style={{
          flexShrink: 0,
          padding: '3px 8px 2px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
        }}
      >open Michael</button>
    </div>
  );
}
