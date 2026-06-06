/**
 * The Project store — the on-disk multi-agent coordination layer.
 *
 * Lives at the active project folder (`activeProjectPath`, named `officevibe-<slug>`).
 * State is plain files (JSON + markdown) that this main process owns — projects are
 * NOT git repos. Responsibilities:
 *   - per-agent workspace (identity.md, memory.md, inbox/, outbox/, cursor.json)
 *   - a roster (registry.json), shared blackboard (board.md), task ledger,
 *     and an append-only event log (log.jsonl)
 *   - a router that drains each agent's outbox into recipients' inboxes
 *
 * Human-in-the-loop is native to each agent's Claude Code session: permission
 * prompts surface in the agent's own terminal (and can be approved remotely via
 * `/remote-control`). A project keeps no separate approval queue — a message aimed
 * at "human" is routed to the god/orchestrator, the human's proxy on the floor.
 *
 * Everything here runs in the Electron main process.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync,
  readdirSync, rmSync, appendFileSync, statSync
} from 'node:fs';
import { join } from 'node:path';
import { deriveProjectName, readConfig } from './config';
import { mcpServersForAgent } from './mcp';
import { randomBytes } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────────────────────

export type MessageAct = 'request' | 'inform' | 'propose' | 'query' | 'agree' | 'refuse' | 'done';

export interface ProjectMessage {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;                 // an agentId, 'god', or 'broadcast'
  act: MessageAct;
  subject: string;
  body: string;
  hops: number;
  requires_reply: boolean;
  needs_human: boolean;
  created_at: string;
}

/** One natural-language utterance an agent produced during a turn — "what it said".
 *  Captured from the Claude Code transcript on the Stop hook and stored OUTSIDE the
 *  inbox (see `recordSpoken`), so it can be shown in the Messages tab without the
 *  agent ever reading its own monologue as incoming mail. */
export interface AgentSay {
  id: string;     // `${stamp()}-${shortRand()}` — sortable, matches the message-id style
  ts: string;     // ISO timestamp
  text: string;   // the turn's text blocks, joined (length-capped to SAY_CAP)
  turn: string;   // the transcript entry uuid this came from (per-turn grouping)
}

/** A short status note an agent posts onto a task (the human's board TLDR).
 *  `by` is the authoring agent (stamped from the owning outbox dir, not trusted
 *  from the file). `kind` doubles as the auto-move target: doing/blocked/done
 *  slide the card into that column; `note` is informational only. */
export interface TaskUpdate {
  ts: string;                 // ISO — stamped by the harness at ingest
  by: string;                 // agentId (authoritative = owning outbox dir)
  kind: 'doing' | 'blocked' | 'done' | 'note';
  text: string;
}

export interface ProjectTask {
  id: string;
  title: string;
  description?: string;
  assignee?: string;
  status: 'todo' | 'doing' | 'blocked' | 'done';
  dependsOn: string[];
  priority: number;
  createdAt: string;
  /** Append-only agent status notes, harness-owned, capped to the last 20. */
  updates?: TaskUpdate[];
  /** ISO of the last status change — recency tiebreaker so a stale wholesale
   *  renderer overwrite can't revert a fresher agent auto-move (and vice-versa). */
  statusUpdatedAt?: string;
  /** ISO of the last UI dispatch — hides the dispatch button until the task's
   *  status next changes (re-nudgeable when blocked). */
  dispatchedAt?: string;
  /** Human-set: hide from the board's 4 columns and collect in the ARCHIVED
   *  section. Orthogonal to `status` — round-trips via the writeTasks `...t` spread. */
  archived?: boolean;
  /** ISO of the last time the human opened this card's full view — drives the
   *  unread/"just finished" indicator. Renderer-owned: round-trips via the
   *  writeTasks `...t` spread and is untouched by appendTaskUpdate. */
  viewedAt?: string;
}

export interface AgentMeta {
  id: string;
  name: string;
  role?: string;
  capabilities?: string[];
  cwd: string;
  isGod?: boolean;
  /** Michael's prep assistant — enriches prompts and forwards them to Michael.
   *  Send-only: excluded from broadcast fan-out so it never drains an inbox. */
  isAssistant?: boolean;
}

export interface RegistryAgent extends AgentMeta {
  status: 'idle' | 'working' | 'blocked' | 'gone';
  lastSeen: number;
  /** True once the agent's terminal/PTY tab is closed. The record is retained
   *  (not deleted) so its history/memory survive; only agents with a live PTY
   *  are 'active'. Broadcast fan-out + roster reads skip archived agents. */
  archived?: boolean;
}

export interface Registry {
  godId: string | null;
  agents: Record<string, RegistryAgent>;
}

/** Build env + extra spawn args that make a `claude` process hive-aware. */
export interface SpawnInjection {
  args: string[];
  env: Record<string, string>;
}

/** One Claude rate-limit window (5-hour or 7-day), as captured from the Claude
 *  Code statusLine `rate_limits` payload. */
export interface UsageWindow {
  /** 0–100 percent of the window's limit consumed. */
  usedPercent: number;
  /** Unix epoch seconds when the rolling window resets, or null if unknown. */
  resetsAt: number | null;
}

/** Account-wide Claude subscription usage snapshot recorded by the usage shim. */
export interface UsageLimits {
  fiveHour: UsageWindow | null;
  sevenDay: UsageWindow | null;
  model: string | null;
  /** Epoch ms the snapshot was written — drives a "stale" indicator. */
  capturedAt: number;
}

const HOP_CAP = 12;

/** One parsed line of a Claude Code transcript (JSONL). Only the fields we read are
 *  typed; the on-disk shape (and the `uuid` cursor key) is verified empirically by the
 *  repo's own transcript parser (see transcript.ts / readAgentUsage). */
interface TranscriptEntry {
  type?: string;
  uuid?: string;
  message?: { content?: Array<{ type?: string; text?: string; name?: string; input?: unknown }> };
}

/** Per-utterance text cap, and a defensive ceiling on transcript size we'll read in
 *  full inside the Stop hook (beyond it we read only the trailing window — the shim
 *  self-kills after 5s, so a multi-MB synchronous read must stay bounded). */
const SAY_CAP = 4000;
const MAX_TRANSCRIPT_BYTES = 50 * 1024 * 1024;
const TRANSCRIPT_TAIL_BYTES = 1 * 1024 * 1024;

/** Filesystem- and sort-safe timestamp, e.g. 2026-05-30T14-03-11-123Z. */
function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function shortRand(): string {
  return randomBytes(3).toString('hex');
}

// ─── ProjectManager ────────────────────────────────────────────────────────────

export class ProjectManager {
  /**
   * @param getHome  Lazily resolve harnessHome so the hive follows config changes.
   * @param emit     Optional sink for renderer-facing events (set by the main
   *                 process to `webContents.send`). Used to animate routed
   *                 messages on the office floor; a no-op in tests/headless.
   */
  constructor(
    private getHome: () => string | null,
    private emit?: (channel: string, payload: unknown) => void,
    /** Called synchronously inside ensureAgent (before spawn) with each agent's
     *  minted browser token, so the main process can map token → agentId for the
     *  shared browser MCP server's per-request resolver. */
    private onBrowserToken?: (agentId: string, token: string) => void
  ) {}

  private routerTimer: NodeJS.Timeout | null = null;

  /** URL of the in-process browser MCP server (set by the main process once it's
   *  listening). When set, EVERY agent is spawned with a --mcp-config pointing at
   *  it (each with its own per-agent token), giving every agent live control of
   *  its own embedded browser view. */
  private browserEndpoint: { url: string } | null = null;

  /** Per-agent browser token (memoized so a respawn under the same id reuses the
   *  same token — keeps the main process's token→agentId map stable). */
  private agentBrowserTokens = new Map<string, string>();

  /** Record the browser MCP endpoint so subsequent spawns inject it. */
  setBrowserEndpoint(url: string): void {
    this.browserEndpoint = { url };
  }

  // — paths —
  /** The active project folder IS the data root (was `<harnessHome>/hive`). */
  root(): string | null {
    return this.getHome();
  }
  enabled(): boolean {
    return this.root() !== null;
  }
  private agentDir(id: string): string {
    return join(this.root()!, 'agents', id);
  }
  /** Unix-domain socket the cth-hook shim talks to (Phase 1 autonomy). */
  sockPath(): string | null {
    const root = this.root();
    return root ? join(root, 'hooks.sock') : null;
  }
  private shimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-hook.cjs') : null;
  }
  /** Shim wired up as each agent's `statusLine` command. Claude Code pipes the
   *  session JSON (incl. `rate_limits`) to it on every status refresh; the shim
   *  records the account-wide 5h/7d usage to `usage.json`. */
  private usageShimPath(): string | null {
    const root = this.root();
    return root ? join(root, 'bin', 'cth-usage.cjs') : null;
  }
  /** Where the usage shim writes the latest Claude session/weekly limit snapshot. */
  private usagePath(): string | null {
    const root = this.root();
    return root ? join(root, 'usage.json') : null;
  }

  // — bootstrap —

  /** Create the project skeleton if missing. Idempotent. */
  ensureProject(): void {
    const root = this.root();
    if (!root) return;
    // Capture BEFORE we write the manifest below: true only for an already-
    // established OfficeVibe project. Used to safely drop a leftover project-level
    // `.git` (see end of method) without touching a real code repo the user just
    // opened (that folder has no manifest yet → flag is false → its .git is kept).
    const wasOfficeVibeProject = existsSync(join(root, 'officevibe.json'));
    mkdirSync(join(root, 'agents'), { recursive: true });

    // Identity manifest — lets the switcher show a display name and lets "open
    // project" recognise a folder as an OfficeVibe project. A folder created via
    // project:create already has one (with the user's name); fall back otherwise.
    const manifest = join(root, 'officevibe.json');
    if (!existsSync(manifest)) {
      this.writeJson(manifest, { name: deriveProjectName(root), createdAt: new Date().toISOString(), version: 1 });
    }

    const protocol = join(root, 'PROTOCOL.md');
    if (!existsSync(protocol)) writeFileSync(protocol, PROTOCOL_MD, 'utf8');

    const registry = join(root, 'registry.json');
    if (!existsSync(registry)) {
      this.writeJson(registry, { godId: null, agents: {} } as Registry);
    }
    const board = join(root, 'board.md');
    if (!existsSync(board)) {
      writeFileSync(board, '# Project board\n\n_Shared plans live here. The god agent is the scribe._\n', 'utf8');
    }
    const tasks = join(root, 'tasks.json');
    if (!existsSync(tasks)) this.writeJson(tasks, { tasks: [] });
    const log = join(root, 'log.jsonl');
    if (!existsSync(log)) writeFileSync(log, '', 'utf8');

    // Knowledge ("Project Brain") scaffold — the team-shared skill library. Created
    // here so the spawn's `--add-dir <root>/knowledge` always points at an existing dir.
    mkdirSync(join(root, 'knowledge', '.claude', 'skills'), { recursive: true });
    mkdirSync(join(root, 'knowledge', 'proposals', '.done'), { recursive: true });
    mkdirSync(join(root, 'knowledge', 'patches', '.done'), { recursive: true });
    mkdirSync(join(root, 'knowledge', 'deliverables'), { recursive: true });

    // The hook shim: a dumb pipe between a `claude` hook and our UDS. The usage
    // shim: a `statusLine` command that records Claude's 5h/7d limit usage.
    // Both refreshed on every bootstrap so they track code changes.
    mkdirSync(join(root, 'bin'), { recursive: true });
    writeFileSync(this.shimPath()!, HOOK_SHIM, 'utf8');
    writeFileSync(this.usageShimPath()!, USAGE_SHIM, 'utf8');

    // Projects are NOT git-aware. State lives in plain JSON/markdown files; we no
    // longer `git init` or commit. Drop a leftover project-level `.git` from an
    // already-established OfficeVibe project so it stops looking git-connected —
    // never from a folder the user just opened (its real repo has no manifest yet).
    if (wasOfficeVibeProject && existsSync(join(root, '.git'))) {
      try { rmSync(join(root, '.git'), { recursive: true, force: true }); }
      catch (e) { console.error('[project] failed to remove legacy .git:', e); }
    }
  }

  /**
   * Ensure an agent's workspace + registry entry, returning the spawn injection
   * (extra `claude` args + env) that makes the process hive-aware.
   */
  ensureAgent(meta: AgentMeta, opts: { semanticMemory?: boolean; knowledge?: boolean } = {}): SpawnInjection {
    const root = this.root();
    if (!root) return { args: [], env: {} };
    this.ensureProject();

    const dir = this.agentDir(meta.id);
    mkdirSync(join(dir, 'inbox', '.done'), { recursive: true });
    mkdirSync(join(dir, 'outbox', '.sent'), { recursive: true });

    const identity = join(dir, 'identity.md');
    writeFileSync(identity, this.identityText(meta), 'utf8'); // refresh on each spawn

    const memory = join(dir, 'memory.md');
    if (!existsSync(memory)) {
      writeFileSync(memory, `# Memory — ${meta.name} (${meta.id})\n\n_Append durable facts, decisions, and context below._\n`, 'utf8');
    }
    const cursor = join(dir, 'cursor.json');
    if (!existsSync(cursor)) this.writeJson(cursor, { lastProcessed: null });

    // upsert registry
    const reg = this.registry();
    reg.agents[meta.id] = {
      ...meta,
      capabilities: meta.capabilities ?? [],
      role: meta.role ?? (meta.isGod ? 'orchestrator' : 'agent'),
      status: 'idle',
      // A (re)spawn always means a live terminal — clear any prior archived flag.
      archived: false,
      lastSeen: Date.now()
    };
    if (meta.isGod) reg.godId = meta.id;
    this.writeJson(join(root, 'registry.json'), reg);

    this.appendLog({ kind: 'spawn', agentId: meta.id, name: meta.name, isGod: !!meta.isGod });

    const env: Record<string, string> = {
      AGENT_ID: meta.id,
      AGENT_NAME: meta.name,
      PROJECT_ROOT: root,
      AGENT_DIR: dir
    };
    const args = ['--append-system-prompt', this.injectedPrompt(meta, dir, root, opts.semanticMemory ?? false, opts.knowledge ?? false)];

    // Self-improvement: expose the team-shared skill library to this agent. `--add-dir`
    // makes Claude Code auto-discover <root>/knowledge/.claude/skills (verified via smoke
    // test); KNOWLEDGE_DIR lets the agent read a skill's full text on demand.
    if (opts.knowledge) {
      const kdir = join(root, 'knowledge');
      env.KNOWLEDGE_DIR = kdir;
      args.push('--add-dir', kdir);
    }

    // Resolve which MCP servers this agent receives: the user-configured servers in
    // scope (every agent for scope 'all'; only the god for scope 'god') plus the
    // built-in browser server — now given to EVERY agent so web/browser tasks are
    // delegable, each with its OWN per-agent token. `grantedNames` feeds the
    // permission allow-rules in hookSettings below (bypassPermissions alone does NOT
    // expose MCP tools); the merged `mcpServers` map is written to mcp.json.
    const { servers: userServers, names: userNames } = mcpServersForAgent(readConfig().mcpServers, !!meta.isGod);
    const mcpServers: Record<string, unknown> = { ...userServers };
    const grantedNames = [...userNames];
    if (this.browserEndpoint) {
      // Mint (or reuse) this agent's browser token and register it with the main
      // process BEFORE the PTY spawns, so the MCP resolver can route the agent's
      // first browser tool call to its own view.
      // NOTE (trust model): the token is written into agents/<id>/mcp.json, which
      // sibling agents can read — so the per-agent browser is an isolation boundary
      // for SESSIONS/logins (separate partitions), not a hard security boundary
      // against a malicious peer. All agents here are trusted local Claude processes
      // sharing one OS user (same model as before, when the god's token lived in its
      // own mcp.json). Hardening to a per-agent UDS/port is possible if that changes.
      let tok = this.agentBrowserTokens.get(meta.id);
      if (!tok) { tok = randomBytes(24).toString('hex'); this.agentBrowserTokens.set(meta.id, tok); }
      mcpServers.browser = {
        type: 'http',
        url: this.browserEndpoint.url,
        headers: { 'x-agent-token': tok }
      };
      grantedNames.push('browser');
      try { this.onBrowserToken?.(meta.id, tok); } catch (e) { console.error('[browser] onBrowserToken failed:', e); }
    }

    // Phase 1 — autonomy: attach lifecycle hooks via --settings (no edits to the
    // user's repo) so the agent reports activity and drains its inbox on Stop. The
    // granted MCP tools are pre-approved here so the agent can call them.
    const sock = this.sockPath();
    const shim = this.shimPath();
    if (sock && shim) {
      env.PROJECT_SOCK = sock;
      const settingsPath = join(dir, 'settings.json');
      this.writeJson(settingsPath, this.hookSettings(shim, grantedNames));
      args.push('--settings', settingsPath);
    }

    // Load the merged servers via --mcp-config. Additive (no --strict-mcp-config) so
    // the agent also keeps any MCP servers the user configured globally for the CLI.
    if (Object.keys(mcpServers).length > 0) {
      const mcpPath = join(dir, 'mcp.json');
      this.writeJson(mcpPath, { mcpServers });
      args.push('--mcp-config', mcpPath);
    }
    return { args, env };
  }

  /**
   * Flip an agent's archived flag and persist the registry. Closing a terminal
   * tab archives the agent (retained + flagged, NOT deleted); a (re)spawn clears
   * it. No-op if the agent isn't registered or the flag is already set the way
   * asked. Best-effort — never throws, so a dying PTY/kill handler can't crash.
   */
  setArchived(id: string, archived: boolean): void {
    const root = this.root();
    if (!root) return;
    try {
      const reg = this.registry();
      const agent = reg.agents[id];
      if (!agent || agent.archived === archived) return;
      agent.archived = archived;
      agent.lastSeen = Date.now();
      this.writeJson(join(root, 'registry.json'), reg);
      this.appendLog({ kind: 'archive', agentId: id, archived });
    } catch { /* best-effort — never crash a lifecycle handler */ }
  }

  /** Claude Code settings that route every relevant hook through the shim. We also
   *  pre-approve each granted MCP server's tools (`mcp__<name>__*`) — verified that
   *  bypassPermissions alone does NOT expose MCP tools; an allow rule is required.
   *  `mcpNames` is the set of servers this agent actually received (browser for the
   *  god, plus any user-configured servers in scope), so the rules are never broader
   *  than what's wired in. */
  private hookSettings(shim: string, mcpNames: string[] = []): unknown {
    const cmd = `node "${shim}"`;
    const entry = (matcher?: string, timeout?: number) => ({
      ...(matcher ? { matcher } : {}),
      hooks: [{ type: 'command', command: cmd, ...(timeout ? { timeout } : {}) }]
    });
    const settings: Record<string, unknown> = {
      hooks: {
        Stop: [entry()],
        SubagentStop: [entry()],
        // PreToolUse drives the approval card; give the human time to answer before
        // Claude's hook timeout fires (default 600s) and falls through to the TUI.
        PreToolUse: [entry('*', PRETOOL_HOOK_TIMEOUT_SEC)],
        PostToolUse: [entry('*')],
        UserPromptSubmit: [entry()],
        Notification: [entry()],
        SessionStart: [entry()]
      }
    };
    // A custom statusLine: Claude Code pipes the session JSON (incl. account-wide
    // `rate_limits`) to this shim on every refresh, so it captures the 5h/7d usage
    // to usage.json. The shim also prints an informative line (model + ctx% + 5h/7d%)
    // so the agent's TUI status bar is an upgrade, not a blank.
    const usageShim = this.usageShimPath();
    if (usageShim) {
      settings.statusLine = { type: 'command', command: `node "${usageShim}"`, padding: 1 };
    }
    if (mcpNames.length > 0) {
      settings.permissions = { allow: mcpNames.map((n) => `mcp__${n}__*`) };
    }
    return settings;
  }

  /** Latest Claude session(5h)/weekly(7d) usage snapshot the usage shim recorded,
   *  or null if not captured yet. Resilient: any read/parse failure yields null
   *  rather than throwing into the IPC handler. */
  usageLimits(): UsageLimits | null {
    const file = this.usagePath();
    if (!file || !existsSync(file)) return null;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as UsageLimits;
      return raw && typeof raw === 'object' ? raw : null;
    } catch {
      return null;
    }
  }

  /**
   * Drain an agent's inbox for the Stop hook. Returns whether to block-to-continue
   * and the message text to feed back. Uses the per-agent cursor so a message is
   * surfaced exactly once (no infinite loop).
   */
  drainForStop(agentId: string): { block: boolean; reason?: string } {
    const dir = this.agentDir(agentId);
    if (!existsSync(dir)) return { block: false };
    const cursorPath = join(dir, 'cursor.json');
    const cursor = this.readJson<{ lastProcessed: string | null }>(cursorPath, { lastProcessed: null });
    const fresh = this.inbox(agentId)
      .filter((m) => !cursor.lastProcessed || m.id > cursor.lastProcessed)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (fresh.length === 0) return { block: false };

    cursor.lastProcessed = fresh[fresh.length - 1].id;
    this.writeJson(cursorPath, cursor);
    this.appendLog({ kind: 'drain', agentId, count: fresh.length });

    const lines = fresh.map((m) => `- [from ${m.from}, ${m.act}] ${m.subject}: ${m.body}`).join('\n');
    const reason = [
      `You have ${fresh.length} new project message(s) in your inbox. Address them before finishing:`,
      lines,
      `Open the files in ${dir}/inbox/ for full detail, act on each, then move handled ones to inbox/.done/. Reply via your outbox if a message requires it.`
    ].join('\n');
    return { block: true, reason };
  }

  /**
   * Capture the agent's natural-language output ("what it said") for the just-finished
   * turn, from the Claude Code transcript at `transcriptPath` (provided by the Stop hook).
   * Reads assistant `text` blocks appended since this agent's `lastSpokenUuid` cursor,
   * appends them to `agents/<id>/says.jsonl`, advances the cursor, and returns the new
   * utterances so the caller can emit a renderer event.
   *
   * Deliberately stores OUTSIDE the inbox: the inbox drives the autonomous Stop loop
   * (drainForStop) and agents read every inbox file as incoming mail — writing an agent's
   * own monologue there would loop forever and confuse the agent. Words only: `thinking`
   * and `tool_use` blocks are excluded. Fast + synchronous + never throws — it runs inside
   * the hook handler and the shim self-kills after 5s.
   */
  recordSpoken(agentId: string, transcriptPath: string | undefined): { says: AgentSay[]; skillsUsed: string[] } {
    const skillsUsed: string[] = [];
    try {
      if (!transcriptPath || !existsSync(transcriptPath)) return { says: [], skillsUsed };
      const dir = this.agentDir(agentId);
      if (!existsSync(dir)) return { says: [], skillsUsed };

      // Bound the synchronous read: parse the whole file normally, but for a
      // pathologically large transcript read only the trailing window. The cursor still
      // prevents dupes; worst case we miss very old prose on a first-ever giant capture.
      let raw: string;
      try {
        const size = statSync(transcriptPath).size;
        if (size > MAX_TRANSCRIPT_BYTES) {
          const fd = readFileSync(transcriptPath);
          raw = fd.subarray(fd.length - TRANSCRIPT_TAIL_BYTES).toString('utf8');
        } else {
          raw = readFileSync(transcriptPath, 'utf8');
        }
      } catch { return { says: [], skillsUsed }; }

      const cursorPath = join(dir, 'cursor.json');
      const cursor = this.readJson<{ lastProcessed: string | null; lastSpokenUuid?: string | null }>(
        cursorPath, { lastProcessed: null, lastSpokenUuid: null }
      );

      const out: AgentSay[] = [];
      let started = !cursor.lastSpokenUuid;          // no cursor → take everything
      let lastUuid: string | null = cursor.lastSpokenUuid ?? null;

      for (const line of raw.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        let rec: TranscriptEntry;
        try { rec = JSON.parse(t) as TranscriptEntry; } catch { continue; }
        const uuid = typeof rec.uuid === 'string' ? rec.uuid : undefined;
        // Fast-forward past everything up to and including the cursor entry.
        if (!started) { if (uuid && uuid === cursor.lastSpokenUuid) started = true; continue; }
        if (uuid) lastUuid = uuid;                   // advance past every entry (even tool-only)
        if (rec.type !== 'assistant' || !Array.isArray(rec.message?.content)) continue;
        // Detect native Skill-tool invocations so the harness can count real reuse —
        // a Skill load doesn't emit a PostToolUse:Read, so this transcript scan is the
        // only reliable signal. Capture the skill name + stringified input; the
        // KnowledgeManager resolves each to a known slug.
        for (const b of rec.message!.content!) {
          if (b && b.type === 'tool_use' && typeof b.name === 'string' && b.name.toLowerCase() === 'skill') {
            skillsUsed.push(typeof b.input === 'string' ? b.input : JSON.stringify(b.input ?? ''));
          }
        }
        const text = rec.message!.content!
          .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
          .map((b) => (b.text as string).trim())
          .filter(Boolean)
          .join('\n\n');                             // join this turn's text blocks
        if (!text) continue;                         // tool/thinking-only turn → nothing said
        out.push({
          id: `${stamp()}-${shortRand()}`,
          ts: new Date().toISOString(),
          text: text.slice(0, SAY_CAP),
          turn: uuid ?? ''
        });
      }

      // Advance the cursor even when nothing was said, so handled lines aren't re-scanned.
      if (lastUuid && lastUuid !== (cursor.lastSpokenUuid ?? null)) {
        this.writeJson(cursorPath, { ...cursor, lastSpokenUuid: lastUuid });
      }
      if (out.length === 0) return { says: [], skillsUsed };
      appendFileSync(
        join(dir, 'says.jsonl'),
        out.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf8'
      );
      this.appendLog({ kind: 'said', agentId, count: out.length });
      return { says: out, skillsUsed };
    } catch {
      return { says: [], skillsUsed }; // best-effort — never crash the Stop hook
    }
  }

  // — agent-facing text —

  private identityText(meta: AgentMeta): string {
    const caps = (meta.capabilities ?? []).join(', ') || '—';
    return [
      `# ${meta.name} (${meta.id})`,
      '',
      `- Role: ${meta.role ?? (meta.isGod ? 'orchestrator (god)' : 'agent')}`,
      `- Capabilities: ${caps}`,
      `- Working directory: ${meta.cwd}`,
      meta.isGod ? '- You are the **god / orchestrator**. You run the floor — keep awareness of the whole team, delegate execution, and personally own only the important calls (decomposition, sign-offs, conflicts, integration), not the grunt work.' : '',
      ''
    ].filter(Boolean).join('\n');
  }

  private injectedPrompt(meta: AgentMeta, dir: string, root: string, semanticMemory: boolean, knowledge: boolean): string {
    const skillsLine = knowledge
      ? '6. The team shares a growing SKILL library — reusable how-to for THIS project. At task START you get a "PROJECT SKILLS" note listing the WHOLE library (★ = most relevant to your task); to use one, load its full procedure with the Skill tool (by its name/slug) and follow it before reinventing. CAPTURE at task END: if you discovered a REUSABLE procedure future tasks will repeat, write ONE JSON file into your outbox shaped {"type":"skill-proposal","slug":"kebab-name","title":"short title","description":"<=80 chars on what it does","tags":["topic"],"body":"# Title\\n## When to Use\\n…\\n## Procedure\\n1. …\\n## Pitfalls\\nfailure modes + fixes\\n## Verification\\nhow to confirm it worked"} — keep those four sections. CORRECT in-flight: if you find a skill wrong/incomplete WHILE using it, fix it immediately — outbox {"type":"skill-patch","slug":"<slug>","append":"what was wrong + the corrected steps"} (or "body" to fully rewrite). Reusable PROCEDURES only: one-off facts go in memory.md, and investigation reports / briefs / research DELIVERABLES go in $KNOWLEDGE_DIR/deliverables/<name>.md (NOT loose in $KNOWLEDGE_DIR, and NOT as skills).'
      : '';
    const memoryLine = semanticMemory
      ? 'Semantic memory: the whole team shares a searchable MemPalace at $MEMPALACE_PALACE_PATH. To recall relevant past knowledge across the team, run `mempalace search "<query>"`; run `mempalace wake-up` at the start of a task for a memory digest. Your notes in memory.md are mined into the palace automatically — write durable facts there.'
      : '';
    const godLine = meta.isGod
      ? 'You are the GOD / ORCHESTRATOR of this project — your job is to ORCHESTRATE, not to implement: maintain live situational awareness and delegate the work. (1) AWARENESS — always know what is going on: keep an accurate picture of every agent (active vs archived/idle), the task board, and all in-flight work; drain your inbox continually and triage every other agent\'s requests, answering clarifications so the team runs autonomously. (2) DELEGATE — decompose work and fan it out to the project agents via their inboxes (route messages and assign owners; do not do their jobs); do NOT take on grunt implementation yourself. (3) OWN ONLY THE IMPORTANT, high-leverage things — task decomposition, dispatch decisions, sign-offs, conflict resolution, branch integration, and final QA — and remain the sole scribe of board.md. You are otherwise fully autonomous — there is NO separate approval queue. For the genuinely critical (destructive actions, spending real money, scope changes, unresolvable conflicts), ask the human directly in your own session and let the tool-permission prompt gate the action; the human approves natively, including remotely from their phone via /remote-control. Keep the team unblocked. WEB/BROWSER work is DELEGABLE: every agent now has its OWN live browser, so route web/browser tasks to the agent that owns the work instead of funneling them all to yourself — you MAY still browse yourself when it is the high-leverage move (quick research, a sign-off check), but do not become the team\'s sole web operator.'
      : meta.isAssistant
      ? 'You are Michael\'s PREP ASSISTANT. You will be handed short, possibly vague instructions (each begins with "ENRICH TASK:"). For each one: (1) figure out which project it concerns and cd into the most relevant repo — you start in Michael\'s home directory; (2) gather concrete context READ-ONLY (exact file paths, current state, relevant code, conventions, active branch, gotchas) — NEVER modify, create, or delete files; (3) rewrite the instruction into ONE clear, self-contained prompt that Michael can execute autonomously, preserving the user\'s original intent without inventing scope. Then deliver it: write ONE message JSON into your outbox with "to":"god", "act":"request", a short subject, and the finished prompt as the body. Do NOT perform the task yourself — your only output is the improved prompt sent to Michael.'
      : 'For anything ambiguous, cross-cutting, or needing sign-off, address a message to "god".';
    // Every agent owns a live browser (the built-in browser MCP server is granted
    // to all agents). Tell them how to use it and how the user watches it.
    const browserLine = 'You have your OWN live browser — use mcp__browser__* (browser_navigate / browser_snapshot / browser_click / browser_type / browser_read_text / browser_screenshot). Call browser_snapshot to get each clickable element\'s ref before clicking/typing. This is the live browser pane the user can watch: when you act, the bottom-left Browser pane auto-follows you (the user can also pin your tab to watch you). For plain text lookups WebSearch/WebFetch still work too.';
    // Team-wide communication style: keep every human-facing output short, precise,
    // and easy to understand. Applies to all agents (god/assistant/workers) since
    // they all receive this injected prompt.
    const styleLine = 'COMMUNICATION STYLE: lead with the answer. Keep every human-facing output — task-updates, messages, and your final replies — short, precise, and easy to understand: a one-line takeaway first, then only the detail that matters. Prefer plain language and tight bullets over long paragraphs; cut filler, preamble, and restating the question. Be brief without dropping anything important (and no need to label or announce that you are being brief).';
    return [
      `You are "${meta.name}" (${meta.id}), an autonomous agent in a collaborating team of Claude agents.`,
      `Your private workspace is ${dir}. The shared project is ${root}. Full protocol: ${root}/PROTOCOL.md.`,
      '',
      'PROJECT PROTOCOL — follow it every task:',
      `1. At the START of a task, read ${dir}/memory.md and EVERY file in ${dir}/inbox/ (messages other agents sent you). After handling an inbox message, move its file into ${dir}/inbox/.done/.`,
      `2. Record durable facts, decisions, and context by appending to ${dir}/memory.md.`,
      `3. To ask another agent for something or share information, write ONE message JSON into ${dir}/outbox/ (schema in PROTOCOL.md). NEVER write into another agent's folder — the orchestrator delivers your outbox.`,
      '4. At the END of a task, append what you learned to memory.md so future-you remembers.',
      `5. If a task you were given includes a [task:<id>] marker, report progress to the human by writing ONE JSON file into ${dir}/outbox/ shaped {"type":"task-update","taskId":"<id>","kind":"doing|blocked|done|note","text":"one short line for the board"}. It is NOT a message (no recipient, no reply); the harness shows it on that task's card, and kind doing|blocked|done also moves the card into that column. Post one when you start, when you hit a blocker (say why), and when you finish.`,
      skillsLine,
      memoryLine,
      godLine,
      browserLine,
      styleLine,
      `Env vars available to you: AGENT_ID, AGENT_NAME, PROJECT_ROOT, AGENT_DIR${knowledge ? ', KNOWLEDGE_DIR' : ''}.`
    ].filter(Boolean).join('\n');
  }

  // — messaging —

  /** Normalize a partial message into a full ProjectMessage. */
  private normalize(partial: Partial<ProjectMessage>, from: string): ProjectMessage {
    const act = (partial.act ?? 'inform') as MessageAct;
    return {
      id: partial.id ?? `${stamp()}-${shortRand()}`,
      conversation: partial.conversation ?? `conv-${shortRand()}`,
      in_reply_to: partial.in_reply_to ?? null,
      from: partial.from ?? from,
      to: partial.to ?? 'god',
      act,
      subject: partial.subject ?? '',
      body: partial.body ?? '',
      hops: typeof partial.hops === 'number' ? partial.hops : 0,
      requires_reply: partial.requires_reply ?? ['request', 'query', 'propose'].includes(act),
      needs_human: partial.needs_human ?? false,
      created_at: partial.created_at ?? new Date().toISOString()
    };
  }

  /** Atomically deliver a message into a recipient agent's inbox. Returns whether
   *  it actually landed (false = the recipient has no inbox dir, e.g. unknown id). */
  private deliver(msg: ProjectMessage, toId: string): boolean {
    const inbox = join(this.agentDir(toId), 'inbox');
    if (!existsSync(inbox)) return false; // unknown recipient — dropped
    this.atomicWriteJson(join(inbox, `${msg.id}.json`), msg);
    return true;
  }

  /** Inject a message directly (used by the orchestrator / UI / tests). Returns
   *  the message plus how many inboxes it actually reached, so callers (the UI)
   *  can tell the user when a send fanned out to nobody instead of faking success. */
  send(partial: Partial<ProjectMessage>, from = 'system'): { message: ProjectMessage; delivered: number } {
    const msg = this.normalize(partial, from);
    const delivered = this.routeMessage(msg);
    return { message: msg, delivered: delivered.length };
  }

  /** Route a message to its recipients' inboxes. Returns the ids it actually
   *  delivered to (empty = dropped). */
  private routeMessage(msg: ProjectMessage): string[] {
    if (msg.hops > HOP_CAP) {
      // loop guard — drop a runaway message rather than let agents ping-pong.
      // There's no human queue to fall back on; the god agent owns conflicts.
      this.appendLog({ kind: 'drop', reason: 'hop-cap', from: msg.from, to: msg.to, id: msg.id });
      return [];
    }
    const reg = this.registry();
    const godId = reg.godId ?? 'god';
    // The hive has no separate human-approval queue — approvals are native to
    // each agent's Claude Code session (and approvable remotely). A message aimed
    // at "human" is handled by the god/orchestrator, the human's proxy here.
    const resolveTo = (to: string): string => (to === 'human' || to === 'god' ? godId : to);
    const candidates = msg.to === 'broadcast'
      // The roster for fan-out is the ACTIVE registry: skip the send-only prep
      // assistant and any archived agent (closed tab) so mail never piles into a
      // dead inbox no one will read.
      ? Object.keys(reg.agents).filter((a) => a !== msg.from && !reg.agents[a]?.isAssistant && !reg.agents[a]?.archived)
      // Never deliver to self — guards a god → "human" message looping back to god.
      : [resolveTo(msg.to)].filter((t) => t !== msg.from);
    const delivered = candidates.filter((t) => this.deliver(msg, t));
    if (delivered.length > 0) {
      this.appendLog({ kind: 'message', from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id, delivered: delivered.length });
    } else {
      // Reached nobody — a broadcast where every agent is archived/send-only, or a
      // direct message to an unknown id. Log it as a drop so it surfaces loudly in
      // the activity log instead of vanishing behind a fake "sent".
      this.appendLog({
        kind: 'drop',
        reason: msg.to === 'broadcast' ? 'no-active-recipients' : 'unknown-recipient',
        from: msg.from, to: msg.to, act: msg.act, subject: msg.subject, id: msg.id
      });
    }
    this.emitMessage(msg, delivered);
    return delivered;
  }

  /** Tell the renderer a message was routed, with its resolved recipients, so
   *  the floor can fly an envelope from the sender to each one. Best-effort. */
  private emitMessage(msg: ProjectMessage, targets: string[]): void {
    this.emit?.('project:message', {
      id: msg.id,
      from: msg.from,
      to: msg.to,
      act: msg.act,
      subject: msg.subject,
      targets,
      // Coral-tints the floor envelope for a message the agent flagged for the
      // human (now routed to the god proxy). Cosmetic only — no queue behind it.
      needsHuman: msg.to === 'human'
    });
  }

  // — router: drain outboxes → inboxes —

  /** Poll-based router. Cheap and robust vs fs.watch quirks on macOS. */
  startRouter(intervalMs = 1500): void {
    if (this.routerTimer || !this.enabled()) return;
    this.routerTimer = setInterval(() => {
      try { this.routeOnce(); } catch { /* keep the loop alive */ }
    }, intervalMs);
  }
  stopRouter(): void {
    if (this.routerTimer) { clearInterval(this.routerTimer); this.routerTimer = null; }
  }

  routeOnce(): number {
    const root = this.root();
    if (!root) return 0;
    const agentsDir = join(root, 'agents');
    if (!existsSync(agentsDir)) return 0;
    let routed = 0;
    for (const id of readdirSync(agentsDir)) {
      const outbox = join(agentsDir, id, 'outbox');
      if (!existsSync(outbox)) continue;
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const full = join(outbox, f);
        try {
          const partial = JSON.parse(readFileSync(full, 'utf8')) as
            Partial<ProjectMessage> & {
              type?: string; taskId?: string; kind?: string; text?: string;
              slug?: string; title?: string; description?: string; body?: string; tags?: unknown;
              append?: string;
            };
          // A task-update is a board side-channel, NOT mail: handle it entirely
          // here so a missing/typo taskId can never fall through to routeMessage
          // and land as empty junk in god's inbox (losing the update too).
          if (partial.type === 'task-update') {
            this.appendTaskUpdate(id, partial); // id = owning dir = authoritative author
          } else if (partial.type === 'skill-proposal') {
            this.stageSkillProposal(id, partial); // a learned skill → knowledge library
          } else if (partial.type === 'skill-patch') {
            this.stageSkillPatch(id, partial); // an in-flight correction → knowledge library
          } else {
            const msg = this.normalize(partial, id);
            msg.from = id; // sender is authoritative — the owning directory
            this.routeMessage(msg);
          }
          renameSync(full, join(outbox, '.sent', f)); // archive, don't reprocess
          routed++;
        } catch {
          // malformed file — quarantine so we don't spin on it
          try { renameSync(full, join(outbox, '.sent', `bad-${f}`)); } catch { /* noop */ }
        }
      }
    }
    return routed;
  }

  // — read helpers (for IPC / UI) —

  registry(): Registry {
    const root = this.root();
    if (!root) return { godId: null, agents: {} };
    return this.readJson<Registry>(join(root, 'registry.json'), { godId: null, agents: {} });
  }
  board(): string {
    const root = this.root();
    return root && existsSync(join(root, 'board.md')) ? readFileSync(join(root, 'board.md'), 'utf8') : '';
  }
  tasks(): unknown {
    const root = this.root();
    return root ? this.readJson(join(root, 'tasks.json'), { tasks: [] }) : { tasks: [] };
  }

  /** Persist the task ledger to tasks.json. Mirrors the board/message persist
   *  pattern: write JSON, then log the change.
   *
   *  Clobber-safe merge-by-id (same shape as the missions:save fix): the renderer
   *  POSTs the WHOLE array from an up-to-5s-stale copy, so for every task that
   *  still exists on disk we (a) ALWAYS restore the harness-owned `updates[]`
   *  from disk, and (b) keep the NEWER `status`/`statusUpdatedAt` so a stale
   *  human write can't revert a fresh agent auto-move — and a deliberate human
   *  drag (freshly stamped by the renderer) still wins. A task absent from the
   *  incoming array is a delete: it drops with its updates (the only intended loss). */
  writeTasks(tasks: ProjectTask[]): void {
    const root = this.root();
    if (!root) return;
    this.ensureProject();
    const persisted = this.readJson<{ tasks: ProjectTask[] }>(join(root, 'tasks.json'), { tasks: [] });
    const byId = new Map(persisted.tasks.map((t) => [t.id, t] as const));
    const merged = tasks.map((t) => {
      const disk = byId.get(t.id);
      if (!disk) return t;                                   // brand-new task — take as-is
      const diskNewer = (disk.statusUpdatedAt ?? '') > (t.statusUpdatedAt ?? '');
      return {
        ...t,
        updates: disk.updates ?? t.updates,                  // agent history always from disk
        status: diskNewer ? disk.status : t.status,          // most-recent status writer wins
        statusUpdatedAt: diskNewer ? disk.statusUpdatedAt : t.statusUpdatedAt
      };
    });
    this.writeJson(join(root, 'tasks.json'), { tasks: merged });
    this.appendLog({ kind: 'tasks', count: merged.length });
  }

  /** Append one agent status note to a task and (for doing/blocked/done)
   *  auto-move the card's column. Called ONLY from routeOnce when an agent drops
   *  a {type:"task-update"} file in its outbox, so the main process stays the sole
   *  writer of tasks.json. A missing/unknown taskId is logged (never silently routed
   *  as mail) so a dropped TLDR is at least visible in the activity feed. */
  appendTaskUpdate(by: string, raw: { taskId?: string; kind?: string; text?: string }): void {
    const root = this.root();
    if (!root) return;
    const taskId = typeof raw.taskId === 'string' ? raw.taskId : '';
    const data = this.readJson<{ tasks: ProjectTask[] }>(join(root, 'tasks.json'), { tasks: [] });
    const task = data.tasks.find((t) => t.id === taskId);
    if (!task) { this.appendLog({ kind: 'task-update-miss', taskId, by }); return; }
    const kind: TaskUpdate['kind'] =
      (['doing', 'blocked', 'done', 'note'] as const).includes(raw.kind as TaskUpdate['kind'])
        ? (raw.kind as TaskUpdate['kind']) : 'note';
    const u: TaskUpdate = { ts: new Date().toISOString(), by, kind, text: String(raw.text ?? '').slice(0, 280) };
    task.updates = [...(task.updates ?? []), u].slice(-20);
    if (kind !== 'note') { task.status = kind; task.statusUpdatedAt = u.ts; } // auto-move the card
    this.writeJson(join(root, 'tasks.json'), data);
    this.appendLog({ kind: 'task-update', taskId, by, state: kind });
    this.emit?.('project:taskUpdated', { taskId, by, kind, text: u.text });
  }

  /** Stage a skill an agent drafted into the knowledge library's `proposals/` dir for
   *  the curator to promote. Like task-updates, this is a side-channel handled entirely
   *  here — single-writer discipline: agents propose into their own outbox, the harness
   *  promotes. A missing title/body is logged, never routed as junk mail. */
  private stageSkillProposal(
    by: string,
    raw: { slug?: string; title?: string; description?: string; body?: string; tags?: unknown }
  ): void {
    const root = this.root();
    if (!root) return;
    const title = typeof raw.title === 'string' ? raw.title.trim() : '';
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    if (!title || !body) { this.appendLog({ kind: 'skill-proposal-miss', by, reason: 'missing title/body' }); return; }
    const slug = (typeof raw.slug === 'string' && raw.slug ? raw.slug : title)
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'skill';
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [];
    const proposalsDir = join(root, 'knowledge', 'proposals');
    mkdirSync(join(proposalsDir, '.done'), { recursive: true });
    this.atomicWriteJson(join(proposalsDir, `${stamp()}-${shortRand()}.json`), {
      slug,
      title: title.slice(0, 120),
      description: (typeof raw.description === 'string' ? raw.description : '').slice(0, 200),
      body,
      tags,
      by
    });
    this.appendLog({ kind: 'skill-proposal', by, slug });
    this.emit?.('project:skillProposal', { by, slug, title: title.slice(0, 120) });
  }

  /** Stage an in-flight skill correction (a `{type:"skill-patch"}` outbox file) into
   *  knowledge/patches/ for the curator to apply on its next (idle-debounced) cycle.
   *  Single-writer discipline mirrors stageSkillProposal: the agent proposes, the
   *  harness applies. A patch with no slug or no body/append is logged, never routed. */
  private stageSkillPatch(
    by: string,
    raw: { slug?: string; title?: string; description?: string; body?: string; append?: string; tags?: unknown }
  ): void {
    const root = this.root();
    if (!root) return;
    const slug = (typeof raw.slug === 'string' ? raw.slug : '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    const body = typeof raw.body === 'string' ? raw.body.trim() : '';
    const append = typeof raw.append === 'string' ? raw.append.trim() : '';
    if (!slug || (!body && !append)) { this.appendLog({ kind: 'skill-patch-miss', by, reason: 'missing slug/body' }); return; }
    const tags = Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string').slice(0, 8) : [];
    const patchesDir = join(root, 'knowledge', 'patches');
    mkdirSync(join(patchesDir, '.done'), { recursive: true });
    this.atomicWriteJson(join(patchesDir, `${stamp()}-${shortRand()}.json`), {
      slug,
      title: typeof raw.title === 'string' ? raw.title.slice(0, 120) : undefined,
      description: typeof raw.description === 'string' ? raw.description.slice(0, 200) : undefined,
      body, append, tags, by
    });
    this.appendLog({ kind: 'skill-patch', by, slug });
    this.emit?.('project:skillProposal', { by, slug, title: (raw.title ?? slug).slice(0, 120) });
  }

  memory(id: string): string {
    const p = join(this.agentDir(id), 'memory.md');
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  }
  inbox(id: string): ProjectMessage[] {
    return this.listMessages(join(this.agentDir(id), 'inbox'));
  }
  /** Tail of an agent's captured utterances (what it said while working). Mirrors
   *  logTail: read says.jsonl, keep the last N lines, parse resiliently. */
  saysTail(id: string, n = 200): AgentSay[] {
    const p = join(this.agentDir(id), 'says.jsonl');
    if (!existsSync(p)) return [];
    return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
      .slice(-n)
      .map((l) => { try { return JSON.parse(l) as AgentSay; } catch { return null; } })
      .filter((s): s is AgentSay => s !== null);
  }
  logTail(n = 200): unknown[] {
    const root = this.root();
    if (!root || !existsSync(join(root, 'log.jsonl'))) return [];
    const lines = readFileSync(join(root, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
  }

  private listMessages(dir: string): ProjectMessage[] {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')) as ProjectMessage; } catch { return null; } })
      .filter((m): m is ProjectMessage => m !== null);
  }

  // — log —
  appendLog(event: Record<string, unknown>): void {
    const root = this.root();
    if (!root) return;
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n';
    try { appendFileSync(join(root, 'log.jsonl'), line, 'utf8'); } catch { /* noop */ }
  }

  // — json + atomic io —
  private readJson<T>(p: string, fallback: T): T {
    try { return JSON.parse(readFileSync(p, 'utf8')) as T; } catch { return fallback; }
  }
  private writeJson(p: string, data: unknown): void {
    writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  }
  private atomicWriteJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }
}

// ─── PROTOCOL.md (written into the project, readable by every agent) ─────────

const PROTOCOL_MD = `# Project protocol

You are one of several Claude agents sharing this project. Coordination is entirely
file-based; the harness (main process) is the only thing that moves messages
between agents.

## Your workspace — \`agents/<your-id>/\`
- \`identity.md\`  — who you are (read-only; the harness writes it).
- \`memory.md\`    — your long-term memory. Read at the start of a task; append to it as you learn.
- \`inbox/\`       — messages addressed to you. Read them at the start of a task.
- \`inbox/.done/\` — move a message here once you've handled it.
- \`outbox/\`      — drop messages here to send them. The harness delivers them.

**Never write into another agent's folder.** Write to your own \`outbox/\`; the
orchestrator routes it. This keeps every file single-writer.

## Sending a message
Write one JSON file into \`outbox/\` (any filename ending in \`.json\`):

\`\`\`json
{
  "to": "<agent-id> | god | broadcast",
  "act": "request | inform | propose | query | agree | refuse | done",
  "subject": "one-line summary",
  "body": "the details",
  "conversation": "carry this across a thread (optional)",
  "in_reply_to": "<message id you're replying to> (optional)"
}
\`\`\`

The harness fills in \`id\`, \`from\`, \`hops\`, and timestamps.

## Posting a task status update (TLDR for the human's board)
If a task you were given includes a \`[task:<id>]\` marker, report progress by writing ONE
JSON file into \`outbox/\` (any \`.json\` name) — this is NOT mail, has no recipient, and gets
no reply:

\`\`\`json
{ "type": "task-update", "taskId": "<the [task:<id>] you were given>",
  "kind": "doing | blocked | done | note", "text": "one short line for the board" }
\`\`\`

The harness shows it on that task's card. \`kind\` doing/blocked/done also moves the card
into that column; \`note\` is informational only. Post one when you START, when you're
BLOCKED (say why in \`text\`), and when you're DONE. Never edit \`tasks.json\` yourself.

## Your browser
You have your OWN live browser via the \`mcp__browser__*\` tools (\`browser_navigate\`,
\`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_read_text\`,
\`browser_screenshot\`, plus \`browser_go_back\`/\`browser_go_forward\`/\`browser_reload\`/\`browser_wait\`).
Always \`browser_snapshot\` a page to get each element's \`ref\` before \`browser_click\`/\`browser_type\`.
Web/browser tasks are delegable — anyone can be assigned one. The user watches one agent's
browser at a time in the bottom-left pane; it auto-follows whoever just acted (the user can
pin a tab). For plain text lookups the built-in \`WebSearch\`/\`WebFetch\` tools also work.

## Rules of the road
- Only \`request\`, \`query\`, and \`propose\` expect a reply. \`inform\` and \`done\` are terminal —
  don't reply to them, or two agents will loop forever.
- For anything ambiguous, cross-cutting, or needing sign-off, message \`god\` — the
  god agent clarifies answers for you so you rarely need the human directly.
- There is NO separate human-approval queue. Human-in-the-loop is native to Claude
  Code: a tool you run that needs permission prompts in your own session (the human
  can approve it remotely from their phone via \`/remote-control\`). If you genuinely
  need a human decision, raise it with \`god\` (a message \`"to": "human"\` is routed to
  the god/orchestrator, the human's proxy on the floor).
- \`board.md\` is the shared plan. Don't edit it directly — \`propose\` changes to \`god\`,
  who is its sole scribe.
- Re-reading a message you already moved to \`.done/\` is a no-op. Don't reprocess.

## Semantic memory (optional — when \`mempalace\` is installed)
When \`MEMPALACE_PALACE_PATH\` is set in your environment, the team shares a
searchable MemPalace and you have the \`mempalace\` CLI:
- \`mempalace search "<query>"\` — recall relevant past knowledge across the whole
  team by meaning (not just keywords). Add \`--wing <agent-id>\` to scope to one
  agent, \`--results N\` to widen.
- \`mempalace wake-up\` — a short digest of what matters, good at the start of a task.

Your \`memory.md\` is mined into the palace automatically, so the durable facts you
write there become searchable by every agent. You don't run \`mine\` yourself.
`;

// PreToolUse is a human-in-the-loop permission gate: the hook (and its shim) must
// stay alive long enough for the user to click Approve/Deny. Keep this in sync with
// the settings.json PreToolUse `timeout` and HookServer.PERMISSION_TIMEOUT_MS.
const PRETOOL_HOOK_TIMEOUT_SEC = 3600; // 60 min

// ─── cth-hook shim (written to <project>/bin/cth-hook.cjs) ───────────────────
// A minimal pipe: read the hook payload on stdin, tag it with this agent's id,
// forward it to the project's UDS, and relay the response back to `claude`. All
// the real logic lives in the main process (HookServer). The shim self-kills after a
// short grace for most events, but waits out the human for PreToolUse. Never blocks
// a stop on error.
const HOOK_SHIM = `#!/usr/bin/env node
'use strict';
const net = require('net');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let payload = {};
  try { payload = JSON.parse(data || '{}'); } catch (_) {}
  if (!payload.agent_id) payload.agent_id = process.env.AGENT_ID || null;
  const sock = process.env.PROJECT_SOCK;
  if (!sock) { process.exit(0); }
  let resp = '';
  const done = (code) => { if (resp) process.stdout.write(resp); process.exit(code); };
  const c = net.createConnection(sock, () => c.write(JSON.stringify(payload) + '\\n'));
  c.setEncoding('utf8');
  c.on('data', (d) => { resp += d; });
  c.on('end', () => done(0));
  c.on('error', () => process.exit(0));
  const killMs = payload.hook_event_name === 'PreToolUse' ? ${PRETOOL_HOOK_TIMEOUT_SEC * 1000} : 5000;
  setTimeout(() => process.exit(0), killMs).unref();
});
`;

// ─── cth-usage shim (written to <project>/bin/cth-usage.cjs) ─────────────────
// Wired as each agent's Claude Code `statusLine` command. Claude Code pipes the
// session JSON (incl. account-wide `rate_limits.five_hour` / `seven_day`) on
// stdin every refresh. The shim records the latest 5h/7d usage to
// <PROJECT_ROOT>/usage.json (merging so a momentarily-absent window isn't wiped),
// and prints an informative status line back so the agent's TUI bar shows
// "[model] ctx N% · 5h N% · 7d N%". Best-effort; never throws.
const USAGE_SHIM = `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  let p = {};
  try { p = JSON.parse(data || '{}'); } catch (_) {}
  const rl = p.rate_limits || {};
  const five = rl.five_hour, seven = rl.seven_day;
  const model = (p.model && p.model.display_name) || null;
  const ctx = p.context_window && typeof p.context_window.used_percentage === 'number'
    ? p.context_window.used_percentage : null;
  const has = (w) => w && typeof w.used_percentage === 'number';
  // Always print a useful status line (this is what Claude Code renders).
  const parts = [];
  if (model) parts.push('[' + model + ']');
  if (ctx != null) parts.push('ctx ' + Math.round(ctx) + '%');
  if (has(five)) parts.push('5h ' + Math.round(five.used_percentage) + '%');
  if (has(seven)) parts.push('7d ' + Math.round(seven.used_percentage) + '%');
  process.stdout.write(parts.join(' \\u00b7 '));
  const root = process.env.PROJECT_ROOT;
  if (root) {
    try {
      const file = path.join(root, 'usage.json');
      let prev = {};
      try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
      const out = {
        fiveHour: has(five)
          ? { usedPercent: five.used_percentage, resetsAt: typeof five.resets_at === 'number' ? five.resets_at : null }
          : (prev.fiveHour || null),
        sevenDay: has(seven)
          ? { usedPercent: seven.used_percentage, resetsAt: typeof seven.resets_at === 'number' ? seven.resets_at : null }
          : (prev.sevenDay || null),
        model: model || prev.model || null,
        capturedAt: Date.now()
      };
      const tmp = file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(out), 'utf8');
      fs.renameSync(tmp, file);
    } catch (_) { /* best-effort */ }
  }
  process.exit(0);
});
`;
