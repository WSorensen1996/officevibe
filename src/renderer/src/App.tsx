import { useEffect, useState } from 'react';
import { useStore, selectedAgent, isAgentTab, NEW_TASK_ID } from '@/store/store';
import { startMockLoop, stopMockLoop } from '@/store/mockEvents';
import type { HarnessConfig } from '@/store/config';
import { OfficeFloor } from '@/scene/office/OfficeFloor';
import { useProject } from '@/hooks/useProject';
import { CommandCenterPanel } from '@/components/CommandCenterPanel';
import { AgentWorkspace } from '@/components/AgentWorkspace';
import { AddAgentModal } from '@/components/AddAgentModal';
import { MichaelBooting } from '@/components/MichaelBooting';
import { OnboardingWizard } from '@/components/OnboardingWizard';
import { QuitWarningModal } from '@/components/QuitWarningModal';
import { PixelPanel } from '@/components/PixelPanel';
import { PixelButton } from '@/components/PixelButton';
import { Icon } from '@/components/Icon';
import { SidebarSplitter } from '@/components/SidebarSplitter';
import { LeftTabs } from '@/components/LeftTabs';
import { ProjectSwitcher } from '@/components/ProjectSwitcher';
import { SpritePortrait } from '@/components/SpritePortrait';
import { PixelBadge } from '@/components/PixelBadge';
import { AttentionCues } from '@/components/AttentionCues';
import { BrowserPane } from '@/components/BrowserPane';
import { acquireTerminal } from '@/components/terminalPool';
import { FullscreenTerminal } from '@/components/FullscreenTerminal';
import { FullscreenFileEditor } from '@/components/FullscreenFileEditor';
import { LeftFileEditor } from '@/components/LeftFileEditor';
import { TaskDetailPanel } from '@/components/TaskDetailPanel';
import { MeetingPanel } from '@/components/meeting/MeetingPanel';
import { useMeetingRecording } from '@/hooks/useMeeting';

/** The window is frameless on macOS (titleBarStyle: hiddenInset) and the in-app
 *  title bar is gone, so the traffic lights would float over the content with no
 *  drag region. On macOS only, render a slim empty strip at the top to drag the
 *  window and clear the lights. Other platforms get the OS frame and reclaim it. */
const IS_MAC = typeof navigator !== 'undefined' && navigator.platform.toUpperCase().includes('MAC');

export function App() {
  const agent = useStore(selectedAgent);
  const agents = useStore(s => s.agents);
  const agentCount = agents.length;
  // The god ("Michael") agent runs the floor; his Command Center is pinned to the
  // right column regardless of which agent is selected.
  const god = agents.find(a => a.isGod);
  const addAgentOpen = useStore(s => s.addAgentOpen);
  const setAddAgentOpen = useStore(s => s.setAddAgentOpen);
  const godStatus = useStore(s => s.godStatus);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);
  const sidebarWidth = useStore(s => s.sidebarWidth);
  const setSidebarWidth = useStore(s => s.setSidebarWidth);
  const leftTab = useStore(s => s.leftTab);
  const setLeftTab = useStore(s => s.setLeftTab);
  const select = useStore(s => s.select);
  const selectedId = useStore(s => s.selectedId);
  const openTaskId = useStore(s => s.openTaskId);
  const openFilePath = useStore(s => s.openFilePath);
  const browserActive = useStore(s => s.browserActive);
  // REC badge on the meeting tab — capture itself is module-scoped, this is display.
  const meetingRecording = useMeetingRecording();
  // Any agent blocked on a prompt lights the Messages-tab badge (the request lives
  // in that agent's messages). Clicking the tab jumps to the blocked agent so it's
  // answerable even when a different agent is selected — covers "any agent blocks".
  const blockedAgent = agents.find(a => a.status === 'blocked');

  const [config, setConfig] = useState<HarnessConfig | null>(null);
  const [quitWarn, setQuitWarn] = useState<{ ptyCount: number } | null>(null);
  const [vpWidth, setVpWidth] = useState<number>(window.innerWidth);

  // Initial config load. Hydrate the per-project agent store BEFORE committing config
  // to state, so useProject's config-gated effects see THIS project's agents — and a
  // brand-new/other project starts clean instead of inheriting the last one's roster.
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then(c => {
      if (cancelled) return;
      if (c.activeProjectPath) useStore.getState().hydrateForProject(c.activeProjectPath);
      setConfig(c);
    });
    return () => { cancelled = true; };
  }, []);

  // Quit warning subscription
  useEffect(() => window.cth.onCloseRequested((info) => setQuitWarn(info)), []);

  // The hive: god-agent bootstrap, hook-driven avatars, idle-agent waking.
  useProject(config);

  // Pre-warm a persistent terminal for every live agent so its output is
  // buffered from spawn. Switching agents then re-attaches an already-rendered
  // terminal instantly (with full history) instead of building a blank one.
  useEffect(() => {
    for (const a of agents) if (a.ptyId) acquireTerminal(a.ptyId);
  }, [agents]);

  // Mock loop only after onboarding (skip during wizard)
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    startMockLoop();
    return () => stopMockLoop();
  }, [config?.onboardingComplete]);

  // Reconcile restored agents against the PTYs still alive in the main process.
  // After a renderer reload (e.g. the laptop slept and Vite reloaded the page),
  // this keeps agents whose process survived and drops any that truly died.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    let cancelled = false;
    window.cth.listPtys().then((list) => {
      if (cancelled) return;
      useStore.getState().reconcileWithLivePtys(list.map((p) => p.id));
    }).catch(() => { /* ignore — keep restored agents as-is */ });
    return () => { cancelled = true; };
  }, [config?.onboardingComplete]);

  // Track viewport width for sidebar-splitter clamping
  useEffect(() => {
    const onResize = () => setVpWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // The embedded browser is a native WebContentsView painted ABOVE the DOM, so it
  // must be shown ONLY when its tab is active AND no modal/fullscreen overlay is
  // open — otherwise it would cover the office or a dialog. Single source of truth
  // for the view's visibility (keeping it in one place avoids the stuck-hidden /
  // stuck-on-top bugs that come from multiple owners).
  const overlayOpen = addAgentOpen || !!quitWarn
    || !!fullscreenAgentId || !!fullscreenFilePath;
  const browserShown = !!config?.onboardingComplete && !overlayOpen && leftTab === 'browser';
  useEffect(() => {
    window.cth.browser?.setVisible(browserShown);
  }, [browserShown]);

  // ⌘/Ctrl+Enter anywhere opens a fresh "create task" view — a fast way to capture
  // a task without reaching for the board's "add task" button. Guarded so it never
  // collides with the combos that already own ⌘/Ctrl+Enter: it bails when a task
  // view is already open (its form uses it to create) and when focus is in an
  // editable field (the message composers use it to send).
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
      // Read live: overlay/openTask state changes shouldn't require re-subscribing,
      // and a stale closure could let this fire over a just-opened modal/task form.
      const st = useStore.getState();
      // quitWarn is local component state (not in the store), so read it directly.
      const overlay = st.addAgentOpen || !!quitWarn
        || !!st.fullscreenAgentId || !!st.fullscreenFilePath;
      // A task view (incl. the new-task form) is open → it owns ⌘/Ctrl+Enter (submit).
      if (overlay || st.openTaskId) return;
      // Skip while TYPING in an editable field (message composers send with this
      // combo). Clicking the office floor / an empty area focuses the body or a
      // non-editable element, so it is NOT treated as typing — the combo fires.
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      e.preventDefault();
      st.setNewTaskSeed(null);
      st.openTask(NEW_TASK_ID);
    };
    // Capture phase so a child that stopPropagation()s keydown (xterm, the Pixi
    // office canvas, etc.) can't swallow the combo before this window handler runs.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [config?.onboardingComplete, quitWarn]);

  if (!config) {
    return <div style={{ width: '100vw', height: '100vh', background: 'var(--cth-cream-100)' }} />;
  }

  if (!config.onboardingComplete) {
    return <OnboardingWizard onComplete={(next) => {
      if (next.activeProjectPath) useStore.getState().hydrateForProject(next.activeProjectPath);
      setConfig(next);
    }} />;
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      width: '100vw', height: '100vh',
      overflow: 'hidden'
    }}>
      {/* macOS-only slim drag strip: the in-app title bar is gone, so this stands
          in as the window-drag region + traffic-light clearance. Other platforms
          use the OS frame and reclaim this space entirely. */}
      {IS_MAC && (
        <div
          className="cth-titlebar-drag"
          style={{ height: 28, minHeight: 28, flexShrink: 0, background: 'var(--cth-cream-100)', userSelect: 'none' }}
        />
      )}

      {/* Full-width top bar: spans above BOTH panels. Project switcher at the far
          left, then one uniform card per active agent (`agents` — archived live
          in a separate list). Clicking a card selects that agent (drives the left
          workspace tabs); the selected card gets an accent ring. Scrolls
          horizontally so a large roster never breaks the layout. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '0 16px', marginBottom: 8, flexShrink: 0,
        overflowX: 'auto'
      }}>
        <ProjectSwitcher config={config} />
        {agents.map((a) => (
          <div
            key={a.id}
            role="button"
            title={`${a.name} — click to drive the terminal/files/messages/logs tabs`}
            onClick={() => select(a.id)}
            style={{
              flexShrink: 0, cursor: 'pointer',
              display: 'inline-flex', alignItems: 'center', gap: 6,
              maxWidth: 240, padding: '3px 8px',
              background: 'var(--cth-cream-200)',
              boxShadow: a.id === selectedId
                ? 'inset 0 0 0 2px var(--cth-ink-900)'
                : 'inset 0 0 0 1px var(--cth-ink-700)'
            }}
          >
            {/* Accent-tinted portrait box — same framing as the Command Center. */}
            <div style={{
              width: 22, height: 28, flexShrink: 0,
              background: `var(--cth-${a.accent}-light)`,
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
              overflow: 'hidden'
            }}>
              <SpritePortrait character={a.character} scale={1} />
            </div>
            {/* Name on top; status badge + live action below (truncates). */}
            <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1 }}>
              <span style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px',
                color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>{a.name.toUpperCase()}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <PixelBadge status={a.status} />
                <span style={{
                  minWidth: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                  color: 'var(--cth-ink-500)',
                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                }}>{(a.action || '').trim() || a.description}</span>
              </div>
            </div>
            {/* Pulsing cues when this agent is browsing or needs you. */}
            <AttentionCues agent={a} />
          </div>
        ))}
      </div>

      <div style={{
        flex: 1, minHeight: 0,
        display: 'flex',
        padding: 16,
        gap: 0
      }}>
        <div style={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          {/* Tab bar: office + the selected agent's workspace + the shared browser
              + a transient TASK tab when a card's full view is open. */}
          <LeftTabs
            current={leftTab}
            onChange={(tab) => {
              // Jump to the blocked agent's messages when opening the tab via its badge.
              if (tab === 'messages' && blockedAgent && blockedAgent.id !== agent?.id) select(blockedAgent.id);
              setLeftTab(tab);
            }}
            browserActive={browserActive}
            meetingRecording={meetingRecording}
            messagesNeedsYou={!!blockedAgent}
            accent={agent?.accent}
            hasOpenTask={!!openTaskId}
            hasOpenFile={!!openFilePath}
          />

          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {/* Office tab — kept mounted (display toggle) so Pixi keeps its avatars. */}
            <div style={{ position: 'absolute', inset: 0, display: leftTab === 'office' ? 'block' : 'none' }}>
              <OfficeFloor />
              {agentCount === 0 && godStatus === 'booting' && <MichaelBooting />}
              {agentCount === 0 && godStatus !== 'booting' && (
                <div style={{
                  position: 'absolute', inset: 0,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  pointerEvents: 'none'
                }}>
                  <div style={{ pointerEvents: 'auto', width: 360 }}>
                    <PixelPanel variant="dialog" title="EMPTY FLOOR" noPadding>
                      <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
                        <p style={{ margin: 0, fontSize: 14, lineHeight: '20px' }}>
                          No agents on the floor yet. Spawn one to see real claude output stream in here.
                        </p>
                        <PixelButton variant="primary" size="md" onClick={() => setAddAgentOpen(true)}>
                          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                            <Icon name="plus" /> add agent
                          </span>
                        </PixelButton>
                      </div>
                    </PixelPanel>
                  </div>
                </div>
              )}
            </div>

            {/* Browser tab — kept mounted; the native WebContentsView's visibility
                is driven by App's browserShown effect (active tab + no overlay). */}
            <div style={{ position: 'absolute', inset: 0, display: leftTab === 'browser' ? 'block' : 'none' }}>
              <BrowserPane />
            </div>

            {/* Meeting tab — kept mounted (display toggle) so the live transcript/
                insight feeds keep accumulating while you work in another tab. The
                capture engine itself is module-scoped and never depends on this. */}
            <div style={{ position: 'absolute', inset: 0, display: leftTab === 'meeting' ? 'block' : 'none' }}>
              <MeetingPanel />
            </div>

            {/* Agent workspace — the selected agent's terminal/files/messages/logs.
                Conditionally mounted (no GPU/native surface to preserve; the
                terminal pool keeps each agent's xterm buffered regardless). */}
            {isAgentTab(leftTab) && (
              <div style={{ position: 'absolute', inset: 0 }}>
                {agent ? (
                  <AgentWorkspace agent={agent} tab={leftTab} />
                ) : (
                  <PixelPanel variant="default" noPadding style={{
                    padding: 16, height: '100%',
                    display: 'flex', flexDirection: 'column',
                    justifyContent: 'center', alignItems: 'center', gap: 12
                  }}>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                      color: 'var(--cth-ink-500)'
                    }}>NO AGENT SELECTED</div>
                    <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                      Pick an agent on the office floor to see its terminal, files,
                      messages and logs here.
                    </p>
                    <PixelButton variant="secondary" size="md" onClick={() => setAddAgentOpen(true)}>
                      <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                        <Icon name="plus" /> add agent
                      </span>
                    </PixelButton>
                  </PixelPanel>
                )}
              </div>
            )}

            {/* Task full-card view — opened from the Kanban board (right column)
                into this roomy left area; the board stays visible beside it.
                Plain DOM, so conditional mount is cheap. */}
            {leftTab === 'task' && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <TaskDetailPanel />
              </div>
            )}

            {/* File viewer — a file picked from the right-column files tab opens
                here (transient `file` tab). Editable; plain DOM, cheap to mount. */}
            {leftTab === 'file' && (
              <div style={{ position: 'absolute', inset: 0 }}>
                <LeftFileEditor projectRoot={config?.activeProjectPath} />
              </div>
            )}
          </div>
        </div>

        <SidebarSplitter
          width={sidebarWidth}
          onChange={setSidebarWidth}
          viewportWidth={vpWidth}
        />

        <div style={{
          width: sidebarWidth, flexShrink: 0,
          minHeight: 0, display: 'flex', flexDirection: 'column'
        }}>
          {/* Michael's Command Center is pinned here regardless of selection — it's
              the always-on workspace overview. The selected agent's terminal/files/
              messages/logs live in the LEFT column instead. */}
          {god ? (
            <CommandCenterPanel agent={god} />
          ) : godStatus === 'booting' ? (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>WAKING THE FLOOR</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                Michael is clocking in.<br />
                The command center will land here once he's seated.
              </p>
            </PixelPanel>
          ) : (
            <PixelPanel variant="default" noPadding style={{
              padding: 16, height: '100%',
              display: 'flex', flexDirection: 'column',
              justifyContent: 'center', alignItems: 'center', gap: 12
            }}>
              <div style={{
                fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
                color: 'var(--cth-ink-500)'
              }}>MICHAEL UNAVAILABLE</div>
              <p style={{ margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
                The orchestrator isn't running.<br />
                Restart the app to bring the command center back.
              </p>
            </PixelPanel>
          )}
        </div>
      </div>

      {addAgentOpen && (
        <AddAgentModal onClose={() => setAddAgentOpen(false)} config={config} />
      )}

      {quitWarn && (
        <QuitWarningModal
          ptyCount={quitWarn.ptyCount}
          onCancel={() => { window.cth.cancelClose(); setQuitWarn(null); }}
          onConfirm={async () => { await window.cth.confirmClose(); }}
        />
      )}

      {fullscreenAgentId && <FullscreenTerminal />}
      {fullscreenFilePath && <FullscreenFileEditor />}
    </div>
  );
}
