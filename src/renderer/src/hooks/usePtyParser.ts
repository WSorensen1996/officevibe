import { useCallback, useEffect, useRef } from 'react';
import { useStore, type ToolKind, type StationKind } from '@/store/store';

// ANSI escape sequence stripper — Claude colors its tool tags with these.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// Tool call lines look like: `● Read SPEC.md`, `● Bash npm test`, `● Edit src/foo.ts`
const TOOL_RE = /●\s+([A-Za-z][A-Za-z_]*)(?:\s+(.+))?/g;

const TOOL_TO_STATION: Record<string, StationKind> = {
  Read: 'shelf', Edit: 'shelf', Write: 'shelf', MultiEdit: 'shelf',
  Grep: 'shelf', Glob: 'shelf',
  Bash: 'terminal', BashOutput: 'terminal',
  WebFetch: 'web', WebSearch: 'web',
  TodoWrite: 'board', TaskCreate: 'board', TaskUpdate: 'board'
};

const TOOLKIND_BY_NAME: Record<string, ToolKind> = {
  Read: 'Read', Edit: 'Edit', Write: 'Write',
  Bash: 'Bash',
  WebFetch: 'WebFetch', WebSearch: 'WebSearch',
  Grep: 'Grep', Glob: 'Glob',
  TodoWrite: 'TodoWrite'
};

/**
 * Subscribe to a pty stream and refine the agent's on-floor avatar state (station /
 * carry / working-vs-idle) from the tool lines that scroll past. It is NOT the
 * source of truth for status — Claude Code hooks are (see useProject): the
 * PreToolUse permission gate raises approval cards and Stop/Notification settle
 * idle. This only animates the avatar between those authoritative events.
 *
 * Returns a function suitable for `<PtyTerminalView onStreamData={...} />`.
 */
export function usePtyParser(agentId: string) {
  const updateAgent = useStore(s => s.updateAgent);
  const pushFeed = useStore(s => s.pushFeed);
  const idleTimerRef = useRef<number | null>(null);

  const scheduleIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
    }
    idleTimerRef.current = window.setTimeout(() => {
      // No new tool calls for ~4 s → assume the model went idle
      updateAgent(agentId, {
        status: 'idle',
        action: 'awaiting',
        description: 'on standby',
        carrying: undefined,
        currentStation: 'desk'
      });
    }, 4000) as unknown as number;
  }, [agentId, updateAgent]);

  const cancelIdle = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current);
      idleTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      if (idleTimerRef.current !== null) {
        window.clearTimeout(idleTimerRef.current);
      }
    };
  }, []);

  return useCallback((chunk: string) => {
    const text = chunk.replace(ANSI_RE, '');
    if (!text.trim()) return;

    // The "esc to interrupt" footer is only shown while a turn is in progress.
    const running = /esc to interrupt/i.test(text);

    let lastTool: string | null = null;
    let lastArg: string | null = null;

    TOOL_RE.lastIndex = 0;
    for (let m: RegExpExecArray | null; (m = TOOL_RE.exec(text)) !== null; ) {
      lastTool = m[1];
      lastArg = (m[2] ?? '').trim();
    }

    if (lastTool) {
      const station = TOOL_TO_STATION[lastTool] ?? 'desk';
      const carrying = TOOLKIND_BY_NAME[lastTool] ?? undefined;
      const summary = lastArg ? `${lastTool.toLowerCase()} ${lastArg}` : lastTool.toLowerCase();
      updateAgent(agentId, {
        status: 'working',
        action: summary,
        description: summary,
        currentStation: station,
        carrying,
        progress: 0  // we can grow this with a counter later
      });
      // Mirror into the in-app feed so the mock terminal view shows it too if
      // ever toggled — harmless for real ptys.
      pushFeed(agentId, `\x1b[36m● ${lastTool}\x1b[0m ${lastArg ?? ''}`);
      // Keep working while the spinner is up; otherwise allow the idle drift.
      if (running) cancelIdle(); else scheduleIdle();
      return;
    }

    // Actively running but no fresh tool line (model is thinking / streaming
    // prose) → keep the agent working at its desk, don't let it drift to idle.
    if (running) {
      cancelIdle();
      updateAgent(agentId, { status: 'working' });
      return;
    }

    // Not running and no fresh tool line → the turn finished. Approval prompts and
    // free-text questions are surfaced via Claude Code hooks (the PreToolUse
    // permission gate + Notification), not by scraping the terminal — so just let
    // the avatar drift to idle.
    scheduleIdle();
  }, [agentId, updateAgent, pushFeed, scheduleIdle, cancelIdle]);
}
