import { useEffect, useRef, useState } from 'react';

/** Mirror of the main-process BrowserState (kept local to avoid a cross-package
 *  import; the shape is owned by src/preload/index.ts). */
interface PaneState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
}

const EMPTY: PaneState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false };

/**
 * The bottom-left browser pane. The actual page is a native Electron
 * WebContentsView living in the main process (so the god agent can drive it and
 * the user watches live); this component is just the pixel-art chrome plus a
 * placeholder div whose on-screen rect the native view is told to track.
 */
export function BrowserPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const barFocused = useRef(false);
  const [state, setState] = useState<PaneState>(EMPTY);
  const [address, setAddress] = useState('');

  // Create the native view once and subscribe to its live URL/title/loading.
  useEffect(() => {
    let cancelled = false;
    console.log('[BrowserPane] mount; cth.browser =', !!window.cth?.browser);
    window.cth.browser.ensure()
      .then((r) => console.log('[BrowserPane] ensure ->', r))
      .catch((e) => console.error('[BrowserPane] ensure failed', e));
    const off = window.cth.browser.onState((s) => {
      if (cancelled) return;
      setState(s);
      if (!barFocused.current) setAddress(s.url);
    });
    return () => {
      cancelled = true;
      off();
      // NB: do NOT setVisible(false) here. Visibility is owned solely by App's
      // overlay guard. React StrictMode (dev) double-invokes this effect
      // (mount → cleanup → mount); hiding on the cleanup pass left the view stuck
      // hidden — a black pane — because the remount only re-ensures, it doesn't
      // re-show. The native view is destroyed on real teardown anyway.
    };
  }, []);

  // Keep the native view glued to the placeholder's on-screen rect. The rect
  // shifts whenever the office/browser splitter moves, the sidebar resizes, or
  // the window resizes — a ResizeObserver + resize/scroll listeners cover all
  // three, coalesced into one rAF so a splitter drag doesn't thrash setBounds.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let raf = 0;
    const push = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const r = host.getBoundingClientRect();
        window.cth.browser.setBounds({ x: r.left, y: r.top, width: r.width, height: r.height });
      });
    };
    push();
    const ro = new ResizeObserver(push);
    ro.observe(host);
    window.addEventListener('resize', push);
    window.addEventListener('scroll', push, true);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('resize', push);
      window.removeEventListener('scroll', push, true);
    };
  }, []);

  const go = () => {
    const v = address.trim();
    if (v) window.cth.browser.navigate(v).catch(() => { /* surfaced via state */ });
  };

  const navBtn = (label: string, onClick: () => void, enabled: boolean, title: string) => (
    <button
      onClick={onClick}
      disabled={!enabled}
      title={title}
      style={{
        width: 26, height: 22, flexShrink: 0,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--cth-cream-100)',
        boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
        color: enabled ? 'var(--cth-ink-900)' : 'var(--cth-ink-300)',
        cursor: enabled ? 'pointer' : 'default',
        fontSize: 13, lineHeight: 1, padding: 0,
        fontFamily: 'var(--cth-font-ui)'
      }}
    >{label}</button>
  );

  return (
    <div style={{
      position: 'absolute', inset: 0,
      display: 'flex', flexDirection: 'column',
      background: 'var(--cth-cream-100)',
      boxShadow: 'var(--cth-panel-border-terminal)',
      overflow: 'hidden'
    }}>
      {/* Toolbar */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '6px 8px',
        borderBottom: '2px solid var(--cth-ink-900)',
        background: 'linear-gradient(180deg, var(--cth-cream-100) 0%, var(--cth-cream-200) 100%)'
      }}>
        {navBtn('‹', () => window.cth.browser.goBack(), state.canGoBack, 'Back')}
        {navBtn('›', () => window.cth.browser.goForward(), state.canGoForward, 'Forward')}
        {navBtn('⟳', () => window.cth.browser.reload(), true, 'Reload')}
        <input
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          onFocus={(e) => { barFocused.current = true; e.target.select(); }}
          onBlur={() => { barFocused.current = false; setAddress(state.url); }}
          onKeyDown={(e) => { if (e.key === 'Enter') { go(); (e.target as HTMLInputElement).blur(); } }}
          placeholder="Search Google or type a URL"
          spellCheck={false}
          style={{
            flex: 1, minWidth: 0, height: 22,
            padding: '0 8px',
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            border: 'none', outline: 'none',
            color: 'var(--cth-ink-900)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 13
          }}
        />
        <span style={{
          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
          background: state.loading ? 'var(--cth-lemon)' : 'var(--cth-mint)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
        }} title={state.loading ? 'Loading…' : 'Idle'} />
      </div>

      {/* Placeholder the native WebContentsView tracks (3px frame reveal). */}
      <div style={{ flex: 1, minHeight: 0, padding: 3, background: 'var(--cth-ink-900)' }}>
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
