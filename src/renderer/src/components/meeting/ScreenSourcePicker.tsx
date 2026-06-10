import { useEffect, useState } from 'react';
import { PixelPanel } from '../PixelPanel';
import { PixelButton } from '../PixelButton';

interface Source { id: string; name: string; thumbnail: string }

/**
 * X11 screen/window picker: a thumbnail grid over desktopCapturer sources. The
 * chosen id is ARMED in the main process (meeting:setDisplaySource) so the
 * imminent getDisplayMedia resolves to it. Never shown on Wayland — there the
 * OS portal pops its own picker when capture starts.
 */
export function ScreenSourcePicker({ onPicked, onCancel }: {
  /** Called after the source id is armed; the caller then starts the meeting. */
  onPicked: () => void;
  onCancel: () => void;
}) {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    window.cth.meeting.listScreenSources().then((res) => {
      if (cancelled) return;
      if (res.ok && res.sources) setSources(res.sources);
      else setError(res.error ?? 'could not list screens');
    }).catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, []);

  const pick = async (id: string): Promise<void> => {
    try {
      await window.cth.meeting.setDisplaySource(id);
      onPicked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div style={{
      position: 'fixed', inset: 0, zIndex: 60,
      background: 'rgba(26,19,32,0.55)',
      display: 'flex', alignItems: 'center', justifyContent: 'center'
    }}>
      <div style={{ width: 640, maxWidth: '92vw', maxHeight: '82vh', display: 'flex' }}>
        <PixelPanel variant="dialog" title="WHAT SHOULD THE MEETING RECORD?" noPadding style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 12, minHeight: 0 }}>
            {error && <div style={{ fontSize: 12, color: 'var(--cth-status-blocked)' }}>{error}</div>}
            {!sources && !error && <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>Looking for screens…</div>}
            {sources && (
              <div style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
                gap: 10, overflowY: 'auto'
              }}>
                {sources.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => { void pick(s.id); }}
                    title={s.name}
                    style={{
                      border: 'none', cursor: 'pointer', textAlign: 'left', padding: 6,
                      background: 'var(--cth-cream-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
                      display: 'flex', flexDirection: 'column', gap: 6
                    }}
                  >
                    {s.thumbnail
                      ? <img src={s.thumbnail} alt={s.name} style={{ width: '100%', aspectRatio: '16/10', objectFit: 'cover', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)' }} />
                      : <div style={{ width: '100%', aspectRatio: '16/10', background: 'var(--cth-paper-100)' }} />}
                    <span style={{
                      fontSize: 12, color: 'var(--cth-ink-900)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                    }}>
                      {s.id.startsWith('screen:') ? '🖥 ' : '🪟 '}{s.name}
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PixelButton variant="secondary" size="sm" onClick={onCancel}>cancel</PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}
