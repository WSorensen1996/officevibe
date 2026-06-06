import { useCallback, useEffect, useState } from 'react';
import { PixelButton } from './PixelButton';
import { PixelBadge } from './PixelBadge';
import { Icon } from './Icon';
import { Scroll, Section, Muted } from './CommandCenterPanel';
import { AddMcpServerModal } from './AddMcpServerModal';
import { useAgentRestart } from '@/hooks/useAgentRestart';
import { useStore } from '@/store/store';
import type { McpServerDef } from '@/store/config';

type TestState = { status: 'testing' } | { status: 'ok'; tools: string[] } | { status: 'err'; error: string };

/** Command-center tab to add/manage MCP servers wired into the spawned agents.
 *  Servers are persisted on the app config (secrets encrypted at rest) and merged
 *  into each agent's mcp.json on its next start — see src/main/mcp.ts. */
export function McpTab() {
  const [servers, setServers] = useState<McpServerDef[]>([]);
  const [encAvailable, setEncAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  // undefined = modal closed; null = add new; a def = edit that server.
  const [editing, setEditing] = useState<McpServerDef | null | undefined>(undefined);
  const [tests, setTests] = useState<Record<string, TestState>>({});
  const [restartingAll, setRestartingAll] = useState(false);

  const agents = useStore((s) => s.agents);
  const { restartWithModel } = useAgentRestart();

  const load = useCallback(async () => {
    try {
      const r = await window.cth.mcpList();
      setServers(r.servers);
      setEncAvailable(r.encryptionAvailable);
    } catch { /* noop */ } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (s: McpServerDef, on: boolean) => {
    setServers((prev) => prev.map((x) => (x.id === s.id ? { ...x, enabled: on } : x))); // optimistic
    const res = await window.cth.mcpSave({ ...s, enabled: on });
    if (res.ok && res.servers) setServers(res.servers); else load();
  };

  const remove = async (s: McpServerDef) => {
    const res = await window.cth.mcpRemove(s.id);
    if (res.ok && res.servers) setServers(res.servers); else load();
  };

  const test = async (s: McpServerDef) => {
    setTests((prev) => ({ ...prev, [s.id]: { status: 'testing' } }));
    try {
      const r = await window.cth.mcpTest(s);
      setTests((prev) => ({ ...prev, [s.id]: r.ok ? { status: 'ok', tools: r.tools ?? [] } : { status: 'err', error: r.error ?? 'failed' } }));
    } catch (e) {
      setTests((prev) => ({ ...prev, [s.id]: { status: 'err', error: e instanceof Error ? e.message : String(e) } }));
    }
  };

  const restartAll = async () => {
    setRestartingAll(true);
    try {
      for (const a of agents) if (a.ptyId) await restartWithModel(a, a.model);
    } finally {
      setRestartingAll(false);
    }
  };

  return (
    <Scroll>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div style={{ fontSize: 13, color: 'var(--cth-ink-700)' }}>
          Connect your agents to other apps over MCP.
        </div>
        <PixelButton variant="primary" size="sm" onClick={() => setEditing(null)}>
          <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="plus" /> add server</span>
        </PixelButton>
      </div>

      {!encAvailable && (
        <div style={{ padding: '6px 10px', marginBottom: 10, fontSize: 12, color: 'var(--cth-ink-900)', background: 'var(--cth-lemon-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)' }}>
          Secret encryption is unavailable on this machine (no OS keyring). Credentials are stored in plaintext in the app config.
        </div>
      )}

      {agents.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', marginBottom: 12, fontSize: 12, color: 'var(--cth-ink-700)', background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)' }}>
          <span style={{ flex: 1 }}>Changes apply the next time an agent starts.</span>
          <PixelButton variant="secondary" size="sm" onClick={restartAll} disabled={restartingAll}>
            {restartingAll ? 'restarting…' : 'restart agents'}
          </PixelButton>
        </div>
      )}

      <Section title="CONFIGURED SERVERS">
        {loading && <Muted>Loading…</Muted>}
        {!loading && servers.length === 0 && <Muted>No MCP servers yet. Add one to give your agents new tools.</Muted>}
        {servers.map((s) => (
          <ServerRow
            key={s.id}
            server={s}
            test={tests[s.id]}
            onToggle={(on) => toggle(s, on)}
            onTest={() => test(s)}
            onEdit={() => setEditing(s)}
            onRemove={() => remove(s)}
          />
        ))}
      </Section>

      {editing !== undefined && (
        <AddMcpServerModal
          initial={editing ?? undefined}
          onClose={() => setEditing(undefined)}
          onSaved={(next) => setServers(next)}
        />
      )}
    </Scroll>
  );
}

function ServerRow({ server, test, onToggle, onTest, onEdit, onRemove }: {
  server: McpServerDef;
  test?: TestState;
  onToggle: (on: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const [confirmDel, setConfirmDel] = useState(false);
  const target = server.transport === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : server.url;

  return (
    <div style={{ padding: 8, marginBottom: 8, background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', opacity: server.enabled ? 1 : 0.6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 14, color: 'var(--cth-ink-900)', fontWeight: 600 }}>{server.name}</span>
        <Chip>{server.transport}</Chip>
        <Chip>{server.scope === 'god' ? 'Michael' : 'all agents'}</Chip>
        <span style={{ flex: 1 }} />
        {test?.status === 'testing' && <PixelBadge status="working" label="testing…" />}
        {test?.status === 'ok' && <PixelBadge status="success" label={`${test.tools.length} tool${test.tools.length === 1 ? '' : 's'}`} />}
        {test?.status === 'err' && <PixelBadge status="blocked" label="error" />}
        <label style={{ display: 'inline-flex', gap: 4, alignItems: 'center', cursor: 'pointer', fontSize: 12, color: 'var(--cth-ink-700)' }}>
          <input type="checkbox" checked={server.enabled} onChange={(e) => onToggle(e.target.checked)} style={{ width: 15, height: 15, cursor: 'pointer' }} />
          on
        </label>
      </div>

      <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={target}>
        {target || '—'}
      </div>

      {test?.status === 'err' && (
        <div style={{ fontSize: 11, color: 'var(--cth-coral)', marginTop: 4, wordBreak: 'break-word' }}>{test.error}</div>
      )}
      {test?.status === 'ok' && test.tools.length > 0 && (
        <div style={{ fontSize: 11, color: 'var(--cth-ink-500)', marginTop: 4, wordBreak: 'break-word' }}>{test.tools.slice(0, 12).join(', ')}{test.tools.length > 12 ? '…' : ''}</div>
      )}

      <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <PixelButton variant="secondary" size="sm" onClick={onTest}>test</PixelButton>
        <PixelButton variant="secondary" size="sm" onClick={onEdit}>edit</PixelButton>
        <span style={{ flex: 1 }} />
        {confirmDel ? (
          <>
            <PixelButton variant="ghost" size="sm" onClick={() => setConfirmDel(false)}>cancel</PixelButton>
            <PixelButton variant="destructive" size="sm" onClick={onRemove}>delete?</PixelButton>
          </>
        ) : (
          <PixelButton variant="ghost" size="sm" onClick={() => setConfirmDel(true)}>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="x" /> remove</span>
          </PixelButton>
        )}
      </div>
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px', padding: '1px 5px 0',
      background: 'var(--cth-sky-light)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
      color: 'var(--cth-ink-900)', textTransform: 'uppercase'
    }}>{children}</span>
  );
}
