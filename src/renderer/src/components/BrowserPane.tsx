import { useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';

/** Mirror of the main-process BrowserState (kept local to avoid a cross-package
 *  import; the shape is owned by src/preload/index.ts). */
interface PaneState {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  agentId: string | null;
}

/** One agent that currently has a live browser view (a tab in the strip). */
interface TabView { agentId: string; name: string; isGod: boolean }
interface ViewsState { views: TabView[]; stageAgentId: string | null }

const EMPTY: PaneState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false, agentId: null };

/**
 * The bottom-left browser pane. Each agent has its OWN native Electron
 * WebContentsView in the main process; exactly one is "on stage" at the pane rect
 * the user watches (the rest are parked offscreen). This component is the
 * pixel-art chrome — a tab-strip to pick whose browser you watch, a nav toolbar,
 * and a placeholder div whose on-screen rect the staged native view tracks.
 */
export function BrowserPane() {
  const hostRef = useRef<HTMLDivElement>(null);
  const barFocused = useRef(false);
  // True once we've received at least one tab-strip roster — guards the auto-unpin
  // effect from firing during the initial empty-tabs window (incl. StrictMode remount).
  const gotViews = useRef(false);
  // True when focusing the URL bar auto-pinned the staged agent (so we unpin on blur).
  const autoPinnedOnFocus = useRef(false);
  const [state, setState] = useState<PaneState>(EMPTY);
  const [address, setAddress] = useState('');
  const [tabs, setTabs] = useState<TabView[]>([]);
  const [staged, setStaged] = useState<string | null>(null);
  const pinnedAgentId = useStore((s) => s.browserPinnedAgentId);

  // Create the native view once and subscribe to its live URL/title/loading and
  // to the tab-strip roster (which agents have a browser + who's on stage).
  useEffect(() => {
    let cancelled = false;
    console.log('[BrowserPane] mount; cth.browser =', !!window.cth?.browser);
    window.cth.browser.ensure()
      .then((r) => console.log('[BrowserPane] ensure ->', r))
      .catch((e) => console.error('[BrowserPane] ensure failed', e));
    const offState = window.cth.browser.onState((s) => {
      if (cancelled) return;
      setState(s);
      setStaged(s.agentId);
      if (!barFocused.current) setAddress(s.url);
    });
    const offViews = window.cth.browser.onViews((v) => {
      if (cancelled) return;
      gotViews.current = true;
      setTabs(v.views);
      setStaged(v.stageAgentId);
    });
    return () => {
      cancelled = true;
      offState();
      offViews();
      // NB: do NOT setVisible(false) here. Visibility is owned solely by App's
      // overlay guard. React StrictMode (dev) double-invokes this effect
      // (mount → cleanup → mount); hiding on the cleanup pass left the view stuck
      // hidden — a black pane — because the remount only re-ensures, it doesn't
      // re-show. The native view is destroyed on real teardown anyway.
    };
  }, []);

  // Keep the staged native view glued to the placeholder's on-screen rect. The
  // rect shifts whenever the office/browser splitter moves, the sidebar resizes,
  // or the window resizes — a ResizeObserver + resize/scroll listeners cover all
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

  // Auto-unpin if the pinned agent's browser went away (archived / LRU-evicted),
  // so the pane resumes auto-following instead of staying stuck on a dead tab.
  // Guarded on gotViews so the initial empty roster (or a StrictMode remount)
  // can't spuriously unpin before the first real roster arrives.
  useEffect(() => {
    if (gotViews.current && pinnedAgentId && !tabs.some((t) => t.agentId === pinnedAgentId)) {
      useStore.getState().setBrowserPinned(null);
    }
  }, [tabs, pinnedAgentId]);

  const go = () => {
    const v = address.trim();
    if (v) window.cth.browser.navigate(v).catch(() => { /* surfaced via state */ });
  };

  // Click a tab to watch (and pin) that agent's browser; click the pinned tab
  // again to unpin so the pane resumes auto-following whoever browses.
  const onTab = (id: string) => {
    if (pinnedAgentId === id) {
      useStore.getState().setBrowserPinned(null);
      return;
    }
    useStore.getState().setBrowserPinned(id);
    window.cth.browser.stage(id).catch(() => { /* no view yet — harmless */ });
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
      {/* Tab-strip: one tab per agent with a live browser. The staged tab is
          highlighted; the pinned tab shows a pin. Hidden when nobody is browsing. */}
      {tabs.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'stretch', gap: 2,
          padding: '4px 6px 0',
          background: 'var(--cth-cream-200)',
          borderBottom: '1px solid var(--cth-ink-700)',
          overflowX: 'auto'
        }}>
          {tabs.map((t) => {
            const isStaged = t.agentId === staged;
            const isPinned = t.agentId === pinnedAgentId;
            return (
              <button
                key={t.agentId}
                onClick={() => onTab(t.agentId)}
                title={isPinned ? `Pinned — watching ${t.name} (click to unpin)` : `Watch ${t.name}`}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 4,
                  maxWidth: 160, flexShrink: 0,
                  padding: '3px 8px', height: 22,
                  border: 'none',
                  background: isStaged ? 'var(--cth-cream-100)' : 'transparent',
                  boxShadow: isStaged
                    ? 'inset 0 0 0 1px var(--cth-ink-700)'
                    : 'inset 0 0 0 1px var(--cth-ink-300)',
                  color: isStaged ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
                  cursor: 'pointer',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 12, lineHeight: 1,
                  whiteSpace: 'nowrap'
                }}
              >
                <span style={{
                  width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
                  background: t.isGod ? 'var(--cth-lemon)' : 'var(--cth-mint)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
                }} />
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{t.name}</span>
                {isPinned && <span style={{ flexShrink: 0 }} aria-label="pinned">📌</span>}
              </button>
            );
          })}
        </div>
      )}

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
          onFocus={(e) => {
            barFocused.current = true;
            // Pin the currently-staged agent while editing so auto-follow can't move
            // the pane (and the nav target) out from under the URL you're typing.
            if (!pinnedAgentId && staged) { useStore.getState().setBrowserPinned(staged); autoPinnedOnFocus.current = true; }
            e.target.select();
          }}
          onBlur={() => {
            barFocused.current = false;
            if (autoPinnedOnFocus.current) { useStore.getState().setBrowserPinned(null); autoPinnedOnFocus.current = false; }
            setAddress(state.url);
          }}
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

      {/* Placeholder the staged native WebContentsView tracks (3px frame reveal). */}
      <div style={{ flex: 1, minHeight: 0, padding: 3, background: 'var(--cth-ink-900)' }}>
        <div ref={hostRef} style={{ width: '100%', height: '100%' }} />
      </div>
    </div>
  );
}
