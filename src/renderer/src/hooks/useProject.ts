import { useEffect, useRef } from 'react';
import { useStore, type Agent, type StationKind, type ToolKind } from '@/store/store';
import { buildSpawnCommand, type HarnessConfig } from '@/store/config';
import { submitToPty } from './ptyInput';
import { permissionCard } from './permissionCard';

const GOD_ID = 'god';
const GOD_PTY = `pty-${GOD_ID}`;
const ASSISTANT_ID = 'assistant';
const ASSISTANT_PTY = `pty-${ASSISTANT_ID}`;

// How long to let Claude Code's TUI finish booting before we type the first
// thing into Michael's terminal, and the gap between the remote-control command
// and the orientation prompt so the slash command settles first.
const GOD_BOOT_MS = 4000;
const GOD_STEP_MS = 1800;

// The first thing Michael (god) is told on a fresh spawn — orient him and put
// him to work running the floor. Kept terse and action-oriented.
const INITIAL_GOD_PROMPT = [
  "You're online as Michael, the orchestrator of this project. Get oriented, then start running the floor:",
  '1. Read your memory.md and drain every message in your inbox.',
  '2. Review board.md and the current roster of agents (active vs archived).',
  '3. Run `mempalace wake-up` for a memory digest if the CLI is available.',
  'Then begin orchestrating: triage requests, delegate work to the team, and keep everyone unblocked. You are fully autonomous — there is no approval queue, so handle tool-permission prompts in this session yourself (the human can approve them remotely from their phone).'
].join('\n');

/** Wrap a user message as an enrich task for the assistant. The assistant's
 *  system prompt has the full instructions; this just frames the one task. */
function enrichTaskPrompt(text: string): string {
  return [
    `ENRICH TASK: ${text}`,
    '',
    '(Identify the relevant project, cd in, gather READ-ONLY context, then send the improved,',
    'self-contained prompt to Michael via an outbox message with "to":"god". Do not do the task yourself.)'
  ].join('\n');
}

/** Tool name → where the avatar walks + what it carries. */
const TOOL_STATION: Record<string, { station: StationKind; carry?: ToolKind }> = {
  Read: { station: 'shelf', carry: 'Read' },
  Edit: { station: 'desk', carry: 'Edit' },
  Write: { station: 'desk', carry: 'Write' },
  Bash: { station: 'terminal', carry: 'Bash' },
  Grep: { station: 'shelf', carry: 'Grep' },
  Glob: { station: 'shelf', carry: 'Glob' },
  WebFetch: { station: 'web', carry: 'WebFetch' },
  WebSearch: { station: 'web', carry: 'WebSearch' },
  TodoWrite: { station: 'board', carry: 'TodoWrite' }
};

/**
 * The renderer-side glue for the project:
 *   1. spawns the god agent into Michael's room when none is running,
 *   2. drives avatar state from real Claude Code hook events, and
 *   3. wakes idle agents that have unread inbox messages so collaboration
 *      doesn't stall while an agent sits at its prompt.
 */
export function useProject(config: HarnessConfig | null): void {
  // Per-agent dedup key for the inbox-wake nudge: the newest inbox message id we
  // last nudged about. Keyed by id (not count) so an oscillating count after a
  // drain doesn't re-nudge for the same message set.
  const nudged = useRef<Record<string, string>>({});
  // Per-agent timestamp of the last queued-message we submitted. Guards against
  // re-sending the next message before the agent's hooks have flipped it to
  // 'working' (there's a short window where it still reads 'idle' right after we
  // type into it). One message per cooldown keeps delivery strictly one-by-one.
  const lastFlush = useRef<Record<string, number>>({});
  // In-flight spawn guards so a re-render / StrictMode double-mount can't spawn
  // Michael or the assistant twice (the window between the listPtys check and
  // the spawnPty call is otherwise racy).
  const godSpawning = useRef(false);
  const assistantSpawning = useRef(false);
  // Per-agent debounce timers for the Browser-tab "is-browsing" cue: each agent's
  // mcp__browser__* tool resets its own timer, so the cue stays lit through that
  // agent's browsing burst and fades a few seconds after its last action.
  const browserIdle = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Short debounce for auto-following the acting agent onto the browser pane, so
  // a burst of alternating agents doesn't thrash the on-screen view.
  const autoFollow = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reactive so the assistant bootstrap (effect #1b) re-runs once Michael is ready.
  const godStatus = useStore((s) => s.godStatus);
  // Display label for the active project (shown under each agent, e.g. "Michael · Acme").
  const projectLabel = config?.projects?.find((p) => p.path === config?.activeProjectPath)?.name ?? 'project';

  // 1) Bootstrap the god agent (source of truth = live PTYs, to dodge restarts).
  useEffect(() => {
    if (!config?.onboardingComplete || !config.activeProjectPath) return;
    let cancelled = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    useStore.getState().setGodStatus('booting');
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === GOD_PTY)) { // already running — keep restored entry
        if (!cancelled) useStore.getState().setGodStatus('ready');
        return;
      }
      // Synchronous guard (no await between check and set) → exactly one spawn.
      if (cancelled || godSpawning.current) return;
      godSpawning.current = true;
      useStore.getState().removeAgent(GOD_ID); // clear any stale restored entry

      const command = buildSpawnCommand(config, config.defaultModel, config.defaultEffort);
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await window.cth.spawnPty({
        id: GOD_PTY,
        cwd: config.activeProjectPath!,
        command: exe,
        args,
        cols: 100,
        rows: 30,
        hive: { id: GOD_ID, name: 'Michael', cwd: config.activeProjectPath!, isGod: true, role: 'orchestrator (god)' }
      });
      if (cancelled) { godSpawning.current = false; return; }
      if (!res.ok) { godSpawning.current = false; useStore.getState().setGodStatus('failed'); return; }
      const god: Agent = {
        id: GOD_ID,
        name: 'Michael',
        character: 'michael',
        accent: 'lemon',
        description: 'god — runs the floor, triages requests, escalates only critical calls to you',
        project: projectLabel,
        tmuxTarget: '',
        cwd: config.activeProjectPath!,
        status: 'idle',
        action: 'running the floor',
        progress: 0,
        currentStation: 'desk',
        ptyId: GOD_PTY,
        command: command.trim(),
        model: config.defaultModel,
        effort: config.defaultEffort,
        isGod: true,
        recentTextTs: Date.now()
      };
      useStore.getState().addAgent(god);
      useStore.getState().setGodStatus('ready');

      // Fresh spawn → optionally enable remote control so the human can approve
      // permission prompts from their phone. This is gated by the `remoteControl`
      // setting (default off), independent of auto-pilot — when on, we type the
      // slash command (best-effort: a failed/unknown command just prints to his
      // terminal and is harmless); when off, the user runs it manually.
      //
      // The orientation prompt — which actually puts Michael to work running the
      // floor — only fires under auto-pilot. With auto-pilot off (the default),
      // startup is passive: Michael spawns idle and waits for the user to kick
      // off the first task. Restored sessions (the live-PTY branch above) skip
      // this whole block regardless.
      timers.push(setTimeout(() => {
        if (cancelled) return;
        if (config.remoteControl === true) {
          submitToPty(GOD_PTY, '/remote-control').catch(() => { /* best-effort */ });
        }
        if (!config.autoPilot) return;
        timers.push(setTimeout(() => {
          if (cancelled) return;
          submitToPty(GOD_PTY, INITIAL_GOD_PROMPT).catch(() => { /* pty may have died */ });
        }, GOD_STEP_MS));
      }, GOD_BOOT_MS));
    }, 1200);
    return () => { cancelled = true; clearTimeout(t); timers.forEach(clearTimeout); };
  }, [config?.onboardingComplete, config?.activeProjectPath]);

  // 1b) Bootstrap Michael's prep assistant ("Dwight") — only after Michael is
  //     ready, and only once. Same live-PTY idempotency + spawn-guard as #1.
  useEffect(() => {
    if (!config?.onboardingComplete || !config.activeProjectPath) return;
    if (godStatus !== 'ready') return;
    let cancelled = false;
    const t = setTimeout(async () => {
      if (cancelled) return;
      const live = await window.cth.listPtys().catch(() => []);
      if (live.some((p) => p.id === ASSISTANT_PTY)) return; // already running
      if (cancelled || assistantSpawning.current) return;
      assistantSpawning.current = true;
      useStore.getState().removeAgent(ASSISTANT_ID); // clear any stale restored entry

      // Dwight follows the same model policy as Michael — config.defaultModel,
      // which is unset by default → the subscription's default model (no --model
      // flag). Previously this forced claude-sonnet-4-6[1m]; pinning the premium
      // 1M-context variant risked costs outside a user's plan.
      const command = buildSpawnCommand(config, config.defaultModel, config.defaultEffort);
      const [exe, ...args] = command.trim().split(/\s+/);
      const res = await window.cth.spawnPty({
        id: ASSISTANT_PTY,
        cwd: config.activeProjectPath!,
        command: exe,
        args,
        cols: 100,
        rows: 30,
        hive: { id: ASSISTANT_ID, name: 'Dwight', cwd: config.activeProjectPath!, isAssistant: true, role: "Michael's prep assistant" }
      });
      if (cancelled || !res.ok) { assistantSpawning.current = false; return; }
      const assistant: Agent = {
        id: ASSISTANT_ID,
        name: 'Dwight',
        character: 'dwight',
        accent: 'sky',
        description: "assistant — enriches prompts with repo context, forwards them to Michael",
        project: projectLabel,
        tmuxTarget: '',
        cwd: config.activeProjectPath!,
        status: 'idle',
        action: 'standing by',
        progress: 0,
        currentStation: 'desk',
        ptyId: ASSISTANT_PTY,
        command: command.trim(),
        model: config.defaultModel,
        effort: config.defaultEffort,
        isAssistant: true,
        recentTextTs: Date.now()
      };
      // addAgent auto-selects the new agent; restore the prior selection so the
      // assistant booting in the background doesn't yank focus off Michael.
      const prevSel = useStore.getState().selectedId;
      useStore.getState().addAgent(assistant);
      useStore.getState().select(prevSel ?? GOD_ID);
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
  }, [config?.onboardingComplete, config?.activeProjectPath, godStatus]);

  // 2) Drive avatars from real hook events emitted by each agent's shim.
  useEffect(() => {
    const off = window.cth.onProjectHookEvent((e) => {
      if (!e.agentId) return;
      const { updateAgent, agents } = useStore.getState();
      const self = agents.find((a) => a.id === e.agentId);
      if (!self) return;
      // Hook events are the authoritative status source for real agents (the
      // pty-stream parser only refines the on-floor action/station).
      if (e.event === 'PreToolUse' && e.tool) {
        // Any agent's browser MCP tools (mcp__browser__*) drive its own view —
        // send the avatar to the web portal station while it browses.
        const isBrowser = e.tool.startsWith('mcp__browser__');
        const m = isBrowser
          ? { station: 'web' as StationKind, carry: 'WebFetch' as ToolKind }
          : (TOOL_STATION[e.tool] ?? { station: 'desk' as StationKind });
        const action = isBrowser ? `browsing (${e.tool.replace('mcp__browser__', '')})` : `using ${e.tool}`;
        // `browsing` is true ONLY for a live browser session (mcp__browser__*), not a
        // text WebSearch/WebFetch — both share the 'web' station, but only the former
        // drives the Browser pane, so only it should ping the user to the Browser tab.
        updateAgent(e.agentId, { status: 'working', currentStation: m.station, carrying: m.carry, action, browsing: isBrowser, blockReason: undefined });
        useStore.getState().bumpToolCount(e.agentId); // usage proxy for the command center
        if (isBrowser) {
          // Light the Browser-tab badge + this agent's browse cue, and (re)arm a
          // PER-AGENT fade so a second agent browsing doesn't leave the first one's
          // `browsing` flag stuck on. The global badge clears only once NO agent is
          // mid-browse.
          useStore.getState().setBrowserActive(true);
          const browsingAgentId = e.agentId;
          if (browserIdle.current[browsingAgentId]) clearTimeout(browserIdle.current[browsingAgentId]);
          browserIdle.current[browsingAgentId] = setTimeout(() => {
            delete browserIdle.current[browsingAgentId];
            useStore.getState().updateAgent(browsingAgentId, { browsing: false });
            if (Object.keys(browserIdle.current).length === 0) useStore.getState().setBrowserActive(false);
          }, 4000);
          // Auto-follow: bring the acting agent's browser on stage so the user
          // watches whoever just acted — UNLESS they've pinned a tab. Debounced so
          // a burst of alternating agents doesn't thrash the on-screen view. The
          // pin is re-checked at FIRE time so a pin set during the 250ms window wins.
          if (autoFollow.current) clearTimeout(autoFollow.current);
          autoFollow.current = setTimeout(() => {
            if (!useStore.getState().browserPinnedAgentId) window.cth.browser?.stage(browsingAgentId);
          }, 250);
        }
      } else if (e.event === 'PostToolUse' || e.event === 'UserPromptSubmit') {
        // A turn is in progress (prompt submitted / tool just finished) — keep
        // it working so it doesn't flicker idle between tool calls.
        updateAgent(e.agentId, { status: 'working', blockReason: undefined });
      } else if (e.event === 'Stop' || e.event === 'SubagentStop') {
        // A blocked Stop means the agent is being re-engaged to process its
        // inbox — it's NOT idle, so keep it working until it genuinely stops.
        if (e.blocked) {
          updateAgent(e.agentId, { status: 'working', action: 'reading inbox', carrying: undefined, blockReason: undefined });
        } else {
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined, browsing: false, blockReason: undefined });
        }
      } else if (e.event === 'Notification') {
        // Tool-permission prompts are handled by the PreToolUse hook gate (effect 2b
        // → permissionCard), not here. A Notification now means the agent ended its
        // turn waiting on the human: either it asked a free-text question, or it just
        // went idle. We no longer scrape the terminal — if the agent's last message
        // reads as a question, surface a reply card; otherwise settle idle. Never
        // clobber an active block (e.g. a pending permission card).
        if (self.status === 'blocked') return;
        const last = (self.recentAssistantText ?? '').trim();
        if (last.endsWith('?')) {
          updateAgent(e.agentId, {
            status: 'blocked', action: 'waiting on you', description: 'waiting on you',
            currentStation: 'mailbox', carrying: undefined, browsing: false,
            blockReason: {
              summary: last.length > 140 ? last.slice(0, 139) + '…' : last,
              detail: 'Type your answer below.',
              promptKind: 'text',
              actions: []
            }
          });
        } else {
          updateAgent(e.agentId, { status: 'idle', action: 'idle', carrying: undefined, blockReason: undefined });
        }
      }
    });
    const idleTimers = browserIdle.current;
    return () => {
      off();
      // Clear pending browser debounce timers so a stale callback can't fire after
      // unmount (e.g. a renderer reload).
      if (autoFollow.current) clearTimeout(autoFollow.current);
      Object.values(idleTimers).forEach(clearTimeout);
    };
  }, []);

  // 2b) Permission gate: an agent's PreToolUse hook is blocked awaiting approval.
  //     Main forwards the exact tool + structured input, so we render a precise card
  //     (no scraping) whose Approve/Deny buttons resolve the hook via respondPermission.
  useEffect(() => {
    const offReq = window.cth.onPermissionRequest((req) => {
      if (!req.agentId) return;
      const { updateAgent, agents } = useStore.getState();
      if (!agents.some((a) => a.id === req.agentId)) return;
      updateAgent(req.agentId, {
        status: 'blocked', action: 'waiting on you', description: 'waiting on you',
        currentStation: 'mailbox', carrying: undefined, browsing: false,
        blockReason: permissionCard(req)
      });
    });
    const offResolved = window.cth.onPermissionResolved(({ requestId, timedOut }) => {
      const { updateAgent, agents } = useStore.getState();
      const target = agents.find((a) => a.blockReason?.requestId === requestId);
      if (!target) return;
      if (timedOut) {
        updateAgent(target.id, {
          status: 'blocked', action: 'waiting on you', currentStation: 'mailbox',
          blockReason: {
            summary: 'Approval timed out',
            detail: 'Answer the prompt in the agent’s terminal, or reply below.',
            promptKind: 'text', actions: []
          }
        });
      } else {
        updateAgent(target.id, { status: 'working', action: 'working', blockReason: undefined });
      }
    });
    return () => { offReq(); offResolved(); };
  }, []);

  // 3) Wake idle agents holding unread inbox messages. The assistant is
  //    send-only (it never receives inbox mail), so it's excluded.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const iv = setInterval(async () => {
      // Passive startup: with auto-pilot off, stay silent until the user engages
      // the floor (dispatches/queues the first task). Re-checked each tick — the
      // moment the floor is started, normal agent-to-agent nudging resumes.
      if (!config.autoPilot && !useStore.getState().floorStarted) return;
      const agents = useStore.getState().agents.filter(
        (a) => a.ptyId && !a.isAssistant && (a.status === 'idle' || a.status === 'waiting')
      );
      for (const a of agents) {
        try {
          const inbox = await window.cth.projectInbox(a.id);
          // Dedup by the newest message id, not the count — a count can oscillate
          // as messages drain and re-arrive, which would re-nudge for the same set.
          const newest = inbox.length
            ? inbox.map((m) => m.id).sort().slice(-1)[0]
            : '';
          if (newest && nudged.current[a.id] !== newest) {
            nudged.current[a.id] = newest;
            await submitToPty(
              a.ptyId!,
              'You have new project inbox message(s) — read your inbox, act on them now, and move handled ones to inbox/.done/. Act autonomously; only message god if you genuinely need a decision.'
            );
          } else if (!newest) {
            nudged.current[a.id] = '';
          }
        } catch { /* ignore */ }
      }
    }, 4000);
    return () => clearInterval(iv);
  }, [config?.onboardingComplete]);

  // 3b) A scheduled task/mission just fired in the main process. Start the floor
  //     so the wake-nudge loop above delivers it to the idle assignee even when
  //     auto-pilot is off — the scheduler runs in main and can't flip the
  //     transient floorStarted flag itself.
  useEffect(() => window.cth.onSchedulerFired(() => useStore.getState().startFloor()), []);

  // 4) Drain each agent's queued messages to its terminal, one at a time, the
  //    moment the agent goes idle. This is what lets the user keep sending
  //    messages while the agent's "cloud terminal" is mid-run: the messages
  //    park in the store and get typed in (and submitted) as soon as it's free.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    const FLUSH_COOLDOWN_MS = 4500;

    // Send the front of `srcId`'s queue into `target`'s pty (verbatim or wrapped),
    // gated on the target being idle + off cooldown. Keyed cooldown per target so
    // strict one-by-one delivery holds. Returns true if it dispatched.
    const dispatch = (srcId: string, target: Agent | undefined, wrap?: (t: string) => string): boolean => {
      const { messageQueues, removeQueuedMessage } = useStore.getState();
      const next = messageQueues[srcId]?.[0];
      if (!next || !target?.ptyId || target.status !== 'idle') return false;
      const now = Date.now();
      if (now - (lastFlush.current[target.id] ?? 0) < FLUSH_COOLDOWN_MS) return false;
      lastFlush.current[target.id] = now;
      // Remove first so a burst of store updates can't double-send the same one.
      removeQueuedMessage(srcId, next.id);
      submitToPty(target.ptyId, wrap ? wrap(next.text) : next.text).catch(() => { /* pty may have died */ });
      return true;
    };

    const flush = () => {
      const { agents, messageQueues, enrichEnabled } = useStore.getState();
      const byId = (id: string) => agents.find((a) => a.id === id);

      // Sub-agents (and the assistant's own direct queue): flush verbatim into
      // their own terminal. Michael's queue is handled specially below.
      for (const a of agents) {
        if (a.id === GOD_ID) continue;
        if (!a.ptyId || a.status !== 'idle') continue;
        if (!messageQueues[a.id]?.length) continue;
        dispatch(a.id, a);
      }

      // Michael's queue: enrich OFF → straight to Michael; enrich ON → wrap as an
      // ENRICH TASK and route to the assistant, which forwards to Michael's inbox.
      if (messageQueues[GOD_ID]?.length) {
        if (enrichEnabled) dispatch(GOD_ID, byId(ASSISTANT_ID), enrichTaskPrompt);
        else dispatch(GOD_ID, byId(GOD_ID));
      }
    };

    // Run on every store change (status flips, new queue items) — debounced so a
    // burst of pty-stream updates coalesces — plus a periodic backstop.
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const schedule = () => {
      if (debounce) return;
      debounce = setTimeout(() => { debounce = null; flush(); }, 200);
    };
    const unsub = useStore.subscribe(schedule);
    const iv = setInterval(flush, 3000);
    schedule();
    return () => { unsub(); if (debounce) clearTimeout(debounce); clearInterval(iv); };
  }, [config?.onboardingComplete]);

  // 5) Pipe inbound Slack messages into Michael's queue. The main-process Slack
  //    webhook server pushes each verified message here via IPC; enqueueing to
  //    GOD_ID lands it in Michael's queue exactly as if the user had typed it
  //    into the composer — effect #4 above then drains it to his PTY.
  useEffect(() => {
    if (!config?.onboardingComplete) return;
    return window.cth.onSlackMessage((msg) => {
      if (!msg?.text?.trim()) return;
      useStore.getState().enqueueMessage(GOD_ID, msg.text.trim());
    });
  }, [config?.onboardingComplete]);
}
