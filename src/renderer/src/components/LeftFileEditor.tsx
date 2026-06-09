import { useEffect } from 'react';
import { CodeEditor } from './CodeEditor';
import { useStore } from '@/store/store';

/**
 * The file open in the left column (transient `file` tab). The absolute path
 * lives in the store (`openFilePath`); we derive root + rel — preferring the
 * active project root (the files tab roots its tree there), falling back to the
 * file's parent dir so any path still reads. Editable: CodeEditor handles
 * ⌘/Ctrl+S save and renders binary / too-large files as a graceful error.
 */
export function LeftFileEditor({ projectRoot }: { projectRoot?: string | null }) {
  const openFilePath = useStore(s => s.openFilePath);
  const setOpenFile = useStore(s => s.setOpenFile);
  const fullscreenFilePath = useStore(s => s.fullscreenFilePath);

  // Esc closes the file view (restores the previous tab) — but not while the
  // fullscreen file overlay is up, where Esc belongs to it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !fullscreenFilePath) { e.preventDefault(); setOpenFile(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setOpenFile, fullscreenFilePath]);

  if (!openFilePath) return null;

  const underRoot = !!projectRoot
    && (openFilePath === projectRoot || openFilePath.startsWith(projectRoot + '/'));
  const root = underRoot ? projectRoot! : openFilePath.replace(/\/[^/]+$/, '');
  const rel = root === openFilePath ? '' : openFilePath.slice(root.length + 1);

  const copyPath = () => { navigator.clipboard.writeText(openFilePath).catch(() => { /* noop */ }); };

  return (
    <div style={{ height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Path + close bar — the absolute path shown clearly, with a close affordance
          (the transient tab only disappears once the file is closed). */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '4px 8px', flexShrink: 0,
        background: 'var(--cth-cream-100)', borderBottom: '1px solid var(--cth-ink-700)',
        fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-700)'
      }}>
        <span
          title={openFilePath}
          style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        >{openFilePath}</span>
        <button
          onClick={() => setOpenFile(null)}
          title="Close file (Esc)"
          style={{
            flexShrink: 0, padding: '2px 7px', border: 'none', cursor: 'pointer',
            background: 'var(--cth-cream-200)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
          }}
        >close</button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <CodeEditor root={root} filePath={rel} onCopyPath={copyPath} />
      </div>
    </div>
  );
}
