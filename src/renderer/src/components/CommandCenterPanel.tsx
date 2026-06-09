import { useEffect, useState } from 'react';
import { PixelPanel } from './PixelPanel';
import { PixelButton } from './PixelButton';
import { TasksKanban } from './TasksKanban';
import { AgentsTab } from './AgentsTab';
import { McpTab } from './McpTab';
import { SkillsTab } from './SkillsTab';
import { SettingsTab } from './SettingsTab';
import { FileTree } from './FileTree';
import { UsageMeter } from './UsageMeter';
import { Select } from './Select';
import { Icon } from './Icon';
import { useStore, type Agent } from '@/store/store';

/** Michael's control surface — the always-on overview pinned to the right column.
 *  His terminal lives on the LEFT (the AgentWorkspace, like every other agent);
 *  here we surface a task board that dispatches & schedules work, the agent
 *  roster, a memory view, skills, a command handbook, and connections. */

type CCTab = 'tasks' | 'agents' | 'memory' | 'skills' | 'handbook' | 'connections' | 'files' | 'settings';

const TABS: { key: CCTab; label: string; icon: Parameters<typeof Icon>[0]['name'] }[] = [
  { key: 'tasks', label: 'tasks', icon: 'check' },
  { key: 'agents', label: 'agents', icon: 'mcp' },
  { key: 'memory', label: 'memory', icon: 'sparkle' },
  { key: 'skills', label: 'skills', icon: 'book' },
  { key: 'handbook', label: 'commands', icon: 'code' },
  { key: 'connections', label: 'connections', icon: 'web' },
  // `files` sits just before settings so adding it shifts only settings' number key.
  { key: 'files', label: 'files', icon: 'folder' },
  { key: 'settings', label: 'settings', icon: 'gear' }
];

export function CommandCenterPanel({ agent }: { agent: Agent }) {
  const [tab, setTab] = useState<CCTab>('tasks');

  // Number-key shortcuts: 1..N jump straight to the matching tab (tasks=1,
  // agents=2, …). Ignored when a modifier is held or focus is in a text field /
  // terminal, so typing a digit into an input/textarea/select passes through.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el?.isContentEditable) return;
      if (e.key >= '1' && e.key <= '9') {
        const idx = Number(e.key) - 1;
        if (idx < TABS.length) {
          e.preventDefault();
          setTab(TABS[idx].key);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <PixelPanel
      variant="default"
      noPadding
      style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 0, overflow: 'hidden' }}
    >
      {/* Header — doubles as a window-drag region (the OS title bar is gone). */}
      <div className="cth-titlebar-drag" style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '6px 8px', background: 'var(--cth-cream-100)',
        borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        {/* Title text removed — the agent cards in the full-width top bar carry
            identity now; this spacer keeps the usage meter pushed to the right. */}
        <div style={{ flex: 1, minWidth: 0 }} />
        {/* Claude usage: current session (5h) + weekly (7d). Relocated here from
            the removed title bar. */}
        <UsageMeter />
      </div>

      {/* Tab bar */}
      <div style={{
        display: 'flex', gap: 4, padding: '6px 8px 0',
        background: 'var(--cth-cream-100)', borderBottom: '1px solid var(--cth-ink-700)', flexShrink: 0
      }}>
        {TABS.map((t, i) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            title={i < 9 ? `${t.label} — press ${i + 1}` : t.label}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              padding: '4px 9px 3px', border: 'none', cursor: 'pointer',
              background: tab === t.key ? `var(--cth-${agent.accent})` : 'var(--cth-cream-200)',
              color: 'var(--cth-ink-900)',
              boxShadow: tab === t.key
                ? 'inset 0 0 0 1px var(--cth-ink-900)'
                : 'inset 0 0 0 1px var(--cth-ink-700)',
              fontFamily: 'var(--cth-font-ui)', fontSize: 13
            }}
          >
            {i < 9 && (
              <span style={{ fontSize: 10, opacity: 0.55, fontFamily: 'var(--cth-font-display)' }}>{i + 1}</span>
            )}
            <Icon name={t.icon} /> {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {tab === 'tasks' && <TasksKanban />}
        {tab === 'memory' && <MemoryTab godId={agent.id} />}
        {tab === 'skills' && <SkillsTab />}
        {tab === 'handbook' && <HandbookTab />}
        {tab === 'agents' && <AgentsTab />}
        {tab === 'connections' && <McpTab />}
        {tab === 'files' && <ProjectFilesTab cwd={agent.cwd} />}
        {tab === 'settings' && <SettingsTab />}
      </div>
    </PixelPanel>
  );
}

// ─── Files tab ───────────────────────────────────────────────────────────────

/** Project file browser. Defaults to a FOCUSED view of just `workspace/` — the
 *  user-facing folder where agents place artifacts they make for the human (plans,
 *  visualizations, generated docs) — so the project's config/scaffolding (agents/,
 *  knowledge/, *.json, …) stays out of sight. A "Show all files" toggle reveals the
 *  full project tree. Clicking a file opens it in the LEFT pane (the transient
 *  `file` tab), not fullscreen. (task t-mq6yp0yo-6zpp) */
function ProjectFilesTab({ cwd }: { cwd: string }) {
  const setOpenFile = useStore((s) => s.setOpenFile);
  const openFilePath = useStore((s) => s.openFilePath);
  const [showAll, setShowAll] = useState(false);
  // Focused = the workspace/ subfolder; full = the project root. `workspace/` is
  // scaffolded on project create + ensured on every load, so it's always present.
  const root = showAll ? cwd : `${cwd}/workspace`;
  // Highlight the open file in the tree when it's within the CURRENT root.
  const activeRel = openFilePath && (openFilePath === root || openFilePath.startsWith(root + '/'))
    ? openFilePath.slice(root.length + 1)
    : undefined;
  const copyPath = (rel: string) => {
    const abs = rel ? `${root}/${rel}` : root;
    navigator.clipboard.writeText(abs).catch(() => { /* noop */ });
  };
  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--cth-paper-200)' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '5px 8px', flexShrink: 0,
        borderBottom: '1px solid var(--cth-ink-300)'
      }}>
        <span style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, color: 'var(--cth-ink-500)' }}>
          {showAll ? 'ALL PROJECT FILES' : 'WORKSPACE · your content'}
        </span>
        <button
          onClick={() => setShowAll((v) => !v)}
          title={showAll ? 'Show only the workspace folder' : 'Show the full project tree (config + scaffolding)'}
          style={{
            marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 3,
            padding: '1px 6px 0', border: 'none', cursor: 'pointer',
            background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-display)', fontSize: 8, textTransform: 'uppercase',
            color: 'var(--cth-ink-900)'
          }}
        >{showAll ? 'focus workspace' : 'show all files'}</button>
      </div>
      <FileTree
        key={root}
        root={root}
        activeRel={activeRel}
        emptyHint={showAll ? undefined : 'Agent-created plans, visualizations and docs appear here.'}
        onOpenFile={(rel) => setOpenFile(`${root}/${rel}`)}
        onCopyPath={copyPath}
      />
    </div>
  );
}

// ─── Memory tab ──────────────────────────────────────────────────────────────

type ModelId = 'minilm' | 'embeddinggemma';

interface MemoryStatus {
  available: boolean;
  enabled: boolean;
  active: boolean;
  initialized: boolean;
  palacePath: string | null;
  model: ModelId;
  bin: string | null;
}

// Plain-language framing of each embedding model — lead with the benefit the user
// actually chooses between, not the model's codename.
const MEMORY_MODELS: { id: ModelId; title: string; detail: string }[] = [
  { id: 'minilm',         title: 'Fast',         detail: 'English only · ~90 MB' },
  { id: 'embeddinggemma', title: 'Multilingual', detail: 'all languages · ~300 MB' },
];

function MemoryTab({ godId }: { godId: string }) {
  const agents = useStore((s) => s.agents);
  const [who, setWho] = useState<string>(godId);
  const [mem, setMem] = useState('');
  const [query, setQuery] = useState('');
  const [searchOut, setSearchOut] = useState('');
  const [busy, setBusy] = useState(false);
  // Full-text search across project files (board, tasks, memory) — additive.
  const [textQuery, setTextQuery] = useState('');
  const [textResults, setTextResults] = useState<Array<{ source: string; excerpt: string }>>([]);
  const [textSearched, setTextSearched] = useState(false);
  const [textBusy, setTextBusy] = useState(false);
  // Semantic-memory engine status + controls (on/off, model). This is app-wide
  // config, NOT per-agent — so it's independent of `who`/`godId`.
  const [status, setStatus] = useState<MemoryStatus | null>(null);

  useEffect(() => {
    window.cth.projectMemory(who).then(setMem).catch(() => setMem(''));
  }, [who]);

  const refreshStatus = async () => {
    try { setStatus(await window.cth.memoryStatus()); } catch { /* ignore */ }
  };
  useEffect(() => { refreshStatus(); }, []);

  const setModel = async (model: ModelId) => {
    await window.cth.updateConfig({ embeddingModel: model });
    await refreshStatus();
  };
  const toggleEnabled = async () => {
    await window.cth.updateConfig({ semanticMemory: !(status?.enabled ?? true) });
    await refreshStatus();
  };

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    try {
      const res = await window.cth.searchMemory(query.trim());
      setSearchOut(res.ok ? (res.output || 'Nothing matched yet.') : `Couldn't search: ${res.error}`);
    } finally { setBusy(false); }
  };

  const textSearch = async () => {
    if (!textQuery.trim()) return;
    setTextBusy(true);
    try {
      const res = await window.cth.textSearch(textQuery.trim());
      setTextResults(res.ok ? res.results.slice(0, 10) : []);
    } catch { setTextResults([]); }
    finally { setTextBusy(false); setTextSearched(true); }
  };

  // One clear state line: is memory working, off, or not set up?
  const state: { dot: string; label: string } = !status?.available
    ? { dot: 'var(--cth-coral)', label: 'Not set up' }
    : !status.enabled
      ? { dot: 'var(--cth-ink-500)', label: 'Off' }
      : status.initialized
        ? { dot: 'var(--cth-mint)', label: 'On · ready' }
        : { dot: 'var(--cth-lemon)', label: 'On · getting ready…' };

  const canSearch = !!status?.available && !!status?.enabled;

  return (
    // Full-height flex column: the search/control sections keep their natural
    // height while the MEMORY FILE viewer (below) grows to fill the leftover
    // space instead of staying a small fixed-height window.
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', padding: 10, background: 'var(--cth-paper-200)', overflow: 'hidden' }}>
      <Section title="TEXT SEARCH (board, tasks, memory)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={textQuery}
            onChange={(e) => setTextQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') textSearch(); }}
            placeholder="Find exact text across project files…"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={textSearch} disabled={textBusy || !textQuery.trim()}>
            {textBusy ? '…' : 'search'}
          </PixelButton>
        </div>
        {textResults.length > 0 && (
          <div style={{ marginTop: 6 }}>
            {textResults.map((r, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                <div style={{ fontFamily: 'var(--cth-font-mono)', fontSize: 11, color: 'var(--cth-ink-500)' }}>{r.source}</div>
                <Pre>{r.excerpt}</Pre>
              </div>
            ))}
          </div>
        )}
        {textSearched && textResults.length === 0 && <Muted>Nothing matched.</Muted>}
      </Section>

      <Section title="SEMANTIC MEMORY">
        {/* Status + on/off — the two things the user controls at a glance. */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 8 }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7, fontSize: 13, color: 'var(--cth-ink-900)', fontFamily: 'var(--cth-font-ui)' }}>
            <span style={{ width: 9, height: 9, background: state.dot, boxShadow: 'inset 0 0 0 1px var(--cth-ink-900)' }} />
            {state.label}
          </span>
          {status?.available && (
            <PixelButton
              variant={status.enabled ? 'secondary' : 'primary'}
              size="sm"
              onClick={toggleEnabled}
            >
              {status.enabled ? 'Turn off' : 'Turn on'}
            </PixelButton>
          )}
        </div>

        {/* Not installed: tell the user how to enable it, nothing else. */}
        {!status?.available && (
          <div style={{
            fontSize: 12, color: 'var(--cth-ink-700)', lineHeight: 1.6,
            background: 'var(--cth-cream-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)', padding: 10
          }}>
            Meaning-based search isn’t installed yet. Enable it with:
            <div style={{ marginTop: 6 }}>
              <code style={{
                fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)',
                background: 'var(--cth-paper-100)', padding: '2px 6px', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
              }}>uv tool install mempalace</code>
            </div>
            <div style={{ marginTop: 8, color: 'var(--cth-ink-500)' }}>
              Agents still keep plain notes without it.
            </div>
          </div>
        )}

        {/* Model: a benefit-framed choice, not a codename dump. */}
        {status?.available && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ fontSize: 11, color: 'var(--cth-ink-500)', fontFamily: 'var(--cth-font-display)', textTransform: 'uppercase', letterSpacing: 0.5 }}>
              Search language
            </span>
            <div style={{ display: 'flex', gap: 8 }}>
              {MEMORY_MODELS.map((m) => {
                const sel = status.model === m.id;
                return (
                  <button
                    key={m.id}
                    onClick={() => setModel(m.id)}
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
        )}
      </Section>

      <Section title="SEMANTIC SEARCH (MemPalace)">
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') search(); }}
            placeholder="What does the project know about…"
            style={{ ...textareaStyle, height: 30 }}
          />
          <PixelButton variant="primary" size="sm" onClick={search} disabled={busy || !query.trim() || !canSearch}>
            {busy ? '…' : 'search'}
          </PixelButton>
        </div>
        {!canSearch && <Muted>Turn semantic memory on to search by meaning.</Muted>}
        {searchOut && <Pre>{searchOut}</Pre>}
      </Section>

      {/* MEMORY FILE — flex:1 so it claims all remaining vertical space; the
          viewer fills the area and scrolls internally on long memory files. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>MEMORY FILE</div>
        <Select value={who} onChange={setWho}>
          {agents.map((a) => (<option key={a.id} value={a.id}>{a.name}</option>))}
        </Select>
        <div style={{ flex: 1, minHeight: 0 }}>
          <Pre maxHeight="100%">{mem || 'No memory recorded yet.'}</Pre>
        </div>
      </div>
    </div>
  );
}

// ─── Handbook tab — copyable Claude command reference ────────────────────────

interface Cmd { cmd: string; kind: 'slash' | 'cli'; desc: string; usage?: string }
interface CmdGroup { title: string; items: Cmd[] }

const HANDBOOK: CmdGroup[] = [
  {
    title: 'SESSION',
    items: [
      { cmd: '/clear', kind: 'slash', desc: 'Wipe the conversation and reclaim the full context window. Start fresh.' },
      { cmd: '/compact', kind: 'slash', desc: 'Summarize the conversation so far to free up context without losing the thread.', usage: '/compact focus on the auth refactor' },
      { cmd: '/cost', kind: 'slash', desc: 'Show token usage and dollar cost for the current session.' },
      { cmd: '/status', kind: 'slash', desc: 'Show account, active model, and connection status.' },
      { cmd: 'claude -c', kind: 'cli', desc: 'Continue the most recent session in this directory.' },
      { cmd: 'claude -r', kind: 'cli', desc: 'Resume — pick a past session to continue.' }
    ]
  },
  {
    title: 'MODELS',
    items: [
      { cmd: '/model', kind: 'slash', desc: 'Switch the model for this session.', usage: '/model opus   ·   /model sonnet' },
      { cmd: 'claude --model claude-sonnet-4-6[1m]', kind: 'cli', desc: 'Launch on a specific model. The [1m] suffix selects the 1M-token context window (used by Dwight).' }
    ]
  },
  {
    title: 'CONTEXT & MEMORY',
    items: [
      { cmd: '/init', kind: 'slash', desc: 'Scan the repo and generate a CLAUDE.md capturing its conventions.' },
      { cmd: '/memory', kind: 'slash', desc: 'Open the project & user memory files for editing.' },
      { cmd: '# ', kind: 'slash', desc: 'Quick memory: start a message with # to append a durable note to memory.', usage: '# always run prettier before committing' },
      { cmd: 'claude --add-dir ../other-repo', kind: 'cli', desc: 'Grant the session read/write access to an extra directory.' }
    ]
  },
  {
    title: 'TOOLS & PERMISSIONS',
    items: [
      { cmd: '/permissions', kind: 'slash', desc: 'View and edit which tools are allowed or denied.' },
      { cmd: '/hooks', kind: 'slash', desc: 'Configure lifecycle hooks (PreToolUse, Stop, etc.).' },
      { cmd: 'claude --permission-mode bypassPermissions', kind: 'cli', desc: 'Run without per-tool approval prompts (this is what "auto mode" uses).' }
    ]
  },
  {
    title: 'MCP',
    items: [
      { cmd: '/mcp', kind: 'slash', desc: 'List/manage connected MCP servers and authenticate.' },
      { cmd: 'claude mcp list', kind: 'cli', desc: 'List configured MCP servers.' },
      { cmd: 'claude mcp add <name> <command>', kind: 'cli', desc: 'Register a new MCP server.' }
    ]
  },
  {
    title: 'AUTOMATION (HEADLESS)',
    items: [
      { cmd: 'claude -p "your prompt"', kind: 'cli', desc: 'Print mode: run one prompt non-interactively and exit.' },
      { cmd: 'claude -p "your prompt" --output-format json', kind: 'cli', desc: 'Headless with structured JSON output (result, usage, cost).' },
      { cmd: 'claude -c -p "follow-up"', kind: 'cli', desc: 'Continue the last session headlessly with a follow-up prompt.' }
    ]
  },
  {
    title: 'REVIEW · GIT · AGENTS',
    items: [
      { cmd: '/review', kind: 'slash', desc: 'Review the current diff / PR for issues.' },
      { cmd: '/pr-comments', kind: 'slash', desc: 'Fetch and work through PR review comments.' },
      { cmd: '/agents', kind: 'slash', desc: 'Create and manage subagents for delegated work.' }
    ]
  },
  {
    title: 'HELP',
    items: [
      { cmd: '/help', kind: 'slash', desc: 'List every available slash command.' },
      { cmd: '/doctor', kind: 'slash', desc: 'Diagnose installation / health issues.' },
      { cmd: '/vim', kind: 'slash', desc: 'Toggle vim keybindings in the prompt box.' }
    ]
  }
];

function HandbookTab() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async (cmd: string) => {
    try { await window.cth.copyToClipboard(cmd); setCopied(cmd); setTimeout(() => setCopied((c) => (c === cmd ? null : c)), 1300); }
    catch { /* noop */ }
  };
  return (
    <Scroll>
      <Muted>Click any command to copy it. Slash commands run inside Claude Code; CLI commands run in a shell.</Muted>
      <div style={{ height: 8 }} />
      {HANDBOOK.map((g) => (
        <Section key={g.title} title={g.title}>
          {g.items.map((it) => (
            <div key={it.cmd} style={{
              padding: 6, marginBottom: 6,
              background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)'
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{
                  fontFamily: 'var(--cth-font-display)', fontSize: 7, lineHeight: '12px',
                  padding: '1px 4px 0', flexShrink: 0,
                  background: it.kind === 'slash' ? 'var(--cth-sky-light)' : 'var(--cth-mint-light)',
                  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)', color: 'var(--cth-ink-900)'
                }}>{it.kind === 'slash' ? 'SLASH' : 'CLI'}</span>
                <code style={{
                  flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-mono)', fontSize: 13,
                  color: 'var(--cth-ink-900)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>{it.cmd.trim() || '#'}</code>
                <button
                  onClick={() => copy(it.cmd)}
                  title="Copy command"
                  style={{
                    flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '2px 7px 1px', border: 'none', cursor: 'pointer',
                    background: copied === it.cmd ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
                    boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                    fontFamily: 'var(--cth-font-ui)', fontSize: 11, color: 'var(--cth-ink-900)'
                  }}
                >
                  <Icon name={copied === it.cmd ? 'check' : 'code'} /> {copied === it.cmd ? 'copied' : 'copy'}
                </button>
              </div>
              <div style={{ fontSize: 12, lineHeight: '16px', color: 'var(--cth-ink-700)', marginTop: 4 }}>{it.desc}</div>
              {it.usage && (
                <div style={{
                  marginTop: 3, fontFamily: 'var(--cth-font-mono)', fontSize: 11,
                  color: 'var(--cth-ink-500)'
                }}>e.g. {it.usage}</div>
              )}
            </div>
          ))}
        </Section>
      ))}
    </Scroll>
  );
}

// ─── small shared bits ───────────────────────────────────────────────────────

export function Scroll({ children }: { children: React.ReactNode }) {
  return <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 10, background: 'var(--cth-paper-200)' }}>{children}</div>;
}

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div style={{ fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px', color: 'var(--cth-ink-500)', marginBottom: 6 }}>{title}</div>
      {children}
    </div>
  );
}

export function Muted({ children }: { children: React.ReactNode }) {
  return <div style={{ fontSize: 12, color: 'var(--cth-ink-500)' }}>{children}</div>;
}

/** Monospace, wrapped, scrollable text block. `maxHeight` caps it (default 200);
 *  pass `'none'` for a block that grows with its container (e.g. the full-card
 *  detail view, which scrolls at the panel level instead). */
export function Pre({ children, maxHeight = 200 }: { children: React.ReactNode; maxHeight?: number | string }) {
  // When a caller opts into a percentage cap (e.g. maxHeight="100%"), also fill
  // that height so the block expands to its container instead of shrinking to
  // its content. Numeric callers (the default 200) keep their max-cap behavior.
  const height = maxHeight === '100%' ? '100%' : undefined;
  return (
    <pre style={{
      margin: '6px 0 0', padding: 8, maxHeight, height, overflow: 'auto',
      background: 'var(--cth-paper-100)', boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
      fontFamily: 'var(--cth-font-mono)', fontSize: 12, lineHeight: '16px',
      color: 'var(--cth-ink-900)', whiteSpace: 'pre-wrap', wordBreak: 'break-word'
    }}>{children}</pre>
  );
}

const textareaStyle: React.CSSProperties = {
  flex: 1, width: '100%', resize: 'none', padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
  fontFamily: 'var(--cth-font-mono)', fontSize: 13, lineHeight: '17px',
  color: 'var(--cth-ink-900)', outline: 'none', boxSizing: 'border-box'
};

