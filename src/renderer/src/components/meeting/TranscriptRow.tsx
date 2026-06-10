import { fmtClock, type TranscriptSegment } from '@/lib/meeting/types';

/** One transcript line — timestamp, ME/THEM speaker chip, text. Shared by the
 *  live view (MeetingPanel) and the history detail (MeetingHistory) so the
 *  speaker-attribution presentation can't drift between them. */
export function TranscriptRow({ segment }: { segment: TranscriptSegment }) {
  return (
    <div style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: '18px' }}>
      <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0, paddingTop: 1 }}>
        {fmtClock(segment.t0)}
      </span>
      <span style={{
        flexShrink: 0, paddingTop: 1,
        fontFamily: 'var(--cth-font-display)', fontSize: 8,
        color: segment.source === 'mic' ? 'var(--cth-teal, #14B8A6)' : 'var(--cth-ink-700)'
      }}>
        {segment.source === 'mic' ? 'ME' : 'THEM'}
      </span>
      <span style={{ color: 'var(--cth-ink-900)' }}>{segment.text}</span>
    </div>
  );
}
