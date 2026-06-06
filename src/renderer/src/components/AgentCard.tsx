import { PixelPanel } from './PixelPanel';
import { PixelBadge, StatusKind } from './PixelBadge';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Select } from './Select';
import { AccentColorName } from '@/design/tokens';
import { OfficeCharacterName } from '@/scene/office/cast';
import { AGENT_MODELS, AGENT_EFFORTS, type EffortLevel } from '@/store/config';

export interface AgentCardProps {
  name: string;
  character: OfficeCharacterName;
  accent: AccentColorName;
  status: StatusKind;
  project: string;
  action?: string;
  progress?: number; // 0..8 segments filled
  selected?: boolean;
  /** The orchestrator — gets a persistent accent frame + GOD tag so it stands out. */
  isGod?: boolean;
  /** The prep assistant. Same size as every other card (no special sizing). */
  isAssistant?: boolean;
  onClick?: () => void;
  /** The agent's current model id (drives the picker's selected value). */
  model?: string;
  /** The agent's current effort level (drives the effort picker's selected value). */
  effort?: EffortLevel;
  /** Tool-call tally shown beside the picker. */
  toolCalls?: number;
  /** True while this agent's pty is being killed/respawned. */
  restarting?: boolean;
  /** False when the agent has no live pty (picker/restart disabled). */
  canRestart?: boolean;
  /** Pick a model → restart the agent under it. Presence of this enables the controls row. */
  onPickModel?: (model: string | undefined) => void;
  /** Pick an effort level → restart the agent under it. */
  onPickEffort?: (effort: EffortLevel | undefined) => void;
  /** Restart the agent under its current model + effort. */
  onRestart?: () => void;
}

export function AgentCard({
  name, character, accent, status, project, action, progress = 0, selected, isGod, onClick,
  model, effort, toolCalls, restarting, canRestart, onPickModel, onPickEffort, onRestart
}: AgentCardProps) {
  // The god is always framed (stands out from the row); others only when selected.
  const framed = isGod || selected;

  return (
    <div
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); }
      }}
      className="cth-titlebar-nodrag"
      style={{
        width: 220, minWidth: 220,
        padding: 0, cursor: 'pointer', textAlign: 'left'
      }}
    >
      <PixelPanel
        variant={framed ? 'active' : 'default'}
        accent={framed ? accent : undefined}
        style={{ padding: 8 }}
        noPadding
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <div style={{
              width: 44, height: 64,
              background: `var(--cth-${accent}-light)`,
              boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden',
              flexShrink: 0
            }}>
              <SpritePortrait character={character} scale={2} />
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'space-between' }}>
                <span style={{
                  fontFamily: 'var(--cth-font-display)',
                  fontSize: 'var(--cth-text-display-sm)',
                  lineHeight: 'var(--cth-lh-display-sm)',
                  color: 'var(--cth-ink-900)',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis'
                }}>{name.toUpperCase()}</span>
                <PixelBadge status={status} />
              </div>

              <div style={{
                display: 'flex', alignItems: 'center', gap: 5,
                fontSize: 'var(--cth-text-body-sm)',
                lineHeight: '16px',
                color: 'var(--cth-ink-500)',
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
              }}>
                {isGod && (
                  <span style={{
                    fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px',
                    background: `var(--cth-${accent})`, color: 'var(--cth-ink-900)',
                    padding: '1px 5px 0', boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)', flexShrink: 0
                  }}>GOD</span>
                )}
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{project}</span>
              </div>

              <div style={{
                fontSize: 'var(--cth-text-body-sm)',
                lineHeight: '16px',
                color: 'var(--cth-ink-900)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}>{/* The "idle" badge already conveys idle — don't echo "awaiting". */
                (status === 'idle' ? '' : action) || ' '}</div>

              <div style={{ display: 'flex', gap: 2, marginTop: 2 }}>
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} style={{
                    width: 14, height: 6,
                    background: i < progress
                      ? `var(--cth-${accent})`
                      : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
                  }}/>
                ))}
              </div>
            </div>
          </div>

          {/* Model picker + restart + tool-call count. Stops click propagation so
              using the controls never re-selects the card. */}
          {onPickModel && (
            <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Select
                  value={model ?? ''}
                  disabled={!canRestart || restarting}
                  onChange={(v) => onPickModel(v || undefined)}
                >
                  {AGENT_MODELS.map((m) => (
                    <option key={m.label} value={m.id ?? ''}>
                      {m.label}{m.premium ? ' ⚠' : ''}
                    </option>
                  ))}
                </Select>
                <PixelButton
                  variant="secondary"
                  size="sm"
                  disabled={!canRestart || restarting}
                  onClick={onRestart}
                >restart</PixelButton>
              </div>
              {onPickEffort && (
                <Select
                  value={effort ?? ''}
                  disabled={!canRestart || restarting}
                  onChange={(v) => onPickEffort((v || undefined) as EffortLevel | undefined)}
                >
                  {AGENT_EFFORTS.map((e) => (
                    <option key={e.label} value={e.id ?? ''}>
                      {e.id ? `effort: ${e.label}` : 'effort: default'}{e.opus ? ' ⚠' : ''}
                    </option>
                  ))}
                </Select>
              )}
              <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                fontSize: 11, color: 'var(--cth-ink-500)'
              }}>
                <span>{restarting ? 'restarting…' : !canRestart ? 'no pty' : 'model / effort · restarts agent'}</span>
                <span style={{ marginLeft: 'auto' }}>{toolCalls ?? 0} tool calls</span>
              </div>
            </div>
          )}
        </div>
      </PixelPanel>
    </div>
  );
}
