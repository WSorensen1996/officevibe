import { useEffect, useState } from 'react';
import { useMeeting } from '@/hooks/useMeeting';
import { fmtClock, type MeetingMeta, type MeetingInsight, type TranscriptSegment } from '@/lib/meeting/types';
import { PixelButton } from '../PixelButton';
import { Markdown } from '../Markdown';
import { InsightCard } from './InsightCard';
import { TranscriptSelectionToTask } from './SelectionToTask';
import { TranscriptRow } from './TranscriptRow';

/** Past meetings: a compact list, expanding into the full record (summary,
 *  insights with task kick-off, transcript, reveal-recording). */
export function MeetingHistory() {
  const m = useMeeting();
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <MeetingDetail id={openId} onBack={() => setOpenId(null)} />;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
        PAST MEETINGS
      </div>
      {m.meetings.length === 0 && (
        <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>None yet — your recordings will show up here.</div>
      )}
      {m.meetings.map((meta) => (
        <MeetingRow key={meta.id} meta={meta} onOpen={() => setOpenId(meta.id)} />
      ))}
    </div>
  );
}

function MeetingRow({ meta, onOpen }: { meta: MeetingMeta; onOpen: () => void }) {
  const when = new Date(meta.startedAt).toLocaleString([], {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  });
  const statusColor = meta.status === 'ended' ? 'var(--cth-ink-300)'
    : meta.status === 'recording' ? 'var(--cth-status-blocked)' : 'var(--cth-lemon, #EAB308)';
  return (
    <button
      onClick={onOpen}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
        border: 'none', cursor: 'pointer', padding: '7px 9px',
        background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
      }}
    >
      <span style={{ width: 8, height: 8, flexShrink: 0, background: statusColor, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)' }} />
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, color: 'var(--cth-ink-900)' }}>
        {meta.title}
      </span>
      <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0 }}>
        {when}
        {meta.durationSec != null && ` · ${fmtClock(meta.durationSec)}`}
        {meta.segmentCount != null && ` · ${meta.segmentCount} seg`}
        {meta.hasSummary && ' · ✓ summary'}
        {meta.status === 'interrupted' && ' · interrupted'}
      </span>
    </button>
  );
}

function MeetingDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const [data, setData] = useState<{
    meta: MeetingMeta; transcript: TranscriptSegment[]; insights: MeetingInsight[]; summaryMd: string | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'summary' | 'insights' | 'transcript'>('summary');
  // Bumped when the analyst posts a late insight for THIS meeting (the wrap-up
  // summary lands ~a minute after stop) — re-reads so summary/insights go live.
  const [refresh, setRefresh] = useState(0);
  useEffect(() => window.cth.meeting.onInsight((ins) => {
    if (ins.meetingId === id) setRefresh((n) => n + 1);
  }), [id]);

  useEffect(() => {
    let cancelled = false;
    window.cth.meeting.read(id).then((res) => {
      if (cancelled) return;
      if (res.ok && res.meta) {
        setData({
          meta: res.meta,
          transcript: res.transcript ?? [],
          insights: res.insights ?? [],
          summaryMd: res.summaryMd ?? null
        });
        // Land on the most useful tab that has content (first load only).
        if (refresh === 0 && !res.summaryMd) setTab((res.insights?.length ?? 0) > 0 ? 'insights' : 'transcript');
      } else {
        setError(!res.ok ? (res.error ?? 'failed to read meeting') : 'failed to read meeting');
      }
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [id, refresh]);

  if (error) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <PixelButton variant="secondary" size="sm" onClick={onBack}>← back</PixelButton>
        <div style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</div>
      </div>
    );
  }
  if (!data) return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>Loading meeting…</div>;

  const { meta, transcript, insights, summaryMd } = data;
  const tabs: Array<{ key: typeof tab; label: string; n?: number }> = [
    { key: 'summary', label: 'summary' },
    { key: 'insights', label: 'insights', n: insights.length },
    { key: 'transcript', label: 'transcript', n: transcript.length }
  ];

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <PixelButton variant="secondary" size="sm" onClick={onBack}>←</PixelButton>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14, color: 'var(--cth-ink-900)' }}>
          {meta.title}
        </span>
        {meta.hasRecording && (
          <PixelButton variant="ghost" size="sm" onClick={() => { void window.cth.meeting.reveal(meta.id); }}>
            reveal recording
          </PixelButton>
        )}
      </div>
      <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
        {new Date(meta.startedAt).toLocaleString()}
        {meta.durationSec != null && ` · ${fmtClock(meta.durationSec)}`}
        {` · ${meta.language === 'auto' ? 'auto language' : meta.language} · ${meta.model}`}
        {meta.status === 'interrupted' && ' · ⚠ interrupted (app closed mid-meeting)'}
      </div>

      <div style={{ display: 'flex', gap: 4 }}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              border: 'none', cursor: 'pointer', padding: '4px 10px',
              background: tab === t.key ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
              boxShadow: tab === t.key ? 'inset 0 0 0 2px var(--cth-ink-900)' : 'inset 0 0 0 1px var(--cth-ink-300)',
              fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-900)'
            }}
          >
            {t.label.toUpperCase()}{t.n != null ? ` (${t.n})` : ''}
          </button>
        ))}
      </div>

      <div style={{
        flex: 1, minHeight: 0, overflowY: 'auto',
        background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
        padding: 10, display: 'flex', flexDirection: 'column', gap: 8
      }}>
        {tab === 'summary' && (
          summaryMd
            ? <Markdown>{summaryMd}</Markdown>
            : <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
                No summary{meta.status === 'recording' ? ' yet' : ''} — the analyst writes one when the meeting ends.
              </div>
        )}
        {tab === 'insights' && (
          insights.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No insights were recorded for this meeting.</div>
            : insights.map((ins, i) => <InsightCard key={i} insight={ins} meetingTitle={meta.title} />)
        )}
        {tab === 'transcript' && (
          transcript.length === 0
            ? <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>No transcript was captured.</div>
            : (
              <TranscriptSelectionToTask meeting={{ id: meta.id, title: meta.title }} style={{ flexDirection: 'column', gap: 6 }}>
                {transcript.map((s, i) => <TranscriptRow key={i} segment={s} />)}
              </TranscriptSelectionToTask>
            )
        )}
      </div>
    </div>
  );
}
