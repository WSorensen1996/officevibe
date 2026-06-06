import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Icon } from './Icon';
import type { HarnessConfig } from '@/store/config';

export interface NewProjectModalProps {
  onClose: () => void;
  config: HarnessConfig;
}

/** Slug used for the on-disk folder name, mirrors main's projectFolderName(). */
function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

function parentOf(path: string): string {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return (path.startsWith('/') ? '/' : '') + parts.join('/');
}

/** Create a new project (folder `officevibe-<slug>` under a parent dir). On
 *  success the main process relaunches the app, so this modal effectively never
 *  returns — the app reloads into the new project. */
export function NewProjectModal({ onClose, config }: NewProjectModalProps) {
  const defaultParent = config.harnessHome
    ?? (config.activeProjectPath ? parentOf(config.activeProjectPath) : '');
  const [name, setName] = useState('');
  const [parentDir, setParentDir] = useState<string>(defaultParent);
  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);

  const folderPreview = `officevibe-${slugify(name || 'project')}`;

  const pickParent = async () => {
    setError(undefined);
    const res = await window.cth.chooseFolder();
    if (res.ok) setParentDir(res.path);
    else if (res.error !== 'cancelled') setError(res.error);
  };

  const submit = async () => {
    setError(undefined);
    if (!name.trim()) { setError('Name your project first.'); return; }
    if (!parentDir) { setError('Pick a folder to create the project in.'); return; }
    setBusy(true);
    const res = await window.cth.projectCreate(name.trim(), parentDir);
    // On success the app relaunches (process exits) — we only return here on error.
    if (res && !res.ok) { setError(res.error ?? 'could not create the project'); setBusy(false); }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 150
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 540, maxWidth: '92vw' }}>
        <PixelPanel variant="dialog" title="NEW PROJECT" style={{ padding: 16 }} noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 16 }}>
            <p style={{ margin: 0, fontSize: 14, lineHeight: '20px', color: 'var(--cth-ink-700)' }}>
              A project is its own folder holding a team's roster, tasks, board, and memory.
              The app will reload into the new project.
            </p>

            <div>
              <label style={labelStyle}>PROJECT NAME</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
                placeholder="Acme"
                autoFocus
                style={{ ...inputStyle, width: '100%' }}
              />
            </div>

            <div>
              <label style={labelStyle}>CREATE IN (parent folder)</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={parentDir}
                  onChange={(e) => setParentDir(e.target.value)}
                  placeholder="/path/to/OfficeVibe"
                  style={inputStyle}
                />
                <PixelButton variant="secondary" size="md" onClick={pickParent}>
                  <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
                    <Icon name="folder" /> pick
                  </span>
                </PixelButton>
              </div>
            </div>

            <div style={{ fontSize: 13, color: 'var(--cth-ink-500)' }}>
              Creates{' '}
              <code style={{ fontFamily: 'var(--cth-font-mono)', background: 'var(--cth-paper-100)', padding: '0 4px' }}>
                {parentDir || '…'}/{folderPreview}
              </code>
            </div>

            {error && (
              <div style={{
                padding: '6px 10px',
                background: 'var(--cth-coral-light)',
                boxShadow: 'inset 0 0 0 1px var(--cth-coral)',
                fontSize: 14, color: 'var(--cth-ink-900)'
              }}>{error}</div>
            )}

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>cancel</PixelButton>
              <PixelButton variant="primary" size="md" onClick={submit} disabled={busy}>
                {busy ? 'creating…' : 'create project'}
              </PixelButton>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
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
