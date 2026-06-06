import { type LeftTab, isAgentTab } from '@/store/store';
import { type AccentColorName } from '@/design/tokens';
import { Icon, type IconName } from './Icon';

const TABS: { key: LeftTab; label: string; icon: IconName }[] = [
  { key: 'office',   label: 'office',   icon: 'mcp' },
  { key: 'terminal', label: 'terminal', icon: 'terminal' },
  { key: 'browser',  label: 'browser',  icon: 'web' },
  { key: 'files',    label: 'files',    icon: 'folder' },
  { key: 'messages', label: 'messages', icon: 'bell' },
  { key: 'logs',     label: 'logs',     icon: 'code' }
];

export interface LeftTabsProps {
  current: LeftTab;
  onChange: (tab: LeftTab) => void;
  /** Pulse a badge on the Browser tab while the agent is actively browsing. */
  browserActive: boolean;
  /** Accent of the currently-selected agent — colors the active underline on the
   *  agent tabs (terminal/files/messages/logs) so it reads as "this agent". The
   *  shared office/browser tabs keep the neutral sky accent. */
  accent?: AccentColorName;
}

/**
 * The left-column tab bar. The first three flick the whole left side between the
 * office floor, the selected agent's workspace, and the shared browser; the
 * agent tabs (terminal/files/messages/logs) render the selected agent's content.
 * A pulsing dot appears on the Browser tab while Michael is browsing and you're
 * looking at another tab.
 */
export function LeftTabs({ current, onChange, browserActive, accent }: LeftTabsProps) {
  return (
    <div style={{
      display: 'flex',
      gap: 0,
      background: 'var(--cth-cream-200)',
      boxShadow: 'inset 0 -2px 0 var(--cth-ink-900)',
      flexShrink: 0
    }}>
      {TABS.map(t => {
        const active = current === t.key;
        const showBadge = t.key === 'browser' && browserActive && !active;
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
            {showBadge && (
              <span
                title="Michael is browsing — flick over to watch"
                style={{
                  position: 'absolute',
                  top: 7, right: 6,
                  width: 8, height: 8,
                  borderRadius: '50%',
                  background: 'var(--cth-sky)',
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
