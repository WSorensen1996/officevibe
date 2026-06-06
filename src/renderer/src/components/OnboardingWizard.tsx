import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import { SpritePortrait } from './SpritePortrait';
import type { HarnessConfig } from '@/store/config';

export interface OnboardingWizardProps {
  onComplete: (config: HarnessConfig) => void;
}

type Step = 'welcome' | 'home' | 'repos' | 'auto' | 'done';

export function OnboardingWizard({ onComplete }: OnboardingWizardProps) {
  const [step, setStep] = useState<Step>('welcome');
  const [home, setHome] = useState<string>('');
  const [projectName, setProjectName] = useState<string>('Default');
  const [repos, setRepos] = useState<string[]>([]);
  const [autoMode, setAutoMode] = useState<boolean>(true);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  // Default-suggest a sensible projects folder on first render
  useEffect(() => {
    if (!home) {
      const homeDir = (window as any).process?.env?.HOME ?? '';
      // Without a HOME env in the renderer sandbox we fall back to a hint;
      // user can still pick whatever they want.
      setHome(homeDir ? `${homeDir}/OfficeVibe` : '');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Folder name we'll create for the first project, mirrors main's projectFolderName. */
  const folderPreview = `officevibe-${projectName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project'}`;

  const pickHome = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setHome(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const pickRepo = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok && !repos.includes(res.path)) setRepos([...repos, res.path]);
    else if (!res.ok && res.error !== 'cancelled') setError(res.error);
  };

  const removeRepo = (path: string) => setRepos(repos.filter(r => r !== path));

  const finish = async () => {
    setBusy(true);
    setError(undefined);
    if (!home) { setError('Pick a folder to keep your projects in first.'); setBusy(false); setStep('home'); return; }
    if (!projectName.trim()) { setError('Name your first project first.'); setBusy(false); setStep('home'); return; }
    const ensure = await window.cth.ensureHarnessHome(home);
    if (!ensure.ok) {
      setError(ensure.error ?? 'could not create the projects folder');
      setBusy(false);
      return;
    }
    // Persist the onboarding choices, then create the first project. projectCreate
    // writes activeProjectPath + projects and relaunches the app, so the boot
    // sequence bootstraps every service against the new project. On success the
    // process exits (this promise never resolves); we only return here on failure.
    await window.cth.updateConfig({
      onboardingComplete: true,
      harnessHome: home,
      registeredRepos: repos,
      autoMode
    });
    const res = await window.cth.projectCreate(projectName.trim(), home);
    if (res && !res.ok) {
      setError(res.error ?? 'could not create the project');
      setBusy(false);
      return;
    }
    // Fallback (should not be reached — projectCreate relaunches on success):
    onComplete(await window.cth.getConfig());
  };

  return (
    <div style={{
      position: 'fixed', inset: 0,
      background: 'var(--cth-cream-200)',
      backgroundImage:
        `repeating-linear-gradient(45deg, rgba(232, 217, 160, 0.4) 0 1px, transparent 1px 8px)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 200,
      padding: 32
    }}>
      <div style={{ width: 640, maxWidth: '94vw' }}>
        <PixelPanel
          variant="dialog"
          title={
            step === 'welcome' ? 'WELCOME'
            : step === 'home' ? 'STEP 1 OF 3 · YOUR FIRST PROJECT'
            : step === 'repos' ? 'STEP 2 OF 3 · YOUR REPOS'
            : step === 'auto' ? 'STEP 3 OF 3 · AUTO MODE'
            : 'ALL SET'
          }
          noPadding
        >
          <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 16 }}>

            {step === 'welcome' && (
              <>
                <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                  <div style={{
                    width: 64, height: 64,
                    background: 'var(--cth-sky-light)',
                    boxShadow: 'inset 0 0 0 2px var(--cth-ink-900)',
                    display: 'flex', alignItems: 'flex-end', justifyContent: 'center', overflow: 'hidden'
                  }}>
                    <SpritePortrait character="michael" scale={2} />
                  </div>
                  <div>
                    <div style={{
                      fontFamily: 'var(--cth-font-display)',
                      fontSize: 12, lineHeight: '20px'
                    }}>HI, I'M YOUR HARNESS</div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)' }}>
                      A control room for the Claude Code agents you run on this machine.
                    </div>
                  </div>
                </div>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  We're going to create your first <strong>project</strong> (a workspace for a team
                  of agents), add the repos you want agents to work on, and confirm that agents
                  should run unattended. Three quick steps.
                </p>
              </>
            )}

            {step === 'home' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  A <strong>project</strong> is a self-contained workspace for a team of agents —
                  their roster, tasks, board, and memory all live in one folder. Name your first
                  project and pick where to keep it; we'll create a folder there.
                </p>
                <div>
                  <label style={labelStyle}>PROJECT NAME</label>
                  <input
                    value={projectName}
                    onChange={(e) => setProjectName(e.target.value)}
                    placeholder="Default"
                    style={{ ...inputStyle, width: '100%' }}
                  />
                </div>
                <div>
                  <label style={labelStyle}>PROJECTS FOLDER (the parent directory)</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <input
                      value={home}
                      onChange={(e) => setHome(e.target.value)}
                      placeholder="/path/to/OfficeVibe"
                      style={inputStyle}
                    />
                    <PixelButton variant="secondary" size="md" onClick={pickHome}>
                      <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                        <Icon name="folder" /> pick
                      </span>
                    </PixelButton>
                  </div>
                </div>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  We'll create{' '}
                  <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                    {home || '…'}/{folderPreview}
                  </code>
                  . You can open or create more projects any time from the project switcher.
                </div>
              </>
            )}

            {step === 'repos' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Add the existing repos you want claude agents to run on. Each one becomes
                  a room on the floor — multiple agents can live in the same repo. You can
                  add more later.
                </p>
                <div style={{
                  display: 'flex', flexDirection: 'column', gap: 6,
                  maxHeight: 200, overflowY: 'auto'
                }}>
                  {repos.length === 0 && (
                    <div style={{
                      padding: 12,
                      fontSize: 14,
                      color: 'var(--cth-ink-500)',
                      background: 'var(--cth-paper-200)',
                      textAlign: 'center'
                    }}>
                      No repos added yet. Optional, but recommended.
                    </div>
                  )}
                  {repos.map((r) => (
                    <div key={r} style={{
                      display: 'flex', alignItems: 'center', gap: 8,
                      padding: '6px 10px',
                      background: 'var(--cth-paper-100)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)'
                    }}>
                      <Icon name="folder" />
                      <span style={{
                        flex: 1,
                        fontFamily: 'var(--cth-font-mono)', fontSize: 14,
                        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
                      }}>{r}</span>
                      <PixelButton variant="ghost" size="sm" onClick={() => removeRepo(r)}>
                        <Icon name="x" />
                      </PixelButton>
                    </div>
                  ))}
                </div>
                <PixelButton variant="secondary" size="md" onClick={pickRepo}>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    <Icon name="plus" /> add a repo
                  </span>
                </PixelButton>
              </>
            )}

            {step === 'auto' && (
              <>
                <p style={{ margin: 0, lineHeight: '22px' }}>
                  Agents in the harness run <strong>unattended</strong>. By default, every
                  agent is spawned with{' '}
                  <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                    --permission-mode bypassPermissions
                  </code>{' '}
                  — meaning claude won't pause to ask you before file edits or shell commands.
                  This is the right default for the "control room" experience; it's also a
                  loaded foot-gun on production repos. Keep this on unless you have a reason
                  to babysit a specific agent.
                </p>
                <label style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: 12,
                  background: autoMode ? 'var(--cth-mint-light)' : 'var(--cth-cream-200)',
                  boxShadow: `inset 0 0 0 2px ${autoMode ? 'var(--cth-mint)' : 'var(--cth-ink-500)'}`,
                  cursor: 'pointer'
                }}>
                  <input
                    type="checkbox"
                    checked={autoMode}
                    onChange={(e) => setAutoMode(e.target.checked)}
                    style={{ width: 18, height: 18 }}
                  />
                  <div>
                    <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px' }}>
                      AUTO MODE
                    </div>
                    <div style={{ fontSize: 14, color: 'var(--cth-ink-700)' }}>
                      {autoMode ? 'Always on. Agents never pause for permission.' : 'Off. Each agent will prompt before running tools.'}
                    </div>
                  </div>
                </label>
                <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
                  You can override this per agent in the Add Agent dialog — change the
                  command string to drop the flag.
                </div>
              </>
            )}

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 14,
                color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            {/* Footer / nav */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
              <Dots step={step} />
              <div style={{ display: 'flex', gap: 8 }}>
                {step !== 'welcome' && (
                  <PixelButton variant="ghost" size="md" onClick={() => setStep(prevStep(step))} disabled={busy}>
                    back
                  </PixelButton>
                )}
                {step !== 'auto' && (
                  <PixelButton variant="primary" size="md" onClick={() => setStep(nextStep(step))}>
                    {step === 'welcome' ? "let's go" : 'next'}
                  </PixelButton>
                )}
                {step === 'auto' && (
                  <PixelButton variant="primary" size="md" onClick={finish} disabled={busy}>
                    {busy ? 'saving...' : 'finish'}
                  </PixelButton>
                )}
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function Dots({ step }: { step: Step }) {
  const order: Step[] = ['welcome', 'home', 'repos', 'auto'];
  return (
    <div style={{ display: 'flex', gap: 4 }}>
      {order.map((s) => (
        <span key={s} style={{
          width: 8, height: 8,
          background: s === step ? 'var(--cth-ink-900)' : 'var(--cth-cream-300)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)'
        }} />
      ))}
    </div>
  );
}

function nextStep(s: Step): Step {
  return s === 'welcome' ? 'home' : s === 'home' ? 'repos' : s === 'repos' ? 'auto' : 'done';
}
function prevStep(s: Step): Step {
  return s === 'auto' ? 'repos' : s === 'repos' ? 'home' : s === 'home' ? 'welcome' : 'welcome';
}

const inputStyle: React.CSSProperties = {
  flex: 1,
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)',
  fontSize: 14,
  color: 'var(--cth-ink-900)',
  outline: 'none'
};

const labelStyle: React.CSSProperties = {
  display: 'block',
  marginBottom: 4,
  fontFamily: 'var(--cth-font-display)',
  fontSize: 9,
  letterSpacing: 0.5,
  color: 'var(--cth-ink-500)'
};
