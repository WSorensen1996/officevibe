import { type LeftTab, isAgentTab } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import { Icon, type IconName } from './Icon';

const TABS: { key: LeftTab; label: string; icon: IconName }[] = [
  { key: 'office',   label: 'office',   icon: 'mcp' },
  { key: 'messages', label: 'messages', icon: 'bell' },
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  { key: 'browser',  label: 'browser',  icon: 'web' }
];

export interface LeftTabsProps {
  current: LeftTab;
  onChange: (tab: LeftTab) => void;
  /** Pulse a badge on the Browser tab while the agent is actively browsing. */
  browserActive: boolean;
  /** Pulse a badge on the Messages tab while the selected agent is blocked waiting
   *  for your input (a permission prompt / question surfaced in its messages tab). */
  messagesNeedsYou?: boolean;
  /** Accent of the currently-selected agent — colors the active underline on the
   *  agent tabs (terminal/messages) so it reads as "this agent". The
   *  shared office/browser tabs keep the neutral sky accent. */
  accent?: AccentColorName;
  /** A task's full card is open — append a transient TASK tab to the bar. It
   *  disappears again when the card is closed (the tab is never persisted). */
  hasOpenTask?: boolean;
  /** A file is open in the left pane — append a transient FILE tab to the bar.
   *  Disappears when the file is closed (the tab is never persisted). */
  hasOpenFile?: boolean;
}

/**
 * The left-column tab bar. Office and Browser are shared views; the agent tabs
 * (messages/terminal) render the selected agent's content. Messages
 * sits 2nd (right after Office) so the agent's running chat — what it says while
 * working, interleaved with its mail — is one click away. A pulsing dot appears on
 * the Browser tab while Michael is browsing and you're looking at another tab.
 */
export function LeftTabs({ current, onChange, browserActive, messagesNeedsYou, accent, hasOpenTask, hasOpenFile }: LeftTabsProps) {
  // The TASK and FILE tabs are transient — only present while a card / file is
  // open, appended last (task before file).
  const tabs = [
    ...TABS,
    ...(hasOpenTask ? [{ key: 'task' as const, label: 'task', icon: 'expand' as IconName }] : []),
    ...(hasOpenFile ? [{ key: 'file' as const, label: 'file', icon: 'code' as IconName }] : [])
  ];
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      background: 'var(--cth-cream-200)',
      boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
      flexShrink: 0
    }}>
      {tabs.map(t => {
        const active = current === t.key;
        // Per-tab pulsing badge: Browser while Michael browses, Messages while the
        // selected agent is blocked waiting on you. Hidden on the active tab.
        const badge = active ? null
          : t.key === 'browser' && browserActive
            ? { color: 'var(--cth-sky)', title: 'Michael is browsing — flick over to watch' }
            : t.key === 'messages' && messagesNeedsYou
              ? { color: 'var(--cth-status-blocked)', title: 'An agent needs your input — open messages to answer' }
              : null;
        // Agent tabs adopt the selected agent's accent; shared views stay sky.
        const underline = isAgentTab(t.key) && accent ? `var(--cth-${accent})` : 'var(--cth-sky)';
        return (
          <button
            key={t.key}
            onClick={() => onChange(t.key)}
            title={t.label}
            style={{
              flex: 1,
              minWidth: 0,
              height: 36,
              padding: '0 8px',
              border: 'none',
              cursor: 'pointer',
              position: 'relative',
              background: active ? 'var(--cth-cream-100)' : 'transparent',
              boxShadow: active
                ? `inset 0 -3px 0 ${underline}, inset 1px 0 0 var(--cth-ink-900), inset -1px 0 0 var(--cth-ink-900)`
                : 'inset 0 0 0 0',
              fontFamily: 'var(--cth-font-display)',
              fontSize: 10,
              lineHeight: '14px',
              color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
              overflow: 'hidden'
            }}
          >
            <span style={{ flexShrink: 0, display: 'inline-flex' }}><Icon name={t.icon} /></span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {t.label.toUpperCase()}
            </span>
            {badge && (
              <span
                title={badge.title}
                style={{
                  position: 'absolute',
                  top: 7, right: 6,
                  width: 8, height: 8,
                  borderRadius: '50%',
                  background: badge.color,
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
                  animation: 'cth-pulse 1s infinite'
                }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
