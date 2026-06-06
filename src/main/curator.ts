/**
 * Curator — the background skill-maintenance loop (the Hermes curator, OfficeVibe-style).
 *
 * Runs in the Electron main process. Two triggers: a steady interval, and a debounced
 * pulse from the Stop hook (`onAgentIdle`) so it reacts shortly after work finishes.
 * Each cycle:
 *   1. promote agent-drafted proposals into real skills  (KnowledgeManager.promoteProposals)
 *   2. age idle skills: active→stale→archived             (KnowledgeManager.runLifecycle)
 *   3. occasionally, a READ-ONLY `claude -p` consolidation pass that returns a JSON plan
 *      (merge overlapping skills into umbrellas / archive redundant ones); the plan is
 *      applied deterministically by TS with a pre-mutation backup. The LLM never writes
 *      files — safer for autonomous operation. Budget-gated on the captured 5h/7d usage.
 *
 * Mirrors the headless `claude -p` pattern in assistant.ts (Dwight) and the interval/
 * silent-degrade pattern in memory.ts. Best-effort throughout.
 */
import { spawn } from 'node:child_process';
import { resolveCommand, userShellPath } from './shellEnv';
import type { HarnessConfig } from './config';
import type { KnowledgeManager, CuratorPlan, SkillIndexEntry } from './knowledge';
import type { MemoryManager } from './memory';
import type { UsageLimits } from './project';

const CONSOLIDATE_TIMEOUT_MS = 180_000;       // hard cap on the headless curator run
const IDLE_DEBOUNCE_MS = 45_000;              // collapse a burst of agent stops into one cycle
const CONSOLIDATE_EVERY_MS = 6 * 60 * 60 * 1000; // run the (paid) LLM pass at most this often
const MIN_SKILLS_TO_CONSOLIDATE = 6;          // below this, there's nothing worth merging

export class Curator {
  private intervalTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private running = false;
  private lastConsolidateAt = 0;

  constructor(
    private getHome: () => string | null,
    private getConfig: () => HarnessConfig,
    private knowledge: KnowledgeManager,
    private memory: MemoryManager,
    private getUsageLimits: () => UsageLimits | null
  ) {}

  enabled(): boolean {
    return this.getConfig().skillLearning !== false && this.getHome() !== null;
  }

  start(): void {
    if (this.intervalTimer || !this.enabled()) return;
    const mins = Math.max(5, this.getConfig().curatorIntervalMinutes ?? 60);
    this.intervalTimer = setInterval(() => { void this.runCycle('interval'); }, mins * 60_000);
    this.intervalTimer.unref();
    // A gentle first pass ~30s after boot: promote anything pending, age stale skills.
    const boot = setTimeout(() => { void this.runCycle('boot'); }, 30_000);
    boot.unref();
  }

  stop(): void {
    if (this.intervalTimer) { clearInterval(this.intervalTimer); this.intervalTimer = null; }
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** Debounced trigger from the Stop hook — a burst of idles collapses into one cycle. */
  onAgentIdle(_agentId: string): void {
    if (!this.enabled()) return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => { this.idleTimer = null; void this.runCycle('idle'); }, IDLE_DEBOUNCE_MS);
    this.idleTimer.unref();
  }

  async runCycle(trigger: string): Promise<void> {
    if (!this.enabled() || this.running) return;
    this.running = true;
    try {
      const promoted = this.knowledge.promoteProposals();
      const aged = this.knowledge.runLifecycle();
      if (promoted || aged) console.log(`[curator] ${trigger}: promoted ${promoted} proposal(s), aged ${aged} skill(s)`);

      // LLM consolidation — periodic, budget-gated, only once the library is big enough.
      const now = Date.now();
      const skills = this.knowledge.listSkills();
      const due = now - this.lastConsolidateAt > CONSOLIDATE_EVERY_MS;
      if (due && skills.length >= MIN_SKILLS_TO_CONSOLIDATE && this.withinBudget()) {
        this.lastConsolidateAt = now;
        const plan = await this.runConsolidationLLM(skills);
        if (plan) {
          const ops = this.knowledge.applyCuratorPlan(plan);
          if (ops) console.log(`[curator] consolidation applied ${ops} op(s)`);
        }
      }
    } catch (e) {
      console.error('[curator] cycle failed:', e);
    } finally {
      this.running = false;
    }
  }

  /** Skip the paid consolidation when the subscription is already running hot. */
  private withinBudget(): boolean {
    const ceiling = this.getConfig().curatorUsageCeilingPercent ?? 80;
    const u = this.getUsageLimits();
    if (!u) return true; // usage unknown → allow
    const five = u.fiveHour?.usedPercent ?? 0;
    const seven = u.sevenDay?.usedPercent ?? 0;
    return five < ceiling && seven < ceiling;
  }

  private runConsolidationLLM(skills: SkillIndexEntry[]): Promise<CuratorPlan | null> {
    return new Promise((resolve) => {
      const dir = this.knowledge.knowledgeDir();
      if (!dir) { resolve(null); return; }
      const cfg = this.getConfig();
      const binary = (cfg.defaultCommand || 'claude').trim().split(/\s+/)[0] || 'claude';
      const exe = resolveCommand(binary);
      // Read-only (Dwight's disallowed-tools): the model only analyzes and returns a plan;
      // TS applies it with a backup. No --model → the subscription default (no surprise cost).
      const args = [
        '-p', this.buildConsolidationPrompt(skills),
        '--output-format', 'json',
        '--permission-mode', 'bypassPermissions',
        '--disallowedTools', 'Edit', 'Write', 'NotebookEdit',
        '--add-dir', dir
      ];

      let child;
      try {
        child = spawn(exe, args, {
          cwd: dir,
          env: { ...process.env, PATH: userShellPath(), ...this.memory.env() } as Record<string, string>,
          stdio: ['ignore', 'pipe', 'pipe']
        });
      } catch (e) {
        console.error('[curator] spawn failed:', e);
        resolve(null);
        return;
      }

      let stdout = '';
      let settled = false;
      const finish = (v: CuratorPlan | null): void => { if (settled) return; settled = true; clearTimeout(timer); resolve(v); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* noop */ } finish(null); }, CONSOLIDATE_TIMEOUT_MS);
      child.stdout?.on('data', (d) => { stdout += d.toString(); });
      child.on('error', () => finish(null));
      child.on('close', () => finish(this.parsePlan(stdout)));
    });
  }

  /** Extract the JSON plan from `claude -p --output-format json` (result text → JSON). */
  private parsePlan(stdout: string): CuratorPlan | null {
    const raw = stdout.trim();
    if (!raw) return null;
    let text = raw;
    try { const obj = JSON.parse(raw) as { result?: unknown }; if (typeof obj.result === 'string') text = obj.result; }
    catch { /* not the JSON envelope — treat stdout as the plan text */ }
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fence) text = fence[1];
    try {
      const plan = JSON.parse(text.trim()) as CuratorPlan;
      return plan && typeof plan === 'object' ? plan : null;
    } catch {
      return null;
    }
  }

  private buildConsolidationPrompt(skills: SkillIndexEntry[]): string {
    const list = skills
      .map((s) => `- ${s.slug} [${s.state}] :: ${s.title} — ${s.desc} (tags: ${(s.tags ?? []).join(', ') || 'none'})`)
      .join('\n');
    return [
      'You are the KNOWLEDGE CURATOR for a team of AI agents sharing ONE software project. Over time they',
      'accumulate small, overlapping "skills" (reusable how-to notes). Your job: find clusters that overlap',
      'or near-duplicate and MERGE them into a single broader "umbrella" skill, and ARCHIVE anything redundant,',
      'obsolete, or too trivial to keep. Do NOT invent new knowledge — only reorganize what already exists. You',
      'may read any SKILL.md under .claude/skills/ in your working directory to inspect the full bodies.',
      '',
      'Current skills:',
      list,
      '',
      'Return ONLY a JSON object (no prose, no code fences) of EXACTLY this shape:',
      '{"merge":[{"umbrella":"slug-or-new-kebab","title":"short title","description":"<=80 chars","absorb":["slugA","slugB"],"body":"# Title\\nmerged markdown that subsumes the absorbed skills, with labeled subsections + gotchas"}],"archive":["slug-to-retire"]}',
      'Rules: reference ONLY slugs from the list above; an umbrella MAY reuse one of the absorbed slugs; be',
      'conservative (merge only genuinely overlapping skills); if nothing should change, return {"merge":[],"archive":[]}.'
    ].join('\n');
  }
}
