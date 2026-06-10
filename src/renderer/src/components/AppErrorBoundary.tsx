import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Top-level React error boundary. Without one, a throw during render anywhere in
 * the tree (a malformed agent record, a bad markdown string, a null deref) blanks
 * the entire window with no way back. This catches it and offers a Reload instead —
 * the main process and all persisted state are untouched, so reloading recovers.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[renderer] uncaught render error:', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div style={{
        position: 'fixed', inset: 0, display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center', gap: 16, padding: 32,
        background: 'var(--cth-cream-100, #FFF8E7)', color: 'var(--cth-ink-900, #1a1a1a)',
        fontFamily: 'var(--cth-font-sans, system-ui)', textAlign: 'center'
      }}>
        <div style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong</div>
        <div style={{ maxWidth: 480, opacity: 0.75, fontSize: 13, lineHeight: 1.5 }}>
          The interface hit an unexpected error and stopped rendering. Your agents and
          project data are safe — reloading the window should recover.
        </div>
        <pre style={{
          maxWidth: 520, maxHeight: 160, overflow: 'auto', textAlign: 'left', fontSize: 11,
          padding: '8px 12px', borderRadius: 6, background: 'var(--cth-cream-200, #f3e9cf)',
          color: 'var(--cth-ink-700, #444)', whiteSpace: 'pre-wrap'
        }}>{error.message}</pre>
        <button
          onClick={() => window.location.reload()}
          style={{
            padding: '8px 20px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
            border: '2px solid var(--cth-ink-900, #1a1a1a)', borderRadius: 6,
            background: 'var(--cth-ink-900, #1a1a1a)', color: 'var(--cth-cream-50, #fffef9)'
          }}
        >Reload</button>
      </div>
    );
  }
}
