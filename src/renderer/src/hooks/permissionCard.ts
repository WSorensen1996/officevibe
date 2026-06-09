/**
 * Build the "needs you" approval card for a PreToolUse permission request straight
 * from Claude Code's structured `tool_input` — no terminal scraping. The card's
 * Approve/Deny actions are wired to the permission hook via `requestId` + `decision`
 * (see NeedsYouCard), so a click resolves the exact tool call the agent is blocked on.
 */
import type { BlockReason } from '@/store/store';

/** The structured PreToolUse payload the main process forwards for an approval. */
export interface PermissionRequest {
  requestId: string;
  agentId?: string;
  tool: string;
  input?: unknown;
  cwd?: string;
  /** Hybrid model: true when the action is destructive/outbound (delete, push,
   *  payment, external send) — the only class that surfaces a card under autoMode. */
  risky?: boolean;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function clip(s: string, n = 160): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/** A human-readable headline + an optional exact-action line for a tool call. */
export function permissionCard(req: PermissionRequest): BlockReason {
  const input = asRecord(req.input);
  let summary = `Approve ${req.tool}?`;
  let command: string | undefined;

  switch (req.tool) {
    case 'Bash': {
      summary = 'Run a command';
      command = str(input.command) && clip(str(input.command)!);
      break;
    }
    case 'Write': {
      const fp = str(input.file_path);
      summary = fp ? `Write ${fp}` : 'Write a file';
      break;
    }
    case 'Edit':
    case 'MultiEdit': {
      const fp = str(input.file_path);
      summary = fp ? `Edit ${fp}` : 'Edit a file';
      const oldS = str(input.old_string);
      const newS = str(input.new_string);
      if (oldS != null || newS != null) command = clip(`- ${oldS ?? ''}   +  ${newS ?? ''}`);
      break;
    }
    case 'NotebookEdit': {
      const fp = str(input.notebook_path);
      summary = fp ? `Edit notebook ${fp}` : 'Edit a notebook';
      break;
    }
    case 'WebFetch': {
      summary = 'Fetch a URL';
      command = str(input.url) && clip(str(input.url)!);
      break;
    }
    default: {
      summary = req.tool.startsWith('mcp__')
        ? `Use ${req.tool.replace(/^mcp__/, '').replace(/__/g, ' · ')}`
        : `Use ${req.tool}`;
      // Best-effort one-line view of the args.
      try {
        const j = JSON.stringify(req.input);
        if (j && j !== '{}' && j !== 'null') command = clip(j);
      } catch { /* unserializable — skip */ }
    }
  }

  return {
    summary: req.risky ? `⚠ Risky · ${summary}` : summary,
    detail: req.risky
      ? 'This is a destructive or outbound action. Approve to let the agent proceed, or deny and tell it what to do instead.'
      : 'Approve to let the agent proceed, or deny and tell it what to do instead.',
    command: command || undefined,
    promptKind: 'menu',
    requestId: req.requestId,
    actions: [
      { label: 'Approve', kind: 'approve', decision: 'allow' },
      { label: 'Deny', kind: 'deny', decision: 'deny' }
    ]
  };
}
