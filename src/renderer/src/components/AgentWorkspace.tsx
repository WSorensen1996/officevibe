import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelBadge } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { PtyTerminalView } from './PtyTerminalView';
import { MessageQueueComposer } from './MessageQueueComposer';
import { AssistantRoleNote } from './AssistantRoleNote';
import { FilesTab } from './FilesTab';
import { ThreadsPanel } from './ThreadsPanel';
import { LogsTab } from './LogsTab';
import { Icon } from './Icon';
import { disposeTerminal } from './terminalPool';
import { useStore, type Agent, type LeftTab } from '@/store/store';
import { usePtyParser } from '@/hooks/usePtyParser';

export interface AgentWorkspaceProps {
  agent: Agent;
  /** Which agent-scoped view to show. Expected to be one of the agent left tabs
   *  (terminal/files/messages/logs); other values render nothing. */
  tab: LeftTab;
}

/**
 * The selected agent's workspace, shown in the LEFT column when an agent left tab
 * (terminal/files/messages/logs) is active. A thin header (portrait, name, status,
 * open-in-Terminal, kill) sits above the active tab's body.
 *
 * Every agent renders here the same way — including Michael (the god agent). His
 * Command Center on the right is a pure overview with no terminal tab, so his pty
 * has exactly one mount (here), respecting terminalPool's one-xterm-per-ptyId rule.
 * We only suppress the kill button for him (you never close the orchestrator).
 */
export function AgentWorkspace({ agent, tab }: AgentWorkspaceProps) {
  const [openTerminalState, setOpenTerminalState] = useState<'idle' | 'opening' | 'ok' | 'error'>('idle');
  const [openTerminalError, setOpenTerminalError] = useState<string | undefined>();
  const archiveAgent = useStore(s => s.archiveAgent);
  const updateAgent = useStore(s => s.updateAgent);
  const setFullscreen = useStore(s => s.setFullscreen);
  const fullscreenAgentId = useStore(s => s.fullscreenAgentId);
  const isReal = !!agent.ptyId;
  // While this agent is shown in the fullscreen overlay, the fullscreen view owns
  // the pty (it sizes it to fill the screen). Keeping the embedded terminal mounted
  // too means two xterms fight over the pty's cols/rows — which corrupts the display
  // and breaks scrolling. So we unmount the embedded one here; it re-mounts and
  // re-fits when fullscreen closes.
  const isFullscreenedHere = fullscreenAgentId === agent.id;

  // Inert for the god agent: his terminal is never mounted here, so this callback
  // is never wired into a PtyTerminalView and never runs (see usePtyParser).
  const onPtyStream = usePtyParser(agent.id);

  const openTerminal = async () => {
    setOpenTerminalState('opening');
    setOpenTerminalError(undefined);
    try {
      const result = await window.cth.openTerminalAt(agent.cwd);
      if (result.ok) {
        setOpenTerminalState('ok');
        setTimeout(() => setOpenTerminalState('idle'), 1500);
      } else {
        setOpenTerminalState('error');
        setOpenTerminalError(result.error ?? 'unknown error');
        setTimeout(() => setOpenTerminalState('idle'), 4000);
      }
    } catch (e) {
      setOpenTerminalState('error');
      setOpenTerminalError(e instanceof Error ? e.message : String(e));
      setTimeout(() => setOpenTerminalState('idle'), 4000);
    }
  };

  const onKill = async () => {
    if (!agent.ptyId) return;
    if (!confirm(`Close ${agent.name}? The PTY process will terminate and the agent is archived (kept in history, off the floor).`)) return;
    await window.cth.killPty(agent.ptyId);
    disposeTerminal(agent.ptyId);
    archiveAgent(agent.id);
  };

  return (
    <PixelPanel
      variant="default"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        padding: 0,
        overflow: 'hidden'
      }}
      noPadding
    >
      {/* Thin header strip (NOT a window-drag region — the drag strip lives at the
          window edge / on the Command Center header). */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px',
        background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)',
        flexShrink: 0
      }}>
        <div style={{
          width: 32, height: 32,
          background: `var(--cth-${agent.accent}-light)`,
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
          display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
          flexShrink: 0
        }}>
          <SpritePortrait character={agent.character} scale={1} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontFamily: 'var(--cth-font-display)',
            fontSize: 10, lineHeight: '14px',
            color: 'var(--cth-ink-900)',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
          }}>{agent.name.toUpperCase()}</div>
          <div style={{
            display: 'flex', gap: 6, alignItems: 'center', marginTop: 1
          }}>
            <PixelBadge status={agent.status} />
            <span style={{
              fontSize: 12, color: 'var(--cth-ink-500)',
              whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
            }}>{agent.project}</span>
          </div>
        </div>
        <PixelButton variant="secondary" size="sm" onClick={openTerminal} disabled={openTerminalState === 'opening'}>
          <span title={`open Terminal.app at ${agent.cwd}`} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <Icon name="terminal" />
            {openTerminalState === 'opening' ? '...' : openTerminalState === 'ok' ? 'ok' : openTerminalState === 'error' ? 'err' : 'open'}
          </span>
        </PixelButton>
        {/* Never offer to kill Michael — he runs the floor. */}
        {isReal && !agent.isGod && (
          <PixelButton variant="destructive" size="sm" onClick={onKill}>
            <Icon name="x" />
          </PixelButton>
        )}
      </div>

      {openTerminalError && (
        <div style={{
          fontSize: 12, color: 'var(--cth-coral)',
          padding: '2px 8px',
          background: 'var(--cth-coral-light)',
          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
        }}>{openTerminalError}</div>
      )}

      {/* Active tab body — fills remaining space. Michael renders here just like a
          worker: his terminal now lives on the left and has no other mount, so the
          one-xterm-per-pty rule is respected (the Command Center has no terminal
          tab anymore). */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        {tab === 'terminal' ? (
          isReal && agent.ptyId ? (
            isFullscreenedHere ? (
              <EmptyTab title="In fullscreen">
                This terminal is open in fullscreen. Press Esc or exit fullscreen to bring it back here.
              </EmptyTab>
            ) : (
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
                  <PtyTerminalView
                    key={agent.ptyId}
                    ptyId={agent.ptyId}
                    onStreamData={onPtyStream}
                    onUserPrompt={(t) => updateAgent(agent.id, { lastPrompt: t })}
                    onToggleFullscreen={() => setFullscreen(agent.id)}
                    fullscreen={false}
                    embedded
                  />
                </div>
                {agent.isAssistant ? <AssistantRoleNote /> : <MessageQueueComposer agent={agent} />}
              </div>
            )
          ) : (
            <EmptyTab title="No PTY">
              This agent has no live terminal. Spawn an agent through "add agent" to use the terminal tab.
            </EmptyTab>
          )
        ) : tab === 'files' ? (
          <FilesTab cwd={agent.cwd} />
        ) : tab === 'messages' ? (
          <ThreadsPanel agentId={agent.id} />
        ) : tab === 'logs' ? (
          <LogsTab agentId={agent.id} />
        ) : null}
      </div>
    </PixelPanel>
  );
}

function EmptyTab({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      padding: 16, gap: 8,
      background: 'var(--cth-paper-200)'
    }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
        color: 'var(--cth-ink-500)'
      }}>{title.toUpperCase()}</div>
      <p style={{
        margin: 0, fontSize: 14, textAlign: 'center', color: 'var(--cth-ink-700)',
        maxWidth: 280
      }}>{children}</p>
    </div>
  );
}
