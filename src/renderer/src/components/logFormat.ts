/**
 * Shared formatting for hive event-log entries (`hive/log.jsonl`, surfaced via
 * `window.cth.projectLog`). Used by both the Command Center's Activity feed and the
 * dedicated Logs tab so the two stay consistent.
 */

export interface LogEntry {
  ts?: number;
  kind?: string;
  [k: string]: unknown;
}

/** Turn one raw log entry into a short, human-readable sentence. */
export function formatLogEntry(e: LogEntry): string {
  switch (e.kind) {
    case 'spawn':
      return `spawned ${e.name ?? e.agentId}`;
    case 'archive':
      return `${e.archived === false ? 'un-archived' : 'archived'} ${e.agentId}`;
    case 'message': {
      const n = typeof e.delivered === 'number' ? ` (${e.delivered} recipient${e.delivered === 1 ? '' : 's'})` : '';
      return `${e.from} → ${e.to}: ${e.subject || e.act}${n}`;
    }
    case 'drain':
      return `${e.agentId} drained ${e.count} msg(s)`;
    case 'drop':
      return `dropped ${e.from} → ${e.to} (${e.reason ?? 'unknown'})${e.subject ? `: ${e.subject}` : ''}`;
    case 'tasks':
      return `task list updated (${e.count})`;
    case 'task-update':
      return `${e.by} → task ${e.taskId}: ${e.state}`;
    case 'task-update-miss':
      return `${e.by} posted an update to unknown task ${e.taskId}`;
    case 'escalate':
      return `escalated to human: ${e.subject ?? ''}`;
    case 'approval':
      return `approval ${e.approve ? 'granted' : 'denied'}`;
    case 'error':
      return `error${e.scope ? ` [${e.scope}]` : ''}: ${e.message ?? ''}`;
    default:
      return JSON.stringify(e);
  }
}

export type LogSeverity = 'error' | 'warn' | 'info';

/** Classify an entry so problems (drops, errors) stand out in the viewer. */
export function logSeverity(e: LogEntry): LogSeverity {
  if (e.kind === 'drop' || e.kind === 'error') return 'error';
  if (e.kind === 'archive' && e.archived !== false) return 'warn';
  if (e.kind === 'task-update-miss') return 'warn';
  return 'info';
}

/** CSS color token for a severity, for the kind chip / row accent. */
export function severityColor(sev: LogSeverity): string {
  switch (sev) {
    case 'error': return 'var(--cth-rose, #c0392b)';
    case 'warn': return 'var(--cth-amber, #b8860b)';
    default: return 'var(--cth-ink-300)';
  }
}

/** Text color that contrasts with the matching `severityColor` chip background.
 *  error/warn sit on dark red/amber (light text); info sits on light mauve (dark text). */
export function severityTextColor(sev: LogSeverity): string {
  return sev === 'info' ? 'var(--cth-ink-900)' : 'var(--cth-cream-100)';
}

/** Compact "2m ago" style relative time. `now` is injectable for testing. */
export function relativeTime(ts?: number, now: number = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Forward-looking "resets in 2h 14m" for a Unix-epoch-SECONDS reset time. Used
 *  by the usage meter. `now` (epoch ms) is injectable for testing. */
export function formatResetIn(resetsAtSeconds?: number | null, now: number = Date.now()): string {
  if (!resetsAtSeconds) return '';
  const totalMin = Math.round((resetsAtSeconds * 1000 - now) / 60000);
  if (totalMin <= 0) return 'resetting…';
  if (totalMin < 60) return `resets in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? `resets in ${h}h ${m}m` : `resets in ${h}h`;
  const d = Math.floor(h / 24);
  const hr = h % 24;
  return hr ? `resets in ${d}d ${hr}h` : `resets in ${d}d`;
}
