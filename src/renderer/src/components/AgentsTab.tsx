import { useState, useRef, useCallback, useLayoutEffect } from 'react';
import { AgentCard } from './AgentCard';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { useStore } from '@/store/store';
import { useAgentRestart } from '@/hooks/useAgentRestart';

/** The agent roster as a Command-Center tab. The single home for the roster and
 *  per-agent model control: each card shows the agent's state plus a model picker
 *  + restart button (the overview that used to live in the Floor tab). */
export function AgentsTab() {
  const agents = useStore((s) => s.agents);
  const selectedId = useStore((s) => s.selectedId);
  const select = useStore((s) => s.select);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const toolCounts = useStore((s) => s.toolCounts);
  const { restartingId, restart } = useAgentRestart();

  // ─── Horizontal scroll-strip plumbing ─────────────────────────────────────--
  // The roster lays out as one full-width row; when there are more live agents
  // than fit, the track scrolls horizontally and ◀/▶ step through it.
  const trackRef = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

  const updateScroll = useCallback(() => {
    const el = trackRef.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 1);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  // Recompute reachability when the roster changes or the strip is resized.
  useLayoutEffect(() => {
    updateScroll();
    const el = trackRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(updateScroll);
    ro.observe(el);
    return () => ro.disconnect();
  }, [updateScroll, agents.length]);

  const scrollByPage = (dir: number) => {
    const el = trackRef.current;
    if (!el) return;
    // Step roughly a page, keeping one card of overlap for context.
    el.scrollBy({ left: dir * Math.max(232, el.clientWidth - 232), behavior: 'smooth' });
  };

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 12, background: 'var(--cth-paper-200)' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
        <PixelButton
          variant="secondary"
          size="lg"
          disabled={!canLeft}
          onClick={() => scrollByPage(-1)}
          style={{ flexShrink: 0 }}
        >◀</PixelButton>

        <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
          <div
            ref={trackRef}
            onScroll={updateScroll}
            style={{
              display: 'flex', gap: 12, alignItems: 'flex-start',
              overflowX: 'auto', overflowY: 'hidden',
              paddingBottom: 6, scrollBehavior: 'smooth'
            }}
          >
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                name={a.name}
                character={a.character}
                accent={a.accent}
                status={a.status}
                project={a.project}
                action={a.action}
                progress={a.progress}
                selected={a.id === selectedId}
                isGod={a.isGod}
                isAssistant={a.isAssistant}
                onClick={() => select(a.id)}
                model={a.model}
                effort={a.effort}
                toolCalls={toolCounts[a.id] ?? 0}
                restarting={restartingId === a.id}
                canRestart={!!a.ptyId}
                onPickModel={(m) => restart(a, { model: m })}
                onPickEffort={(e) => restart(a, { effort: e })}
                onRestart={() => restart(a, {})}
              />
            ))}
          </div>
          {/* Edge fades hint that cards continue off-screen. */}
          {canLeft && (
            <div style={{
              position: 'absolute', top: 0, bottom: 6, left: 0, width: 28, pointerEvents: 'none', zIndex: 1,
              background: 'linear-gradient(to right, var(--cth-paper-200), transparent)'
            }} />
          )}
          {canRight && (
            <div style={{
              position: 'absolute', top: 0, bottom: 6, right: 0, width: 28, pointerEvents: 'none', zIndex: 1,
              background: 'linear-gradient(to left, var(--cth-paper-200), transparent)'
            }} />
          )}
        </div>

        <PixelButton
          variant="secondary"
          size="lg"
          disabled={!canRight}
          onClick={() => scrollByPage(1)}
          style={{ flexShrink: 0 }}
        >▶</PixelButton>
      </div>

      <PixelButton
        variant="secondary"
        size="lg"
        style={{ alignSelf: 'flex-start', marginTop: 10 }}
        onClick={() => setAddAgentOpen(true)}
      >
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <Icon name="plus" /> add agent
        </span>
      </PixelButton>

      <ArchivedSection />
    </div>
  );
}

// ─── Archived agents — retained + flagged, kept off the floor (relocated here
//     from the old Floor tab) ───────────────────────────────────────────────--

function ArchivedSection() {
  const archivedAgents = useStore((s) => s.archivedAgents);
  const removeArchivedAgent = useStore((s) => s.removeArchivedAgent);
  const [open, setOpen] = useState(false);
  if (archivedAgents.length === 0) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>
        ARCHIVED ({archivedAgents.length})
      </div>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px 1px', border: 'none', cursor: 'pointer',
          background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
          marginBottom: open ? 6 : 0
        }}
      >{open ? '▾' : '▸'} {open ? 'hide' : 'show'} closed agents</button>
      {open && archivedAgents.map((a) => (
        <div key={a.id} style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: 6, marginBottom: 6, opacity: 0.7, maxWidth: 360,
          background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
        }}>
          <div style={{
            width: 24, height: 24, background: `var(--cth-${a.accent}-light)`,
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
            display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden', flexShrink: 0
          }}>
            <SpritePortrait character={a.character} scale={1} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 13, color: 'var(--cth-ink-700)' }}>{a.name}</div>
            <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', wordBreak: 'break-all' }}>{a.cwd}</div>
          </div>
          <button
            onClick={() => removeArchivedAgent(a.id)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)', flexShrink: 0 }}
          ><Icon name="x" /></button>
        </div>
      ))}
    </div>
  );
}
