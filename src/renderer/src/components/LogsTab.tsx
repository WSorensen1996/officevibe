import { useEffect, useMemo, useRef, useState } from 'react';
import { PixelButton } from './PixelButton';
import {
  formatLogEntry, logSeverity, severityColor, severityTextColor, relativeTime, type LogEntry
} from './logFormat';

/**
 * Human-readable view of the hive event log (`hive/log.jsonl`, surfaced via
 * `window.cth.projectLog`). Each row is a plain-language sentence with a color-coded
 * kind chip; problems (dropped messages, errors) stand out so the user can spot
 * and investigate failures. Click a row to reveal its raw JSON.
 */

type Filter = 'all' | 'problems' | 'messages' | 'agents';

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'all' },
  { key: 'problems', label: 'problems' },
  { key: 'messages', label: 'messages' },
  { key: 'agents', label: 'agents' }
];

function matchesFilter(e: LogEntry, f: Filter): boolean {
  switch (f) {
    case 'problems': return logSeverity(e) !== 'info';
    case 'messages': return e.kind === 'message';
    case 'agents': return e.kind === 'spawn' || e.kind === 'archive';
    default: return true;
  }
}

/** Stable-ish identity for an entry so an expanded row survives a refresh. */
function entryKey(e: LogEntry, i: number): string {
  return String(e.id ?? `${e.ts ?? ''}-${e.kind ?? ''}-${e.agentId ?? ''}-${i}`);
}

/** When `agentId` is given, the feed is scoped to events involving that agent
 *  (it spawned/archived, drained/dropped mail, or is a message sender/recipient).
 *  Omit it for the hive-wide view. */
export function LogsTab({ agentId }: { agentId?: string } = {}) {
  const [log, setLog] = useState<LogEntry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [paused, setPaused] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = async () => {
    try { setLog((await window.cth.projectLog(300)) as LogEntry[]); } catch { /* keep last good state */ }
  };

  useEffect(() => {
    refresh();
    if (paused) return;
    timer.current = setInterval(refresh, 3000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [paused]);

  // Optionally scope to one agent, then newest-first, then filter.
  const scoped = useMemo(
    () => (agentId
      ? log.filter((e) => e.agentId === agentId || e.from === agentId || e.to === agentId || e.by === agentId)
      : log),
    [log, agentId]
  );
  const rows = useMemo(
    () => [...scoped].reverse().filter((e) => matchesFilter(e, filter)),
    [scoped, filter]
  );

  const problemCount = useMemo(() => scoped.filter((e) => logSeverity(e) !== 'info').length, [scoped]);

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      {/* Controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', flexWrap: 'wrap',
        boxShadow: 'inset 0 -1px 0 var(--cth-ink-900)', background: 'var(--cth-cream-100)'
      }}>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          const showCount = f.key === 'problems' && problemCount > 0;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                border: 'none', cursor: 'pointer', padding: '2px 8px',
                fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '18px',
                color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
                background: active ? 'var(--cth-cream-200)' : 'transparent',
                boxShadow: active ? 'inset 0 0 0 1px var(--cth-ink-700)' : 'none'
              }}
            >
              {f.label}{showCount ? ` (${problemCount})` : ''}
            </button>
          );
        })}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
          <PixelButton size="sm" variant="ghost" onClick={() => setPaused((p) => !p)}>
            {paused ? 'resume' : 'pause'}
          </PixelButton>
          <PixelButton size="sm" variant="secondary" onClick={refresh}>refresh</PixelButton>
        </div>
      </div>

      {/* Rows */}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--cth-space-3)', display: 'flex', flexDirection: 'column', gap: 2 }}>
        {rows.length === 0 && (
          <p style={{ margin: 'auto', fontSize: 14, color: 'var(--cth-ink-500)', textAlign: 'center', maxWidth: 280 }}>
            {scoped.length === 0 ? 'No log events yet.' : 'Nothing matches this filter.'}
          </p>
        )}
        {rows.map((e, i) => {
          const key = entryKey(e, i);
          const sev = logSeverity(e);
          const isOpen = expanded[key];
          return (
            <div
              key={key}
              onClick={() => setExpanded((s) => ({ ...s, [key]: !isOpen }))}
              style={{
                cursor: 'pointer', padding: '4px 6px',
                background: sev === 'error' ? 'var(--cth-rose-bg, rgba(192,57,43,0.08))' : 'transparent',
                borderLeft: `2px solid ${sev === 'info' ? 'transparent' : severityColor(sev)}`
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span style={{
                  flexShrink: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 11, lineHeight: '16px',
                  padding: '0 5px', color: severityTextColor(sev), background: severityColor(sev)
                }}>{e.kind ?? '·'}</span>
                <span style={{
                  flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 13, lineHeight: '18px',
                  color: 'var(--cth-ink-900)',
                  overflow: isOpen ? 'visible' : 'hidden', textOverflow: 'ellipsis',
                  whiteSpace: isOpen ? 'normal' : 'nowrap', wordBreak: 'break-word'
                }}>{formatLogEntry(e)}</span>
                <span style={{ flexShrink: 0, fontSize: 11, color: 'var(--cth-ink-500)' }} title={e.ts ? new Date(e.ts).toLocaleString() : ''}>
                  {relativeTime(e.ts)}
                </span>
              </div>
              {isOpen && (
                <pre style={{
                  margin: '4px 0 0', padding: 8, fontSize: 11, lineHeight: '15px',
                  fontFamily: 'var(--cth-font-mono, monospace)', color: 'var(--cth-ink-700)',
                  background: 'var(--cth-cream-50, #fff)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-100)',
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', overflowX: 'auto'
                }}>{JSON.stringify(e, null, 2)}</pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
