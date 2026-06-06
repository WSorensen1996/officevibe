import { useState, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from './Icon';
import { NewProjectModal } from './NewProjectModal';
import type { HarnessConfig, ProjectRef } from '@/store/config';

export interface ProjectSwitcherProps {
  config: HarnessConfig;
}

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function activeName(config: HarnessConfig): string {
  const active = config.projects?.find((p) => p.path === config.activeProjectPath);
  if (active) return active.name;
  return config.activeProjectPath ? basename(config.activeProjectPath) : 'No project';
}

/** Compact header control: shows the active project and a dropdown to switch
 *  between known projects, open an existing folder, or create a new project.
 *  Switching/opening/creating relaunches the app against the chosen project. */
export function ProjectSwitcher({ config }: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const projects: ProjectRef[] = config.projects ?? [];

  // The menu is portaled to <body> and positioned `fixed` from the trigger's
  // viewport rect, so it escapes the overflow:auto scroll containers it lives in
  // (App top bar, Settings tab) which would otherwise clip it. `btnRef` anchors
  // it; `pos` is recomputed when opening and on scroll/resize so it tracks.
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect();
      if (!r) return;
      // Clamp so a 240px-min menu never runs off the right viewport edge.
      const left = Math.min(r.left, window.innerWidth - 248);
      setPos({ top: r.bottom + 4, left: Math.max(8, left) });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const switchTo = (p: ProjectRef) => {
    setOpen(false);
    if (p.path === config.activeProjectPath) return;
    void window.cth.projectSwitch(p.path); // relaunches on success
  };

  const openExisting = async () => {
    setOpen(false);
    const res = await window.cth.chooseFolder();
    if (res.ok) void window.cth.projectOpen(res.path); // relaunches on success
  };

  return (
    <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
      <button
        ref={btnRef}
        onClick={() => setOpen((v) => !v)}
        title="Switch project"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          padding: '4px 8px',
          background: 'var(--cth-paper-100)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          border: 'none', cursor: 'pointer',
          fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
          color: 'var(--cth-ink-900)'
        }}
      >
        <Icon name="folder" />
        <span style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {activeName(config)}
        </span>
        <span style={{ fontSize: 8, opacity: 0.6 }}>▾</span>
      </button>

      {open && pos && createPortal(
        <>
          {/* click-away backdrop */}
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 90 }}
          />
          <div style={{
            position: 'fixed', top: pos.top, left: pos.left,
            minWidth: 240, zIndex: 91,
            background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 2px var(--cth-ink-900), 4px 4px 0 rgba(26,19,32,0.25)',
            padding: 4
          }}>
            <div style={{
              padding: '4px 8px', fontFamily: 'var(--cth-font-display)', fontSize: 8,
              letterSpacing: 0.5, color: 'var(--cth-ink-500)'
            }}>PROJECTS</div>
            {projects.length === 0 && (
              <div style={{ padding: '4px 8px', fontSize: 13, color: 'var(--cth-ink-500)' }}>None yet.</div>
            )}
            {projects.map((p) => {
              const isActive = p.path === config.activeProjectPath;
              return (
                <button
                  key={p.path}
                  onClick={() => switchTo(p)}
                  title={p.path}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '6px 8px', border: 'none', cursor: isActive ? 'default' : 'pointer',
                    background: isActive ? 'var(--cth-mint-light)' : 'transparent',
                    fontSize: 14, color: 'var(--cth-ink-900)', textAlign: 'left'
                  }}
                >
                  <span style={{ width: 12, display: 'inline-flex' }}>{isActive ? <Icon name="check" /> : null}</span>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                </button>
              );
            })}
            <div style={{ height: 1, background: 'var(--cth-ink-700)', opacity: 0.3, margin: '4px 0' }} />
            <button onClick={openExisting} style={menuItemStyle}>
              <Icon name="folder" /> Open project…
            </button>
            <button onClick={() => { setOpen(false); setShowNew(true); }} style={menuItemStyle}>
              <Icon name="plus" /> New project…
            </button>
          </div>
        </>,
        document.body
      )}

      {showNew && <NewProjectModal config={config} onClose={() => setShowNew(false)} />}
    </div>
  );
}

const menuItemStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
  padding: '6px 8px', border: 'none', cursor: 'pointer',
  background: 'transparent', fontSize: 14, color: 'var(--cth-ink-900)', textAlign: 'left'
};
