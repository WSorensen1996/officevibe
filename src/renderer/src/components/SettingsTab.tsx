import { useEffect, useState, type CSSProperties } from 'react';
import type { HarnessConfig } from '@/store/config';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { ProjectSwitcher } from './ProjectSwitcher';
import { useStore } from '@/store/store';

/** Settings as a Command-Center tab. Lifted out of the old SettingsModal so the
 *  app no longer needs a title-bar gear: same controls (config summary, desktop
 *  notifications, Slack, danger-zone reset) plus the new "Auto-pilot on startup"
 *  toggle, rendered inline in the tab body instead of a centered modal. */

/** Whisper dictation model choices, shown as a two-option picker (mirrors the
 *  embedding-model grid in MemoryPanel). The id is the on-disk model folder name. */
type SttModelId = HarnessConfig['sttModel'];
const STT_MODELS: { id: SttModelId; title: string; detail: string }[] = [
  { id: 'whisper-base.en', title: 'Standard', detail: 'More accurate · ~78 MB' },
  { id: 'whisper-tiny.en', title: 'Fast', detail: 'Quicker · ~44 MB, lower accuracy' }
];

/** Slack fields live on the main-process config; the renderer mirror type doesn't
 *  declare them, so read them off a widened view. */
type SlackConfig = HarnessConfig & {
  slackEnabled?: boolean;
  slackSigningSecret?: string;
  slackChannelId?: string;
  slackPort?: number;
};

const inputStyle: CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

const labelStyle: CSSProperties = {
  fontFamily: 'var(--cth-font-display)',
  fontSize: 8,
  lineHeight: '12px',
  color: 'var(--cth-ink-700)',
  textTransform: 'uppercase'
};

/** Clear every renderer-side persisted key so a relaunch starts truly empty. */
function clearLocalState(): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith('cth.')) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch { /* noop */ }
}

export function SettingsTab() {
  const [config, setConfig] = useState<HarnessConfig | null>(null);
  useEffect(() => {
    let cancelled = false;
    window.cth.getConfig().then((c) => { if (!cancelled) setConfig(c); }).catch(() => { /* noop */ });
    return () => { cancelled = true; };
  }, []);

  if (!config) {
    return <div style={scrollStyle}><Muted>Loading settings…</Muted></div>;
  }
  // Re-mount the body when config arrives so each toggle's initial state is seeded
  // from the real values (useState initializers only run once).
  return <SettingsBody config={config} />;
}

function SettingsBody({ config }: { config: HarnessConfig }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  // `notifications` is optional on the main-process config; read it defensively.
  const [notifications, setNotifications] = useState<boolean>(
    (config as HarnessConfig & { notifications?: boolean }).notifications === true
  );
  const toggleNotifications = async () => {
    const next = !notifications;
    setNotifications(next); // optimistic
    try { await window.cth.setNotifications(next); }
    catch { setNotifications(!next); /* revert on failure */ }
  };

  // ─── Assistant enrichment (store-backed; persisted to localStorage) ─────────
  // Relocated from the old Floor tab's ASSISTANT section.
  const enrichEnabled = useStore((s) => s.enrichEnabled);
  const setEnrichEnabled = useStore((s) => s.setEnrichEnabled);

  // ─── Auto-pilot on startup ─────────────────────────────────────────────────
  const [autoPilot, setAutoPilot] = useState<boolean>(config.autoPilot === true);
  const toggleAutoPilot = async () => {
    const next = !autoPilot;
    setAutoPilot(next); // optimistic
    try { await window.cth.updateConfig({ autoPilot: next }); }
    catch { setAutoPilot(!next); /* revert on failure */ }
  };

  // ─── Remote control on startup ─────────────────────────────────────────────
  const [remoteControl, setRemoteControl] = useState<boolean>(config.remoteControl === true);
  const toggleRemoteControl = async () => {
    const next = !remoteControl;
    setRemoteControl(next); // optimistic
    try { await window.cth.updateConfig({ remoteControl: next }); }
    catch { setRemoteControl(!next); /* revert on failure */ }
  };

  // ─── Dictation (speech-to-text) model ──────────────────────────────────────
  const [sttModel, setSttModel] = useState<SttModelId>(config.sttModel ?? 'whisper-base.en');
  const pickSttModel = async (next: SttModelId) => {
    if (next === sttModel) return;
    const prev = sttModel;
    setSttModel(next); // optimistic
    try { await window.cth.updateConfig({ sttModel: next }); }
    catch { setSttModel(prev); /* revert on failure */ }
  };

  // ─── Slack integration ─────────────────────────────────────────────────────
  const slackCfg = config as SlackConfig;
  const [slackEnabled, setSlackEnabled] = useState(slackCfg.slackEnabled ?? false);
  const [slackSecret, setSlackSecret] = useState(slackCfg.slackSigningSecret ?? '');
  const [slackChannel, setSlackChannel] = useState(slackCfg.slackChannelId ?? '');
  const [slackPort, setSlackPort] = useState(String(slackCfg.slackPort ?? 3847));
  const [tunnelUrl, setTunnelUrl] = useState('');
  const [slackBusy, setSlackBusy] = useState(false);
  const [slackNote, setSlackNote] = useState('');

  const slackPatch = (enabled: boolean) => ({
    signingSecret: slackSecret,
    channelId: slackChannel,
    port: Number(slackPort) || 3847,
    enabled
  });

  const saveSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      await window.cth.slackSetConfig(slackPatch(slackEnabled));
      setSlackNote('saved');
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const startSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try {
      await window.cth.slackSetConfig(slackPatch(true));
      setSlackEnabled(true);
      const res = await window.cth.slackStart();
      if (res.ok) {
        setTunnelUrl(res.url ?? '');
        setSlackNote(res.url ? 'listening' : (res.error ?? 'started, but tunnel unavailable'));
      } else {
        setSlackNote(res.error ?? 'failed to start');
      }
    } catch (e) {
      setSlackNote(e instanceof Error ? e.message : String(e));
    } finally { setSlackBusy(false); }
  };

  const stopSlack = async () => {
    setSlackBusy(true); setSlackNote('');
    try { await window.cth.slackStop(); setTunnelUrl(''); setSlackNote('stopped'); }
    catch (e) { setSlackNote(e instanceof Error ? e.message : String(e)); }
    finally { setSlackBusy(false); }
  };

  const copyTunnel = () => { void window.cth.copyToClipboard(tunnelUrl); };

  const reset = async () => {
    setBusy(true);
    clearLocalState();
    // Wipes the active project + palace, resets config, and relaunches into
    // onboarding. The app exits, so this never resolves — no need to clear `busy`.
    await window.cth.resetAll();
  };

  const rows: Array<[string, string]> = [
    ['Home folder', config.harnessHome ?? '—'],
    ['Auto mode', config.autoMode ? 'on' : 'off'],
    ['Semantic memory', config.semanticMemory ? 'on' : 'off'],
    ['Command', config.defaultCommand]
  ];

  if (confirming) {
    return (
      <div style={scrollStyle}>
        <Section title="RESET EVERYTHING?">
          <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 14 }}>
            <div style={{
              width: 32, height: 32, flexShrink: 0,
              background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
              display: 'flex', alignItems: 'center', justifyContent: 'center'
            }}>
              <Icon name="bell" />
            </div>
            <div style={{ flex: 1, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
              This permanently erases all of Michael's memories and the entire active project, and
              cannot be undone. Any running sessions will be terminated and the app will relaunch
              into onboarding. Are you sure?
            </div>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
            <PixelButton variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
              cancel
            </PixelButton>
            <PixelButton variant="destructive" size="md" onClick={reset} disabled={busy}>
              {busy ? 'resetting…' : 'erase everything & restart'}
            </PixelButton>
          </div>
        </Section>
      </div>
    );
  }

  return (
    <div style={scrollStyle}>
      <Section title="PROJECT">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
            Switch between projects, open an existing folder, or create a new one. Each
            project is its own folder of agents, tasks, board, and memory. Switching
            relaunches the app.
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <ProjectSwitcher config={config} />
          </div>
          {config.activeProjectPath && (
            <div style={{ display: 'flex', gap: 12, fontSize: 13, lineHeight: '18px' }}>
              <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>Folder</span>
              <span style={{ color: 'var(--cth-ink-900)', wordBreak: 'break-all', fontFamily: 'var(--cth-font-mono, monospace)' }}>
                {config.activeProjectPath}
              </span>
            </div>
          )}
        </div>
      </Section>

      <Section title="CONFIG">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {rows.map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 12, fontSize: 14, lineHeight: '20px' }}>
              <span style={{ width: 140, flexShrink: 0, color: 'var(--cth-ink-500)' }}>{label}</span>
              <span style={{
                color: 'var(--cth-ink-900)', wordBreak: 'break-all',
                fontFamily: label === 'Home folder' || label === 'Command' ? 'var(--cth-font-mono, monospace)' : undefined
              }}>{value}</span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="DIRECTORIES">
        {config.registeredRepos.length === 0 && <Muted>No registered repos.</Muted>}
        {config.registeredRepos.map((r) => (
          <div key={r} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
            <span style={{ flex: 1, fontSize: 12, color: 'var(--cth-ink-700)', wordBreak: 'break-all' }}>{r}</span>
            <button
              onClick={() => window.cth.openTerminalAt(r)}
              title="Open in Terminal.app"
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--cth-ink-500)' }}
            ><Icon name="terminal" /></button>
          </div>
        ))}
      </Section>

      <Section title="STARTUP">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <ToggleRow
            title="Auto-pilot on startup"
            caption="When off, Michael spawns idle and waits — you start work from the Tasks kanban or the composer. Takes effect on next launch."
            on={autoPilot}
            onToggle={toggleAutoPilot}
          />
          <ToggleRow
            title="Remote control on startup"
            caption="Auto-runs /remote-control on Michael when he first spawns, so you can approve permission prompts from your phone. Takes effect on his next fresh spawn."
            on={remoteControl}
            onToggle={toggleRemoteControl}
          />
        </div>
      </Section>

      <Section title="DICTATION">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
            Which on-device model powers the mic. Both run fully offline on the CPU. Takes effect on your next dictation.
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {STT_MODELS.map((m) => {
              const sel = sttModel === m.id;
              return (
                <button
                  key={m.id}
                  onClick={() => pickSttModel(m.id)}
                  style={{
                    flex: 1, textAlign: 'left', cursor: 'pointer', border: 'none',
                    padding: '7px 9px 6px',
                    background: sel ? 'var(--cth-lemon-light)' : 'var(--cth-cream-100)',
                    boxShadow: sel ? 'inset 0 0 0 2px var(--cth-ink-900)' : 'inset 0 0 0 1px var(--cth-ink-300)',
                    fontFamily: 'var(--cth-font-ui)'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, color: 'var(--cth-ink-900)' }}>
                    <span style={{
                      width: 8, height: 8, flexShrink: 0,
                      background: sel ? 'var(--cth-ink-900)' : 'transparent',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                    }} />
                    {m.title}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 3 }}>{m.detail}</div>
                </button>
              );
            })}
          </div>
        </div>
      </Section>

      <Section title="NOTIFICATIONS">
        <ToggleRow
          title="Desktop notifications"
          caption="Native toasts when an agent finishes or needs your input."
          on={notifications}
          onToggle={toggleNotifications}
        />
      </Section>

      <Section title="ASSISTANT">
        <ToggleRow
          title="Enrich Michael's queue"
          caption="Route Michael's queue through Dwight to enrich prompts with project context before delivery."
          on={enrichEnabled}
          onToggle={() => setEnrichEnabled(!enrichEnabled)}
        />
      </Section>

      <Section title="SLACK">
        <ToggleRow
          title="Slack integration"
          caption="Pipe a Slack channel's messages straight into Michael's queue."
          on={slackEnabled}
          onToggle={() => setSlackEnabled((v) => !v)}
        />
        {slackEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={labelStyle}>Signing secret</span>
              <input
                type="password"
                value={slackSecret}
                onChange={(e) => setSlackSecret(e.target.value)}
                placeholder="Slack app → Basic Information → Signing Secret"
                style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
              />
            </label>

            <div style={{ display: 'flex', gap: 10 }}>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                <span style={labelStyle}>Channel id (optional)</span>
                <input
                  value={slackChannel}
                  onChange={(e) => setSlackChannel(e.target.value)}
                  placeholder="C0123… or blank for any"
                  style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                />
              </label>
              <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 92 }}>
                <span style={labelStyle}>Port</span>
                <input
                  type="number"
                  value={slackPort}
                  onChange={(e) => setSlackPort(e.target.value)}
                  placeholder="3847"
                  style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }}
                />
              </label>
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <PixelButton variant="primary" size="sm" onClick={startSlack} disabled={slackBusy || !slackSecret.trim()}>
                {slackBusy ? '…' : 'start'}
              </PixelButton>
              <PixelButton variant="secondary" size="sm" onClick={stopSlack} disabled={slackBusy}>
                stop
              </PixelButton>
              <PixelButton variant="ghost" size="sm" onClick={saveSlack} disabled={slackBusy}>
                save
              </PixelButton>
              {slackNote && <span style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{slackNote}</span>}
            </div>

            {tunnelUrl && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <span style={labelStyle}>Request URL — paste into Slack Event Subscriptions</span>
                <div style={{ display: 'flex', gap: 6 }}>
                  <input
                    readOnly
                    value={tunnelUrl}
                    onFocus={(e) => e.currentTarget.select()}
                    style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', fontSize: 12 }}
                  />
                  <PixelButton variant="secondary" size="sm" onClick={copyTunnel}>copy</PixelButton>
                </div>
              </div>
            )}

            <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>
              In your Slack app: enable Event Subscriptions → add the{' '}
              <code>message.channels</code> / <code>message.groups</code> bot event → set the
              Request URL above → reinstall to your workspace. The tunnel URL changes on every
              restart, so re-paste it after pressing Start again.
            </span>
          </div>
        )}
      </Section>

      <Section title="DANGER ZONE">
        <p style={{ margin: '0 0 10px', fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
          Reset wipes Michael's memories, the entire active project (every agent, message, task, and
          the board), the semantic-memory palace, and all settings — then takes you back to onboarding.
        </p>
        <PixelButton variant="destructive" size="md" onClick={() => setConfirming(true)}>
          reset &amp; start over
        </PixelButton>
      </Section>
    </div>
  );
}

// ─── small shared bits (mirrors CommandCenterPanel's tab idiom) ──────────────

const scrollStyle: CSSProperties = {
  flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, background: 'var(--cth-paper-200)'
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

/** A labelled on/off row: title + caption on the left, a toggle button on the right. */
function ToggleRow({ title, caption, on, onToggle }: {
  title: string; caption: string; on: boolean; onToggle: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1, minWidth: 0 }}>
        <span style={{ fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-900)' }}>{title}</span>
        <span style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-500)' }}>{caption}</span>
      </div>
      <PixelButton variant={on ? 'primary' : 'secondary'} size="sm" onClick={onToggle}>
        {on ? 'on' : 'off'}
      </PixelButton>
    </div>
  );
}
