import { spawn } from 'node:child_process';

/** Run git in `cwd` with `args`. Returns stdout text or an error. */
function runGit(cwd: string, args: string[], timeoutMs = 8000): Promise<{
  ok: true; stdout: string;
} | { ok: false; error: string }> {
  return new Promise((resolve) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch { /* noop */ }
    }, timeoutMs);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', e => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message });
    });
    proc.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve({ ok: true, stdout });
      else resolve({ ok: false, error: stderr.trim() || `git exited ${code}` });
    });
  });
}

export interface GitBranchInfo {
  current: string | null;
  detached: boolean;
}

export async function getBranch(cwd: string): Promise<GitBranchInfo | { error: string }> {
  const head = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (!head.ok) return { error: head.error };
  const name = head.stdout.trim();
  if (name === 'HEAD') return { current: null, detached: true };
  return { current: name, detached: false };
}

/** Best-effort detect: is `cwd` actually a git repo? */
export async function isRepo(cwd: string): Promise<boolean> {
  const res = await runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return res.ok && res.stdout.trim() === 'true';
}

/** Derive a safe `agent/<id>` branch name from a worktree path's basename. */
function agentBranchFor(wtPath: string): string {
  const base = wtPath.split(/[\\/]/).filter(Boolean).pop() ?? 'agent';
  const slug = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'agent';
  return `agent/${slug}`;
}

/** Provision an isolated git worktree for an agent at `wtPath`, branching off
 *  `baseBranch`. Tries to create a fresh `agent/<id>` branch first; if that
 *  branch already exists, falls back to checking out `baseBranch` directly. */
export async function addWorktree(
  cwd: string, wtPath: string, baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  const branch = agentBranchFor(wtPath);
  const fresh = await runGit(cwd, ['worktree', 'add', wtPath, '-b', branch, baseBranch]);
  if (fresh.ok) return { ok: true };
  // Branch likely already exists (or the path is taken) — retry without -b.
  const fallback = await runGit(cwd, ['worktree', 'add', wtPath, baseBranch]);
  if (fallback.ok) return { ok: true };
  return { ok: false, error: fallback.error };
}

/** Best-effort removal of an agent's worktree. Forced so a dirty tree doesn't
 *  block teardown; failures are surfaced but callers may ignore them. */
export async function removeWorktree(
  cwd: string, wtPath: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await runGit(cwd, ['worktree', 'remove', '--force', wtPath]);
  if (res.ok) return { ok: true };
  return { ok: false, error: res.error };
}
