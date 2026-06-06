import { useEffect, useRef, useState } from 'react';
import { formatResetIn } from './logFormat';

// Derive the usage shape from the preload-exposed API so the renderer never
// reaches across project boundaries for a type (window.cth is globally typed).
type UsageLimits = NonNullable<Awaited<ReturnType<Window['cth']['usageLimits']>>>;
type UsageWindow = NonNullable<UsageLimits['fiveHour']>;

/** A snapshot older than this is dimmed as "stale" (the active agent hasn't
 *  refreshed its statusLine recently). */
const STALE_MS = 10 * 60 * 1000;

function barColor(pct: number): string {
  if (pct >= 90) return 'var(--cth-coral)';
  if (pct >= 70) return 'var(--cth-lemon)';
  return 'var(--cth-mint)';
}

function Meter({ label, full, win, stale }: { label: string; full: string; win: UsageWindow; stale: boolean }) {
  const pct = Math.max(0, Math.min(100, win.usedPercent));
  const reset = formatResetIn(win.resetsAt);
  return (
    <div
      title={`${full}: ${pct.toFixed(0)}% used${reset ? ` · ${reset}` : ''}${stale ? ' · (stale)' : ''}`}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4, opacity: stale ? 0.5 : 1 }}
    >
      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-500)' }}>{label}</span>
      <div style={{ width: 36, height: 6, background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
        <div style={{ width: `${pct}%`, height: '100%', background: barColor(pct) }} />
      </div>
      <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)', minWidth: 26, textAlign: 'right' }}>
        {pct.toFixed(0)}%
      </span>
    </div>
  );
}

/**
 * Title-bar indicator for Claude subscription usage: the current **session**
 * (rolling 5-hour) and **weekly** (rolling 7-day) limits. Data is captured from
 * each agent's Claude Code statusLine (`rate_limits`) into hive/usage.json and
 * read here via `window.cth.usageLimits()`. Degrades gracefully: until a value
 * is captured (Pro/Max only, after the first API response) it shows "usage —".
 */
export function UsageMeter() {
  const [usage, setUsage] = useState<UsageLimits | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const refresh = async () => {
      try { setUsage(await window.cth.usageLimits()); } catch { /* keep last good state */ }
    };
    refresh();
    timer.current = setInterval(refresh, 15000);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, []);

  const five = usage?.fiveHour ?? null;
  const seven = usage?.sevenDay ?? null;
  const stale = !!usage && Date.now() - usage.capturedAt > STALE_MS;

  if (!five && !seven) {
    return (
      <span
        className="cth-titlebar-nodrag"
        title="Claude usage (current session + weekly) appears on Pro/Max after the first response."
        style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-300)' }}
      >
        usage —
      </span>
    );
  }

  return (
    <div className="cth-titlebar-nodrag" style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
      {five && <Meter label="5h" full="Current session (5 hours)" win={five} stale={stale} />}
      {seven && <Meter label="7d" full="Weekly (7 days)" win={seven} stale={stale} />}
    </div>
  );
}
