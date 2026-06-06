import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { SpritePortrait } from './SpritePortrait';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';
import { OFFICE_CAST, DEFAULT_CHARACTER, type OfficeCharacterName } from '@/scene/office/cast';
import { type AccentColorName } from '@/design/tokens';
import { type HarnessConfig, type EffortLevel, buildSpawnCommand, AGENT_MODELS, AGENT_EFFORTS } from '@/store/config';

const ACCENTS: AccentColorName[] = ['coral', 'mint', 'sky', 'lemon', 'lilac', 'peach'];

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path;
}

function uniqueId(name: string): string {
  return `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString(36)}`;
}

export interface AddAgentModalProps {
  onClose: () => void;
  config: HarnessConfig;
}

export function AddAgentModal({ onClose, config }: AddAgentModalProps) {
  const addAgent = useStore(s => s.addAgent);
  const agents = useStore(s => s.agents);

  const [name, setName] = useState('Jim');
  const [character, setCharacter] = useState<OfficeCharacterName>(DEFAULT_CHARACTER);
  const [accent, setAccent] = useState<AccentColorName>('sky');
  // Default the folder to the one other agents already run in, so adding a
  // second/third agent lands in the same project without re-picking. We take
  // the most recently added "peer" agent — skipping the orchestrator (isGod)
  // and its assistant (isAssistant), whose cwd is the data root, not a code
  // folder, and skipping archived agents. Falls back to a registered repo,
  // then empty (the original behavior).
  const defaultCwd =
    [...agents].reverse().find(a => !a.isGod && !a.isAssistant && !a.archived && a.cwd)?.cwd
    ?? config.registeredRepos[0]
    ?? '';
  const [cwd, setCwd] = useState<string>(defaultCwd);
  const [model, setModel] = useState<string | undefined>(config.defaultModel);
  const [effort, setEffort] = useState<EffortLevel | undefined>(config.defaultEffort);
  const [command, setCommand] = useState(buildSpawnCommand(config, config.defaultModel, config.defaultEffort));
  const [description, setDescription] = useState('a fresh harness');

  // Picking a model/effort rebuilds the command; the command field stays editable
  // for power users (it's the source of truth for the actual spawn).
  const pickModel = (id?: string) => {
    setModel(id);
    setCommand(buildSpawnCommand(config, id, effort));
  };
  const pickEffort = (level?: EffortLevel) => {
    setEffort(level);
    setCommand(buildSpawnCommand(config, model, level));
  };
  const [goal, setGoal] = useState('');
  const [isolate, setIsolate] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const pickFolder = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setCwd(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const submit = async () => {
    setError(undefined);
    if (!name.trim()) { setError('Name is required'); return; }
    if (!cwd) { setError('Pick a folder first'); return; }
    if (!command.trim()) { setError('Command is required'); return; }

    setBusy(true);
    const id = uniqueId(name);
    const ptyId = `pty-${id}`;
    // The command field contains `claude --permission-mode bypassPermissions`
    // for auto mode. Split into argv-style for node-pty.
    const [exe, ...args] = command.trim().split(/\s+/);
    const spawnRes = await window.cth.spawnPty({
      id: ptyId,
      cwd,
      command: exe,
      args,
      cols: 100,
      rows: 30,
      // When set, the main process spawns this agent in its own git worktree.
      isolate,
      // Provision this agent in the hive (memory + mailbox + identity/protocol).
      hive: {
        id,
        name: name.trim(),
        cwd,
        role: description.trim() || undefined
      }
    });
    if (!spawnRes.ok) {
      setBusy(false);
      setError(spawnRes.error ?? 'spawn failed');
      return;
    }

    const agent: Agent = {
      id,
      name: name.trim(),
      character,
      accent,
      description: description.trim() || 'a fresh harness',
      project: basename(cwd),
      tmuxTarget: '',
      cwd,
      goal: goal.trim() || undefined,
      status: 'idle',
      action: 'starting up',
      progress: 0,
      currentStation: 'desk',
      ptyId,
      command: command.trim(),
      model,
      effort,
      recentTextTs: Date.now()
    };
    addAgent(agent);
    setBusy(false);
    onClose();
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 100
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 600, maxWidth: '92vw' }}>
        <PixelPanel
          variant="dialog"
          title="ADD AGENT"
          style={{ padding: 16 }}
          noPadding
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
            <Row label="Name">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ada"
                style={inputStyle}
              />
            </Row>

            <Row label="Folder">
              {config.registeredRepos.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 }}>
                  {config.registeredRepos.map((r) => (
                    <button
                      key={r}
                      onClick={() => setCwd(r)}
                      title={r}
                      style={{
                        padding: '3px 8px 1px',
                        background: cwd === r ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: cwd === r
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)',
                        fontSize: 13,
                        cursor: 'pointer',
                        border: 'none'
                      }}
                    >
                      {basename(r)}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={cwd}
                  onChange={(e) => setCwd(e.target.value)}
                  placeholder="/path/to/your/project"
                  style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 14 }}
                />
                <PixelButton variant="secondary" size="md" onClick={pickFolder}>
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <Icon name="folder" /> pick
                  </span>
                </PixelButton>
              </div>
            </Row>

            <Row label="Model">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {AGENT_MODELS.map((m) => {
                  const active = (model ?? '') === (m.id ?? '');
                  return (
                    <button
                      key={m.label}
                      onClick={() => pickModel(m.id)}
                      title={m.premium
                        ? `${m.id} — may cost extra; overrides your default model`
                        : (m.id ?? 'CLI default model')}
                      style={{
                        padding: '3px 8px 1px',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                        color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                      }}
                    >
                      {m.label}{m.premium ? ' ⚠' : ''}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 4 }}>
                <strong>default</strong> uses your subscription's model. ⚠ marks models that
                override it and may cost extra if not in your plan.
              </div>
            </Row>

            <Row label="Effort">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {AGENT_EFFORTS.map((e) => {
                  const active = (effort ?? '') === (e.id ?? '');
                  return (
                    <button
                      key={e.label}
                      onClick={() => pickEffort(e.id)}
                      title={e.opus
                        ? `${e.id} — best on Opus-tier models`
                        : (e.id ?? "Claude Code's default effort")}
                      style={{
                        padding: '3px 8px 1px',
                        background: active ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                        boxShadow: active
                          ? 'inset 0 0 0 2px var(--cth-ink-900)'
                          : 'inset 0 0 0 1px var(--cth-ink-700)',
                        fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                        color: 'var(--cth-ink-900)', cursor: 'pointer', border: 'none'
                      }}
                    >
                      {e.label}{e.opus ? ' ⚠' : ''}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 4 }}>
                How hard this agent thinks. <strong>default</strong> keeps Claude Code's own
                setting. ⚠ X-High / Max are best on Opus-tier models.
              </div>
            </Row>

            <Row label={config.autoMode ? 'Command (auto mode on)' : 'Command'}>
              <input
                value={command}
                onChange={(e) => setCommand(e.target.value)}
                placeholder="claude"
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
              />
            </Row>

            <Row label="Description">
              <input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="what is this agent for"
                style={inputStyle}
              />
            </Row>

            <Row label="Goal (optional)">
              <textarea
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                placeholder="long-running directive injected on every prompt"
                rows={2}
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-ui)', resize: 'none' }}
              />
            </Row>

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={isolate}
                onChange={(e) => setIsolate(e.target.checked)}
                style={{ width: 16, height: 16, cursor: 'pointer' }}
              />
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
                Git isolation (own worktree)
              </span>
            </label>

            <Row label="Character">
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {OFFICE_CAST.map(c => (
                  <button
                    key={c.name}
                    onClick={() => { setCharacter(c.name); setName(c.displayName); }}
                    title={c.blurb}
                    style={{
                      padding: 4,
                      background: character === c.name ? `var(--cth-${accent}-light)` : 'var(--cth-cream-100)',
                      boxShadow: character === c.name
                        ? 'inset 0 0 0 2px var(--cth-ink-900)'
                        : 'inset 0 0 0 1px var(--cth-ink-700)',
                      cursor: 'pointer',
                      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
                      border: 'none', width: 56
                    }}
                  >
                    <div style={{ width: 44, height: 56, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden' }}>
                      <SpritePortrait character={c.name} scale={2} />
                    </div>
                    <span style={{ fontSize: 11, color: 'var(--cth-ink-700)' }}>{c.displayName}</span>
                  </button>
                ))}
              </div>
            </Row>

            <Row label="Color">
              <div style={{ display: 'flex', gap: 6 }}>
                {ACCENTS.map(a => (
                  <button
                    key={a}
                    onClick={() => setAccent(a)}
                    style={{
                      width: 32, height: 32,
                      background: `var(--cth-${a})`,
                      boxShadow: accent === a
                        ? 'inset 0 0 0 2px var(--cth-ink-900), 0 0 0 2px var(--cth-ink-900)'
                        : 'inset 0 0 0 1px var(--cth-ink-900)',
                      cursor: 'pointer',
                      border: 'none'
                    }}
                    aria-label={a}
                  />
                ))}
              </div>
            </Row>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 14,
                color: 'var(--cth-ink-900)'
              }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 4 }}>
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? 'spawning...' : 'spawn'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 16,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontFamily: 'var(--cth-font-display)',
        fontSize: 8, lineHeight: '12px',
        color: 'var(--cth-ink-700)',
        textTransform: 'uppercase'
      }}>{label}</span>
      {children}
    </label>
  );
}
