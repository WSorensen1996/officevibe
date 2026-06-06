import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolveCommand, userShellPath } from './shellEnv';

/**
 * Michael's silent prep assistant.
 *
 * Runs a one-shot, headless `claude -p` session on the subscription's default
 * model (no `--model` unless one is explicitly passed) that NEVER appears on the
 * office floor or in the agent list. Given a short, possibly
 * vague instruction the user parked for Michael, it locates the relevant project
 * directory (it starts in Michael's home and can read every registered repo),
 * gathers concrete context read-only, and rewrites the instruction into a
 * single self-contained prompt Michael can execute autonomously.
 *
 * The result text replaces the queued message, so the existing queue→PTY flush
 * delivers the enriched prompt to Michael with no extra plumbing.
 */

const DEFAULT_TIMEOUT_MS = 180_000;
/** Task enrich is a single-turn, no-tool rewrite now — it no longer explores the
 *  repo, so it never needs minutes. Keep a tight cap for the interactive button. */
const TASK_TIMEOUT_MS = 45_000;

/** Task enrich always runs on a fast, cheap model regardless of the user's agent
 *  default (cfg.defaultModel may be Opus and carries a [1m] suffix Haiku has no
 *  variant of). Haiku 4.5's 200K context is ample for a memories-fed rewrite. */
const ENRICH_MODEL = 'claude-haiku-4-5';

export interface EnrichRequest {
  /** The raw instruction the user wants enriched. */
  message: string;
  /** Michael's working directory — the assistant's default cwd. */
  cwd: string;
  /** Registered project repos the assistant may read to gather context. */
  repos?: string[];
  /** Base claude command from config (only its binary name is used). */
  command?: string;
  /** Optional model override. When unset, no `--model` flag is passed, so the
   *  run uses the subscription's default model (avoids surprise per-model cost). */
  model?: string;
  /** Hard cap so a runaway run can't wedge the queue. */
  timeoutMs?: number;
  /** Extra env merged over the resolved shell env (e.g. the shared MemPalace). */
  env?: Record<string, string>;
  /**
   * Which system prompt to build. 'message' (default) is Michael's executor
   * prep prompt used by the queue→PTY flow. 'task' produces a self-contained
   * Kanban task description for a human to read and later dispatch.
   */
  mode?: 'message' | 'task';
  /**
   * Relevant team memories (mempalace search output) used as the ONLY context
   * source for a 'task' enrich — it replaces repo exploration. Ignored by the
   * 'message' path, which still explores the repo read-only.
   */
  memories?: string;
}

export interface EnrichResult {
  ok: boolean;
  /** The enriched, self-contained prompt for Michael. */
  prompt?: string;
  error?: string;
}

function buildTaskPrompt(message: string, cwd: string, repos: string[]): string {
  const repoList = repos.length
    ? repos.map((r) => `  - ${r}`).join('\n')
    : '  (none registered — work from the home directory above)';
  return [
    "You are Michael's silent prep assistant inside the OfficeVibe agent harness.",
    'Michael is the orchestrator who will act on the prompt you produce — autonomously, with no human in the loop.',
    'You are NOT visible to the user and you do NOT perform the task yourself. Your only job is to turn a short,',
    'possibly vague instruction into a single, self-contained, context-rich prompt that Michael can execute immediately.',
    '',
    `Your working directory is Michael's home: ${cwd}`,
    'Project repositories you may read to gather context (cd into the relevant one):',
    repoList,
    '',
    'Do this:',
    '1. Decide which project/directory this instruction concerns and cd into the most relevant repo',
    '   (or stay in the home directory if it is a hive/coordination task).',
    '2. Explore READ-ONLY to gather the concrete context Michael needs: exact file paths, current state,',
    '   relevant code, conventions, the active branch, and any constraints or gotchas. NEVER modify, create,',
    '   or delete files, and never run destructive or write commands.',
    "3. Rewrite the instruction into ONE clear prompt for Michael. Preserve the user's original intent exactly —",
    '   do not invent new scope. State the target directory, the specific files/symbols involved, the concrete',
    '   goal, and anything you discovered that Michael should know before starting.',
    '',
    'Output ONLY the final prompt text for Michael. No preamble, no explanation, no markdown code fences,',
    'no "Here is the prompt". Just the prompt itself.',
    '',
    '--- ORIGINAL INSTRUCTION FROM THE USER ---',
    message
  ].join('\n');
}

/**
 * Task-board variant of the prep prompt. Unlike `buildTaskPrompt`, this is
 * agent-agnostic: it produces a self-contained Kanban task DESCRIPTION that a
 * human reads on a card and later dispatches — not a prompt addressed to Michael.
 *
 * It does NOT explore the repo. Its only external context is the team memories
 * passed in (mempalace search output), so the whole thing is a single, fast,
 * no-tool rewrite. When no memories are available it rewrites from the user's
 * intent alone rather than inventing project-specific facts.
 */
function buildTaskDescriptionPrompt(message: string, memories?: string): string {
  const mem = (memories ?? '').trim();
  const memSection = mem
    ? [
        '--- RELEVANT TEAM MEMORIES (your ONLY external context) ---',
        mem,
        '--- END MEMORIES ---',
        ''
      ]
    : [
        '(No team memories were available for this request. Work from the user\'s',
        ' request alone — do NOT invent project-specific facts you cannot support.)',
        ''
      ];
  return [
    'You are a fast, read-only planning assistant. You rewrite a short task request into a precise,',
    'self-contained task description for a software task board that a human will read and later',
    'dispatch. You do NOT perform the task and you are NOT an executor for any specific agent.',
    '',
    'CRITICAL CONSTRAINTS:',
    '- Do NOT use any tools. Do NOT read files, run commands, search the web, or explore a',
    '  repository. You have no filesystem or shell access. Respond from the inputs below only.',
    '- Your ONLY sources are the user request and the team memories (if any) below.',
    "- Preserve the user's original intent exactly. Do NOT invent new scope, files, features, or",
    '  requirements they did not ask for.',
    '- When the memories contain concrete specifics (file paths, symbols, conventions, current',
    '  state), use them. When they do not, keep that section general or omit it rather than guessing.',
    '',
    ...memSection,
    'Structure the description with these sections (omit a section if it would be pure speculation',
    'given your inputs):',
    '- Goal: one or two sentences stating what should be accomplished.',
    '- Relevant files/paths: specific files, directories, or symbols — ONLY if grounded in the',
    '  memories or the request. Omit if unknown.',
    '- Current state: what exists today that is relevant — ONLY if grounded. Omit if unknown.',
    '- Constraints: conventions, patterns, or limits the implementer must respect.',
    '- Acceptance criteria: a short checklist of what "done" looks like.',
    '',
    'Output ONLY the task description text. No preamble, no explanation, no markdown code fences,',
    'no "Here is the task". Just the description itself. Keep it tight — context-rich but not padded.',
    '',
    '--- ORIGINAL REQUEST FROM THE USER ---',
    message
  ].join('\n');
}

/** Pull the final assistant text out of `claude -p --output-format json`. */
function parsePrompt(stdout: string): string | null {
  const raw = stdout.trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as { result?: unknown; text?: unknown };
    const text = typeof obj.result === 'string' ? obj.result
      : typeof obj.text === 'string' ? obj.text
      : null;
    if (text && text.trim()) return text.trim();
  } catch { /* not JSON — fall back to the raw stdout below */ }
  return raw;
}

export function enrichMessage(req: EnrichRequest): Promise<EnrichResult> {
  return new Promise((resolve) => {
    const message = (req.message ?? '').trim();
    if (!message) { resolve({ ok: false, error: 'empty message' }); return; }
    if (!req.cwd || !existsSync(req.cwd)) {
      resolve({ ok: false, error: `working directory does not exist: ${req.cwd}` });
      return;
    }

    const isTask = req.mode === 'task';
    const binary = (req.command || 'claude').trim().split(/\s+/)[0] || 'claude';
    const exe = resolveCommand(binary);
    const taskPrompt = isTask
      ? buildTaskDescriptionPrompt(message, req.memories)
      : buildTaskPrompt(message, req.cwd, req.repos ?? []);

    // We build the flag set ourselves (rather than reusing config's command
    // string) so the assistant's behaviour is fixed regardless of the user's
    // autoMode / defaultCommand: headless print mode, read-only.
    const args = [
      '-p', taskPrompt,
      // Task enrich is pinned to a fast model; the legacy message path keeps the
      // configured model (unset → CLI/subscription default, no surprise cost).
      ...(isTask ? ['--model', ENRICH_MODEL] : (req.model ? ['--model', req.model] : [])),
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions'
    ];
    if (isTask) {
      // Single-turn rewrite from the supplied memories: forbid every tool so the
      // model cannot read files, run bash, or search — it answers from the prompt
      // alone. This variadic flag is last, so nothing follows it to be swallowed.
      args.push('--disallowedTools',
        'Bash', 'Read', 'Glob', 'Grep', 'Edit', 'Write', 'NotebookEdit',
        'WebFetch', 'WebSearch', 'Task', 'TodoWrite');
    } else {
      // Legacy executor-prep: read-only repo exploration to gather context. These
      // are separate args because the CLI flag is variadic (<tools...>).
      args.push('--disallowedTools', 'Edit', 'Write', 'NotebookEdit');
      const repos = (req.repos ?? []).filter((r) => r && existsSync(r) && r !== req.cwd);
      // --add-dir comes last so it terminates the variadic --disallowedTools list.
      for (const r of repos) { args.push('--add-dir', r); }
    }

    let child;
    try {
      child = spawn(exe, args, {
        cwd: req.cwd,
        env: {
          ...process.env,
          PATH: userShellPath(),
          ...(req.env ?? {})
        } as Record<string, string>,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (e) {
      resolve({ ok: false, error: e instanceof Error ? e.message : String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (r: EnrichResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* noop */ }
      finish({ ok: false, error: 'enrichment timed out' });
    }, req.timeoutMs ?? (isTask ? TASK_TIMEOUT_MS : DEFAULT_TIMEOUT_MS));

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (e) => finish({ ok: false, error: e.message }));
    child.on('close', (code) => {
      const prompt = parsePrompt(stdout);
      if (prompt) { finish({ ok: true, prompt }); return; }
      finish({ ok: false, error: stderr.trim() || `assistant exited ${code ?? '?'} with no output` });
    });
  });
}
