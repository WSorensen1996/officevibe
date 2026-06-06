import React from 'react';

/** The app's styled dropdown (pixel inset look). Shared by the command-center
 *  sections and the Agents tab's per-agent model picker. Pass `style` to let the
 *  caller size it inside a flex row (e.g. `flex:1, minWidth:0` to stay in bounds). */
export function Select({ value, onChange, disabled, children, style }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; children: React.ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: '3px 6px', background: 'var(--cth-paper-100)',
        border: 'none', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
        fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)', cursor: 'pointer',
        ...style
      }}
    >{children}</select>
  );
}
