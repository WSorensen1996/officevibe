/**
 * HookServer — the bridge between `claude` lifecycle hooks and the harness.
 *
 * Each spawned agent is launched with `--settings` pointing its hooks at a tiny
 * shim (see HOOK_SHIM in project.ts) that forwards the hook payload to the Unix
 * domain socket this server listens on. We then:
 *   - drive avatar state from PreToolUse/PostToolUse/Notification/etc., and
 *   - implement the autonomous loop: on Stop, drain the agent's inbox and return
 *     {"decision":"block", reason} so the agent keeps working — guarded by
 *     `stop_hook_active` so it can never loop forever.
 *
 * Runs in the Electron main process.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, rmSync, chmodSync } from 'node:fs';
import { Notification, type WebContents } from 'electron';
import type { ProjectManager } from './project';
import type { HarnessConfig } from './config';
import type { KnowledgeManager } from './knowledge';
import { isRiskyAction } from './riskyAction';

// Tools safe to auto-approve without interrupting the human (read-only / non-
// mutating). Everything else (Bash, Write, Edit, WebFetch, …) asks for approval.
const ALWAYS_ALLOW = new Set([
  'Read', 'Grep', 'Glob', 'NotebookRead', 'TodoWrite', 'BashOutput', 'WebSearch'
]);

// ─── Hybrid approval model (task t-mq70hfiq-lfoa) ──────────────────────────────
// Goal: the user NEVER approves in an agent's terminal. Everything safe — edits,
// reads, builds, and ALL MCP tools — auto-approves silently. Genuinely RISKY
// actions (destructive or outbound/irreversible) surface as the in-app approval
// card, approvable from the UI or the phone (/remote-control). The risk heuristic
// lives in ./riskyAction (pure + unit-tested); it is a BEST-EFFORT foot-gun reducer,
// NOT a sandbox — an agent with full shell can defeat it, so the real safeguard
// remains running OfficeVibe only on projects/tools you trust.
// How long a pending permission request waits for the human before we fall through
// to Claude's native terminal prompt. MUST stay below both the PreToolUse hook
// `timeout` in settings.json and the shim's self-kill (see project.ts), so this
// timer — not a hard process kill — is what resolves a slow request.
const PERMISSION_TIMEOUT_MS = 30 * 60_000; // 30 min

/** A PreToolUse hook reply that lets the tool run with no prompt. */
function allowDecision(reason: string): unknown {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: reason } };
}
/** A PreToolUse hook reply carrying the user's (or system's) verdict. */
function preToolDecision(decision: 'allow' | 'deny' | 'ask', reason: string): unknown {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } };
}

interface HookPayload {
  hook_event_name?: string;
  agent_id?: string | null;
  session_id?: string;
  /** Path to this session's JSONL transcript — present on Stop. We read the just-
   *  finished turn's assistant text from it to capture "what the agent said". */
  transcript_path?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: unknown;
  stop_hook_active?: boolean;
  prompt?: string;
  source?: string;
  notification_type?: string;
  /** Notification hook text, e.g. "Claude is waiting for your input" (idle) vs a
   *  permission request. Used to tell "needs you" from "just done / lingering". */
  message?: string;
}

export class HookServer {
  private server: Server | null = null;
  /** Permission requests awaiting a human decision: requestId → the open hook
   *  socket (which `claude` is blocked on) + the agent + a fall-through timer. */
  private pending = new Map<string, { conn: Socket; agentId?: string; timer: NodeJS.Timeout }>();

  constructor(
    private project: ProjectManager,
    private getWebContents: () => WebContents | null,
    private getConfig: () => HarnessConfig,
    private knowledge: KnowledgeManager,
    private onIdle?: (agentId: string) => void
  ) {}

  start(): void {
    const sock = this.project.sockPath();
    if (!sock || this.server) return;
    // Clear a stale socket file left by a previous run.
    try { if (existsSync(sock)) rmSync(sock); } catch { /* noop */ }

    this.server = createServer((conn) => {
      let buf = '';
      conn.on('data', (d) => {
        buf += d.toString();
        const nl = buf.indexOf('\n');
        if (nl === -1) return; // wait for the full line
        let payload: HookPayload = {};
        try { payload = JSON.parse(buf.slice(0, nl)); } catch { /* ignore */ }
        // PreToolUse is the permission gate. Safe/auto-allowed tools answer
        // synchronously; anything needing a human holds this socket open until the
        // user decides in the UI (or it times out), then we write the decision.
        if ((payload.hook_event_name ?? '') === 'PreToolUse') {
          try { this.handlePreToolUse(payload, conn); }
          catch { try { conn.end('{}'); } catch { /* gone */ } }
          return;
        }
        let res: unknown = {};
        try { res = this.handle(payload); } catch { res = {}; }
        conn.end(JSON.stringify(res ?? {}));
      });
      conn.on('error', () => { /* shim hung up — ignore */ });
    });
    this.server.on('error', (e) => console.error('[project] hook server error:', e));
    // Restrict the approval socket to the owner once it's bound: anyone who can
    // connect can submit PreToolUse payloads, so don't leave it world-accessible.
    this.server.listen(sock, () => {
      try { chmodSync(sock, 0o600); } catch { /* best-effort on non-POSIX */ }
    });
  }

  stop(): void {
    // Release any in-flight permission requests so a blocked `claude` isn't left
    // hanging on a socket we're about to close.
    for (const [, e] of this.pending) {
      clearTimeout(e.timer);
      try { e.conn.end(JSON.stringify(preToolDecision('ask', 'harness shutting down'))); } catch { /* gone */ }
    }
    this.pending.clear();
    try { this.server?.close(); } catch { /* noop */ }
    this.server = null;
    const sock = this.project.sockPath();
    try { if (sock && existsSync(sock)) rmSync(sock); } catch { /* noop */ }
  }

  private handle(p: HookPayload): unknown {
    const agentId = p.agent_id ?? undefined;
    const event = p.hook_event_name ?? 'Unknown';

    if ((event === 'Stop' || event === 'SubagentStop') && agentId) {
      // Capture the agent's natural-language output for the just-finished turn and
      // surface it in the Messages tab. Only on Stop (not SubagentStop — a subagent's
      // transcript is a separate file, and a per-agent cursor shared across files would
      // mis-fire). Done first, on every Stop variant, since the prose exists regardless
      // of whether we re-engage the agent below. Cursor-gated, so it's idempotent.
      if (event === 'Stop') {
        try {
          const { says, skillsUsed } = this.project.recordSpoken(agentId, p.transcript_path);
          if (says.length) this.getWebContents()?.send('project:agentSaid', { agentId, says });
          // Count genuine skill reuse from the finished turn's Skill-tool invocations
          // (native skill loads emit no PostToolUse, so the transcript is the signal).
          if (skillsUsed.length) this.knowledge.bumpUseForSkills(skillsUsed);
        } catch { /* best-effort — never block a Stop on capture */ }
      }

      // Loop guard: a previous Stop hook already blocked this turn → let it stop.
      if (p.stop_hook_active) { this.emit(agentId, event, p); return {}; }
      const drain = this.project.drainForStop(agentId);
      if (drain.block) {
        // The agent is NOT idle — we're forcing it to keep working to process
        // its inbox. Tell the renderer that (blocked: true) so it doesn't flash
        // 'idle' on a Stop that never actually stops. Without this, an agent
        // re-engaged by a queued/dispatched message reads as idle while working.
        this.emit(agentId, event, p, true);
        return { decision: 'block', reason: drain.reason };
      }
      // A genuine stop with nothing queued → idle. Kick the background curator
      // (debounced) to capture/curate learnings from the just-finished work, then
      // surface the idle state as a desktop toast.
      try { this.onIdle?.(agentId); } catch { /* best-effort */ }
      this.notify(agentId ?? 'Agent', 'finished — idle');
      this.emit(agentId, event, p);
      return {};
    }

    // Inject the relevant project skills the team has learned. UserPromptSubmit carries
    // the prompt (rank against it); SessionStart gets a short library digest. Both are
    // fast + in-process only — the hook shim self-kills after 5s, so never spawn here.
    if (event === 'UserPromptSubmit' && agentId) {
      this.emit(agentId, event, p);
      try {
        const ctx = this.knowledge.injectionBlock(p.prompt ?? '');
        if (ctx) return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx } };
      } catch { /* best-effort */ }
      return {};
    }
    if (event === 'SessionStart' && agentId) {
      this.emit(agentId, event, p);
      try {
        const ctx = this.knowledge.sessionStartDigest();
        if (ctx) return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: ctx } };
      } catch { /* best-effort */ }
      return {};
    }
    // Count a skill as "used" when an agent reads its SKILL.md (then fall through to emit).
    if (event === 'PostToolUse' && p.tool_name === 'Read') {
      try { this.knowledge.bumpUseForPath((p.tool_input as { file_path?: string } | undefined)?.file_path); }
      catch { /* best-effort */ }
    }
    // …or when it invokes a skill via the native Skill tool (belt-and-suspenders with the
    // Stop-transcript scan, in case this Claude Code version DOES emit a Skill PostToolUse).
    if (event === 'PostToolUse' && p.tool_name === 'Skill') {
      try {
        const inp = p.tool_input;
        this.knowledge.bumpUseForSkillName(typeof inp === 'string' ? inp : JSON.stringify(inp ?? ''));
      } catch { /* best-effort */ }
    }

    // A Notification hook that means "the agent is blocked waiting for the user"
    // (idle prompt) deserves a desktop toast too — distinct from a permission
    // request, which surfaces natively in the agent's own Claude Code session
    // (approvable remotely via /remote-control).
    if (
      event === 'Notification' &&
      (p.notification_type === 'idle' ||
        (p.message ?? '').toLowerCase().includes('waiting for your input'))
    ) {
      this.notify(agentId ?? 'Agent', p.message ?? 'needs your attention');
    }

    // Forward everything else to the renderer so avatars reflect real activity.
    this.emit(agentId, event, p);
    return {};
  }

  /**
   * PreToolUse permission gate (Hybrid model — task t-mq70hfiq-lfoa). Emits the
   * avatar event, then: genuinely RISKY actions (destructive/outbound) always go to
   * the in-app approval card — even under autoMode; everything SAFE (read-only tools,
   * all MCP, and everything under autoMode) auto-approves silently with no terminal
   * prompt; in manual mode (autoMode off) a non-safe tool also asks via the card.
   * The card is approvable from the UI or the phone, so the user NEVER has to drop
   * into an agent's terminal. The structured `tool_input` is forwarded so the card
   * shows the exact command/file/url — no terminal scraping.
   */
  private handlePreToolUse(p: HookPayload, conn: Socket): void {
    const agentId = p.agent_id ?? undefined;
    this.emit(agentId, 'PreToolUse', p); // keep avatars live (station / carry)

    const tool = p.tool_name ?? '';
    const risky = isRiskyAction(tool, p.tool_input);
    // Safe path: auto-approve with no prompt. Covers ALL MCP tools (so non-granted
    // servers never prompt in the terminal), read-only/safe tools, and — when
    // full-auto is on — everything else. Risky actions skip this and fall through
    // to the card below regardless of autoMode.
    if (!risky && (tool.startsWith('mcp__') || this.getConfig().autoMode || ALWAYS_ALLOW.has(tool))) {
      conn.end(JSON.stringify(allowDecision('auto-approved')));
      return;
    }
    // Needs a human via the in-app card. With no live window we can't show it; to
    // keep the no-terminal guarantee we DENY rather than fall through to the TUI.
    const wc = this.getWebContents();
    if (!wc) { conn.end(JSON.stringify(preToolDecision('deny', 'no UI available to approve — denied'))); return; }
    const requestId = randomUUID();
    const timer = setTimeout(() => this.onTimeout(requestId), PERMISSION_TIMEOUT_MS);
    this.pending.set(requestId, { conn, agentId, timer });
    conn.on('close', () => this.discard(requestId));
    conn.on('error', () => this.discard(requestId));
    wc.send('permission:request', { requestId, agentId, tool, input: p.tool_input, cwd: p.cwd, risky });
  }

  /** Resolve a pending permission request with the user's verdict and write the
   *  PreToolUse decision back to the (still-open) hook socket. No-op if unknown. */
  respond(requestId: string, decision: 'allow' | 'deny', reason?: string): void {
    const e = this.pending.get(requestId);
    if (!e) return;
    clearTimeout(e.timer);
    this.pending.delete(requestId);
    try { e.conn.end(JSON.stringify(preToolDecision(decision, reason ?? ''))); }
    catch { /* socket already gone */ }
  }

  /** The human was slower than PERMISSION_TIMEOUT_MS. Hybrid model: never fall
   *  through to the terminal — DENY (re-run to retry) and clear the card. The card
   *  is remote-approvable, so the 30-min window is ample. */
  private onTimeout(requestId: string): void {
    const e = this.pending.get(requestId);
    if (!e) return;
    clearTimeout(e.timer);
    this.pending.delete(requestId);
    try { e.conn.end(JSON.stringify(preToolDecision('deny', 'timed out — denied; re-run to retry'))); }
    catch { /* gone */ }
    try { this.getWebContents()?.send('permission:resolved', { requestId, timedOut: true }); }
    catch { /* window torn down */ }
  }

  /** Drop a pending request whose socket closed (shim died / agent killed). */
  private discard(requestId: string): void {
    const e = this.pending.get(requestId);
    if (!e) return;
    clearTimeout(e.timer);
    this.pending.delete(requestId);
    try { this.getWebContents()?.send('permission:resolved', { requestId }); }
    catch { /* window torn down */ }
  }

  /** Deny + clear every pending request for an agent whose PTY just died (no one
   *  can answer). Called from teardownPty. Best-effort socket write. */
  rejectForAgent(agentId: string): void {
    for (const [requestId, e] of this.pending) {
      if (e.agentId !== agentId) continue;
      clearTimeout(e.timer);
      this.pending.delete(requestId);
      try { e.conn.end(JSON.stringify(preToolDecision('deny', 'agent terminated'))); } catch { /* gone */ }
      try { this.getWebContents()?.send('permission:resolved', { requestId }); } catch { /* gone */ }
    }
  }

  /** Fire a native desktop notification — gated on the user's `notifications`
   *  setting. Only the OS toast is gated; the project:hookEvent emit is always sent
   *  so avatars/UI stay live regardless. Best-effort: never throw into the hook. */
  private notify(title: string, body: string): void {
    if (!this.getConfig().notifications) return;
    try {
      if (!Notification.isSupported()) return;
      new Notification({ title, body }).show();
    } catch { /* notifications unsupported on this platform — ignore */ }
  }

  private emit(agentId: string | undefined, event: string, p: HookPayload, blocked = false): void {
    this.getWebContents()?.send('project:hookEvent', {
      agentId,
      event,
      tool: p.tool_name,
      notificationType: p.notification_type,
      source: p.source,
      message: p.message,
      blocked
    });
  }
}
