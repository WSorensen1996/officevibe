import { useStore, type Agent } from '@/store/store';
import { Icon, type IconName } from './Icon';

/** Small pulsing cue chips shown next to the SELECTED agent's name. They flag
 *  states the user should glance at and give a one-click path to the right tab:
 *  - browsing  → the agent is working in the browser  → open the Browser tab
 *  - needs you → the agent is blocked on your input    → open the Messages tab
 *  Each cue hides while its destination tab is already active (no redundant
 *  blinking while you're looking right at it). Renders nothing when idle. */
export function AttentionCues({ agent }: { agent: Agent }) {
  const leftTab = useStore((s) => s.leftTab);
  const setLeftTab = useStore((s) => s.setLeftTab);

  const browsing =
    agent.currentStation === 'web' &&
    (agent.status === 'working' || agent.status === 'thinking');
  const needsYou = agent.status === 'blocked';

  const showBrowse = browsing && leftTab !== 'browser';
  const showNeedsYou = needsYou && leftTab !== 'messages';
  if (!showBrowse && !showNeedsYou) return null;

  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
      {showNeedsYou && (
        <Cue
          icon="bell"
          background="var(--cth-status-blocked)"
          title={`${agent.name} needs your input — click to open messages`}
          onClick={() => setLeftTab('messages')}
        />
      )}
      {showBrowse && (
        <Cue
          icon="web"
          background="var(--cth-sky)"
          title={`${agent.name} is browsing — click to watch`}
          onClick={() => setLeftTab('browser')}
        />
      )}
    </div>
  );
}

function Cue({
  icon, background, title, onClick
}: { icon: IconName; background: string; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 20, height: 20, padding: 0, border: 'none', cursor: 'pointer',
        background,
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
        animation: 'cth-pulse 1s infinite'
      }}
    >
      <Icon name={icon} />
    </button>
  );
}
