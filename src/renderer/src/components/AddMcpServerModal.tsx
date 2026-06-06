import { useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { Select } from './Select';
import { Icon } from './Icon';
import type { McpServerDef } from '@/store/config';

type Transport = McpServerDef['transport'];
type Scope = McpServerDef['scope'];
interface Pair { key: string; value: string }

export interface AddMcpServerModalProps {
  /** Editing an existing server, or undefined to add a new one. */
  initial?: McpServerDef;
  onClose: () => void;
  /** Called with the refreshed (decrypted) server list after a successful save. */
  onSaved: (servers: McpServerDef[]) => void;
}

function pairsFromRecord(rec?: Record<string, string>): Pair[] {
  return Object.entries(rec ?? {}).map(([key, value]) => ({ key, value }));
}
function recordFromPairs(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const p of pairs) if (p.key.trim()) out[p.key.trim()] = p.value;
  return Object.keys(out).length > 0 ? out : undefined;
}

export function AddMcpServerModal({ initial, onClose, onSaved }: AddMcpServerModalProps) {
  const [name, setName] = useState(initial?.name ?? '');
  const [transport, setTransport] = useState<Transport>(initial?.transport ?? 'stdio');
  const [scope, setScope] = useState<Scope>(initial?.scope ?? 'all');
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  // stdio
  const [command, setCommand] = useState(initial?.command ?? '');
  const [argsText, setArgsText] = useState((initial?.args ?? []).join('\n'));
  const [envPairs, setEnvPairs] = useState<Pair[]>(pairsFromRecord(initial?.env));
  // http / sse
  const [url, setUrl] = useState(initial?.url ?? '');
  const [headerPairs, setHeaderPairs] = useState<Pair[]>(pairsFromRecord(initial?.headers));

  const [error, setError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; tools?: string[]; error?: string } | null>(null);

  const buildDef = (): McpServerDef => ({
    id: initial?.id ?? '', // main assigns a fresh id when empty
    name: name.trim(),
    enabled,
    scope,
    transport,
    ...(transport === 'stdio'
      ? {
          command: command.trim(),
          args: argsText.split('\n').map((a) => a.trim()).filter(Boolean),
          env: recordFromPairs(envPairs)
        }
      : { url: url.trim(), headers: recordFromPairs(headerPairs) })
  });

  const test = async () => {
    setError(undefined);
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await window.cth.mcpTest(buildDef()));
    } catch (e) {
      setTestResult({ ok: false, error: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    setError(undefined);
    if (!name.trim()) { setError('Name is required'); return; }
    if (transport === 'stdio' && !command.trim()) { setError('Command is required for a local server'); return; }
    if (transport !== 'stdio' && !url.trim()) { setError('URL is required for a remote server'); return; }
    setBusy(true);
    try {
      const res = await window.cth.mcpSave(buildDef());
      if (!res.ok) { setError(res.error ?? 'save failed'); return; }
      onSaved(res.servers ?? []);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(26, 19, 32, 0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100
      }}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', maxHeight: '90vh', overflowY: 'auto' }}>
        <PixelPanel variant="dialog" title={initial ? 'EDIT MCP SERVER' : 'ADD MCP SERVER'} style={{ padding: 16 }} noPadding>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: 16 }}>
            <Row label="Name (the key agents see, e.g. github)">
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
            </Row>

            <div style={{ display: 'flex', gap: 12 }}>
              <Row label="Type">
                <Select value={transport} onChange={(v) => setTransport(v as Transport)}>
                  <option value="stdio">local (stdio)</option>
                  <option value="http">remote (http)</option>
                  <option value="sse">remote (sse)</option>
                </Select>
              </Row>
              <Row label="Give to">
                <Select value={scope} onChange={(v) => setScope(v as Scope)}>
                  <option value="all">all agents</option>
                  <option value="god">Michael only</option>
                </Select>
              </Row>
            </div>

            {transport === 'stdio' ? (
              <>
                <Row label="Command">
                  <input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
                </Row>
                <Row label="Arguments (one per line)">
                  <textarea
                    value={argsText}
                    onChange={(e) => setArgsText(e.target.value)}
                    placeholder={'-y\n@modelcontextprotocol/server-github'}
                    rows={3}
                    style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)', resize: 'vertical' }}
                  />
                </Row>
                <KeyValueEditor label="Environment variables (values stored encrypted)" pairs={envPairs} setPairs={setEnvPairs} keyPlaceholder="GITHUB_TOKEN" />
              </>
            ) : (
              <>
                <Row label="URL">
                  <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/sse" style={{ ...inputStyle, fontFamily: 'var(--cth-font-mono)' }} />
                </Row>
                <KeyValueEditor label="Headers (values stored encrypted)" pairs={headerPairs} setPairs={setHeaderPairs} keyPlaceholder="Authorization" />
              </>
            )}

            <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer' }}>
              <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
              <span style={{ fontFamily: 'var(--cth-font-ui)', fontSize: 14, color: 'var(--cth-ink-900)' }}>Enabled (wired into agents on their next start)</span>
            </label>

            {testResult && (
              <div style={{
                padding: '6px 10px', fontSize: 13, color: 'var(--cth-ink-900)',
                background: testResult.ok ? 'var(--cth-mint-light)' : 'var(--cth-coral-light)',
                boxShadow: `inset 0 0 0 1px ${testResult.ok ? 'var(--cth-mint)' : 'var(--cth-coral)'}`
              }}>
                {testResult.ok
                  ? `Connected — ${testResult.tools?.length ?? 0} tool(s)${testResult.tools?.length ? ': ' + testResult.tools.slice(0, 12).join(', ') : ''}`
                  : `Connection failed: ${testResult.error}`}
              </div>
            )}

            {error && (
              <div style={{ padding: '6px 10px', background: 'var(--cth-coral-light)', boxShadow: 'inset 0 0 0 1px var(--cth-coral)', fontSize: 14, color: 'var(--cth-ink-900)' }}>
                {error}
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, justifyContent: 'space-between', marginTop: 4 }}>
              <PixelButton variant="secondary" size="md" onClick={test} disabled={testing || busy}>
                {testing ? 'testing…' : 'test connection'}
              </PixelButton>
              <div style={{ display: 'flex', gap: 8 }}>
                <PixelButton variant="ghost" size="md" onClick={onClose} disabled={busy}>cancel</PixelButton>
                <PixelButton variant="primary" size="md" onClick={save} disabled={busy}>
                  {busy ? 'saving…' : 'save'}
                </PixelButton>
              </div>
            </div>
          </div>
        </PixelPanel>
      </div>
    </div>
  );
}

function KeyValueEditor({ label, pairs, setPairs, keyPlaceholder }: {
  label: string; pairs: Pair[]; setPairs: (p: Pair[]) => void; keyPlaceholder: string;
}) {
  const update = (i: number, patch: Partial<Pair>) => setPairs(pairs.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  return (
    <Row label={label}>
      {pairs.map((p, i) => (
        <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <input value={p.key} onChange={(e) => update(i, { key: e.target.value })} placeholder={keyPlaceholder} style={{ ...inputStyle, flex: 1, fontFamily: 'var(--cth-font-mono)', fontSize: 13 }} />
          <input type="password" value={p.value} onChange={(e) => update(i, { value: e.target.value })} placeholder="value" style={{ ...inputStyle, flex: 1.3, fontSize: 13 }} />
          <PixelButton variant="ghost" size="sm" onClick={() => setPairs(pairs.filter((_, j) => j !== i))}>
            <Icon name="x" />
          </PixelButton>
        </div>
      ))}
      <PixelButton variant="secondary" size="sm" onClick={() => setPairs([...pairs, { key: '', value: '' }])}>
        <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="plus" /> add</span>
      </PixelButton>
    </Row>
  );
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '6px 8px 4px',
  background: 'var(--cth-paper-100)',
  border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-ui)',
  fontSize: 15,
  color: 'var(--cth-ink-900)',
  outline: 'none',
  boxSizing: 'border-box'
};

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 8, lineHeight: '12px', color: 'var(--cth-ink-700)', textTransform: 'uppercase' }}>{label}</span>
      {children}
    </label>
  );
}
