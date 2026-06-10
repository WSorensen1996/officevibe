import { useEffect, useMemo, useRef, useState } from 'react';
import { useMeeting } from '@/hooks/useMeeting';
import { fmtClock } from '@/lib/meeting/types';
import { PixelPanel } from '../PixelPanel';
import { PixelButton } from '../PixelButton';
import { Select } from '../Select';
import { Icon } from '../Icon';
import { ScreenSourcePicker } from './ScreenSourcePicker';
import { MeetingHistory } from './MeetingHistory';
import { InsightCard } from './InsightCard';

/**
 * The MEETING left-tab view. Two modes:
 *   setup + history — pick sources (mic / system-audio monitor device / screen),
 *                     start; past meetings listed below
 *   live            — transcript + analyst insights side by side, REC clock,
 *                     level meters, stop
 * The capture engine is module-scoped, so navigating away never interrupts a
 * recording — this component is just the dashboard.
 */
export function MeetingPanel() {
  const m = useMeeting();
  const recording = m.status === 'recording' || m.status === 'stopping';

  return (
    <PixelPanel variant="default" noPadding style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        padding: 14, gap: 12, overflow: 'hidden'
      }}>
        {recording ? <LiveView /> : <SetupView />}
      </div>
    </PixelPanel>
  );
}

// ─── Setup ────────────────────────────────────────────────────────────────────

function SetupView() {
  const m = useMeeting();
  const monitors = useMemo(() => m.devices.filter((d) => d.isMonitor), [m.devices]);
  const platform = window.cth.platform;
  const linux = platform.os === 'linux';
  // X11 needs OUR source picker before getDisplayMedia; Wayland's portal and
  // win/mac's handler-default (primary screen) don't.
  const needsPicker = linux && !platform.wayland;
  const [pickerOpen, setPickerOpen] = useState(false);

  const begin = (): void => {
    if (m.setup.screenOn && needsPicker) setPickerOpen(true);
    else void m.start();
  };

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
      {pickerOpen && (
        <ScreenSourcePicker
          onPicked={() => { setPickerOpen(false); void m.start(); }}
          onCancel={() => setPickerOpen(false)}
        />
      )}
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-700)' }}>
        START A MEETING
      </div>
      <div style={{ fontSize: 13, lineHeight: '18px', color: 'var(--cth-ink-500)' }}>
        Records your microphone + system sound (the other participants) and optionally the
        screen, transcribes live on-device, and feeds the meeting analyst. Everything stays local.
      </div>

      {m.error && <Banner color="var(--cth-status-blocked)" text={m.error} onClose={m.clearError} />}
      {m.notice && <Banner color="var(--cth-sky)" text={m.notice} onClose={m.clearError} />}

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={lbl}>Title (optional)</span>
        <input
          value={m.setup.title}
          onChange={(e) => m.setSetup({ title: e.target.value })}
          placeholder="e.g. Weekly sync with Acme"
          style={input}
        />
      </label>

      <CheckRow
        checked={m.setup.micOn}
        onToggle={() => m.setSetup({ micOn: !m.setup.micOn })}
        title="Microphone (you)"
        caption="Your side of the meeting — transcribed as “me”. Headphones improve who-said-what."
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={lbl}>System audio (the others)</span>
        {linux ? (
          <>
            <div style={{ display: 'flex', gap: 6 }}>
              <Select
                value={m.setup.systemDeviceId ?? ''}
                onChange={(v) => m.setSetup({ systemDeviceId: v || null })}
                style={{ flex: 1, minWidth: 0 }}
              >
                <option value="">off — don't capture system audio</option>
                {m.devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.isMonitor ? '🔊 ' : ''}{d.label}
                  </option>
                ))}
              </Select>
              <PixelButton variant="secondary" size="sm" onClick={() => void m.refreshDevices()}>refresh</PixelButton>
            </div>
            <div style={{ fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>
              {monitors.length > 0
                ? 'Pick the “Monitor of …” device — it carries everything your speakers play (Zoom/Meet/Teams).'
                : 'No monitor device found. Install/enable pipewire-pulse (or PulseAudio) and hit refresh; check pavucontrol → Input Devices → show monitors.'}
            </div>
          </>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
            Captured automatically with the screen on this platform (loopback).
          </div>
        )}
      </div>

      <CheckRow
        checked={m.setup.screenOn}
        onToggle={() => m.setSetup({ screenOn: !m.setup.screenOn })}
        title="Record the screen"
        caption={platform.wayland
          ? 'Your desktop picker will appear when the meeting starts (Wayland portal).'
          : needsPicker
            ? 'You pick a screen or window right before the meeting starts; the analyst also gets periodic snapshots.'
            : 'Captures the primary screen; the analyst also gets periodic snapshots.'}
      />

      <div>
        <PixelButton
          variant="primary"
          size="md"
          onClick={begin}
          disabled={m.status !== 'idle' || (!m.setup.micOn && !m.setup.systemDeviceId && !m.setup.screenOn)}
        >
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <Icon name="mic" /> {m.status === 'starting' ? 'starting…' : 'start meeting'}
          </span>
        </PixelButton>
      </div>

      <MeetingHistory />
    </div>
  );
}

// ─── Live ─────────────────────────────────────────────────────────────────────

function LiveView() {
  const m = useMeeting();
  const feedRef = useRef<HTMLDivElement | null>(null);
  // Keep the transcript pinned to the newest line unless the user scrolled up.
  useEffect(() => {
    const el = feedRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [m.transcript.length]);

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{
          width: 10, height: 10, borderRadius: '50%',
          background: 'var(--cth-status-blocked)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
          animation: 'cth-pulse 1s infinite'
        }} />
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, color: 'var(--cth-ink-900)' }}>
          REC {fmtClock(m.elapsedSec)}
        </span>
        <span style={{
          fontSize: 12, color: 'var(--cth-ink-500)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1
        }}>
          {m.active?.title}
        </span>
        <LevelMeter label="me" value={m.levels.mic} on={!!m.active?.sources.mic} />
        <LevelMeter label="them" value={m.levels.system} on={!!m.active?.sources.systemAudio} />
        <PixelButton
          variant="destructive"
          size="sm"
          onClick={() => { void m.stop(); }}
          disabled={m.status === 'stopping'}
        >
          {m.status === 'stopping' ? 'stopping…' : 'stop'}
        </PixelButton>
      </div>

      {m.error && <Banner color="var(--cth-status-blocked)" text={m.error} onClose={m.clearError} />}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', gap: 10 }}>
        {/* Transcript */}
        <div
          ref={feedRef}
          style={{
            flex: 3, minWidth: 0, minHeight: 0, overflowY: 'auto',
            background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            padding: 10, display: 'flex', flexDirection: 'column', gap: 6
          }}
        >
          {m.transcript.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
              Listening… the live transcript appears here a few seconds behind the conversation.
            </div>
          ) : (
            m.transcript.map((s, i) => (
              <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, lineHeight: '18px' }}>
                <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', flexShrink: 0, paddingTop: 1 }}>
                  {fmtClock(s.t0)}
                </span>
                <span style={{
                  flexShrink: 0, paddingTop: 1,
                  fontFamily: 'var(--cth-font-display)', fontSize: 8,
                  color: s.source === 'mic' ? 'var(--cth-teal, #14B8A6)' : 'var(--cth-ink-700)'
                }}>
                  {s.source === 'mic' ? 'ME' : 'THEM'}
                </span>
                <span style={{ color: 'var(--cth-ink-900)' }}>{s.text}</span>
              </div>
            ))
          )}
        </div>

        {/* Analyst insights */}
        <div style={{
          flex: 2, minWidth: 0, minHeight: 0, overflowY: 'auto',
          display: 'flex', flexDirection: 'column', gap: 8
        }}>
          <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: 'var(--cth-ink-700)' }}>
            ANALYST INSIGHTS
          </div>
          {m.insights.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>
              The meeting analyst posts recommendations, proposals and action items here as the
              conversation develops.
            </div>
          ) : (
            m.insights.map((ins, i) => <InsightCard key={i} insight={ins} meetingTitle={m.active?.title} />)
          )}
        </div>
      </div>

      {m.sttBacklog > 3 && (
        <div style={{ fontSize: 11, color: 'var(--cth-ink-500)' }}>
          ⏳ transcription is lagging ({m.sttBacklog} segments queued) — consider the faster model in Settings.
        </div>
      )}
    </div>
  );
}

// ─── Bits ─────────────────────────────────────────────────────────────────────

const lbl: React.CSSProperties = {
  fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
  color: 'var(--cth-ink-700)', textTransform: 'uppercase'
};
const input: React.CSSProperties = {
  width: '100%', padding: '6px 8px 4px', background: 'var(--cth-paper-100)',
  border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)', outline: 'none'
};

function Banner({ color, text, onClose }: { color: string; text: string; onClose: () => void }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
      background: 'var(--cth-cream-100)', boxShadow: `inset 0 0 0 1px ${color}`,
      fontSize: 12, color: 'var(--cth-ink-900)'
    }}>
      <span style={{ flex: 1 }}>{text}</span>
      <button onClick={onClose} style={{ border: 'none', background: 'none', cursor: 'pointer', color: 'var(--cth-ink-500)' }}>✕</button>
    </div>
  );
}

function CheckRow({ checked, onToggle, title, caption }: {
  checked: boolean; onToggle: () => void; title: string; caption: string;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: 'flex', gap: 8, alignItems: 'flex-start', textAlign: 'left',
        border: 'none', background: 'none', cursor: 'pointer', padding: 0
      }}
    >
      <span style={{
        width: 14, height: 14, flexShrink: 0, marginTop: 1,
        background: checked ? 'var(--cth-ink-900)' : 'var(--cth-paper-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
        color: 'var(--cth-paper-100)', fontSize: 11, lineHeight: '14px', textAlign: 'center'
      }}>{checked ? '✓' : ''}</span>
      <span>
        <span style={{ display: 'block', fontSize: 13, color: 'var(--cth-ink-900)' }}>{title}</span>
        <span style={{ display: 'block', fontSize: 11, lineHeight: '15px', color: 'var(--cth-ink-500)' }}>{caption}</span>
      </span>
    </button>
  );
}

function LevelMeter({ label, value, on }: { label: string; value: number; on: boolean }) {
  // RMS of speech sits around 0.02–0.2; map to a 0..1 bar with a gentle curve.
  const pct = on ? Math.min(1, Math.sqrt(value * 6)) : 0;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }} title={`${label} level`}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, color: on ? 'var(--cth-ink-700)' : 'var(--cth-ink-300)' }}>
        {label.toUpperCase()}
      </span>
      <span style={{ width: 40, height: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', overflow: 'hidden' }}>
        <span style={{
          display: 'block', height: '100%', width: `${Math.round(pct * 100)}%`,
          background: pct > 0.85 ? 'var(--cth-status-blocked)' : 'var(--cth-teal, #14B8A6)',
          transition: 'width 120ms linear'
        }} />
      </span>
    </span>
  );
}
