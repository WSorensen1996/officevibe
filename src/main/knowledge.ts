/**
 * KnowledgeManager — the per-project, team-shared SKILL library (the "Project Brain").
 *
 * A layer on top of the existing facts memory (memory.md + MemPalace): reusable
 * *procedures* the team distils from experience, stored as native Claude Code skills
 * so agents auto-discover them (via the spawn's `--add-dir <project>/knowledge`) with
 * progressive disclosure. This class owns the on-disk library and the FAST, in-process
 * ranking the hook server injects at task start. It never spawns a subprocess on the
 * hot path (the hook shim self-kills after 5s).
 *
 * On-disk layout (under the active project folder, so it's wiped with the project):
 *   knowledge/
 *     .claude/skills/<slug>/SKILL.md   native skill (name + description + body)
 *     index.json                       [{slug,title,desc,tags,state}] — ranking source
 *     usage.json                       { [slug]: SkillUsage } — telemetry + provenance
 *     proposals/                       agent-drafted skills, staged before promotion
 *     .archive/                        archived skills (never deleted)
 *     .backups/<utc>/                  pre-curation snapshots
 *
 * Runs in the Electron main process. Best-effort throughout: any IO failure degrades
 * to "no skills" rather than throwing into a hook or spawn.
 */
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, cpSync, rmSync
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { slugify, type HarnessConfig } from './config';

export type SkillState = 'provisional' | 'active' | 'stale' | 'archived';

/** The cheap, always-loaded index used for hot-path ranking. */
export interface SkillIndexEntry {
  slug: string;
  title: string;
  /** One-line, clamped to 80 chars — what it does. */
  desc: string;
  tags: string[];
  state: SkillState;
  /** Set for deliverables an agent wrote as a bare `knowledge/<file>.md` (vs a
   *  native `.claude/skills/<slug>/SKILL.md`). Points at the body file relative
   *  to `knowledge/`. Absent for native skills. */
  path?: string;
}

/** Per-skill telemetry + provenance (the curator's source of truth).
 *  Mirrors hermes-agent's `.usage.json`: use/view/patch counts each with their own
 *  last-* timestamp, plus `last_injected_at` so the lifecycle can keep a skill that's
 *  being surfaced every task alive even if it isn't opened. */
export interface SkillUsage {
  slug: string;
  title: string;
  created_at: string;            // ISO
  last_used_at: string | null;   // ISO; null until first genuine use (Skill-tool/body-read)
  use_count: number;
  inject_count: number;
  /** Times an agent loaded/opened the skill (body read or native Skill-tool view). */
  view_count: number;
  last_viewed_at: string | null;
  /** Last time the skill appeared in an injected inventory (recall surfacing). */
  last_injected_at: string | null;
  /** Times the skill was corrected in-flight via a skill-patch. */
  patch_count: number;
  last_patched_at: string | null;
  state: SkillState;
  created_by: string;            // agent id, 'curator', or 'human'
  pinned: boolean;               // pinned skills are exempt from auto-archival
}

/** One row for the admin UI: the index entry joined with its usage telemetry. */
export interface SkillAdminRow {
  slug: string;
  title: string;
  desc: string;
  tags: string[];
  state: SkillState;
  created_by: string;
  pinned: boolean;
  created_at: string;
  last_used_at: string | null;
  use_count: number;
  inject_count: number;
  view_count: number;
  patch_count: number;
}

/** A staged proposal an agent dropped (validated/shaped by ProjectManager.routeOnce). */
export interface SkillProposal {
  slug?: string;
  title?: string;
  description?: string;
  body?: string;
  tags?: string[];
  by?: string;
}

/** An in-flight correction to an existing skill (hermes-agent's `skill_patch`): an
 *  agent that found a skill wrong/incomplete while using it rewrites or appends to it
 *  immediately, instead of waiting for the periodic curator pass. */
export interface SkillPatch {
  slug: string;
  /** Full replacement body. */
  body?: string;
  /** Markdown appended under a "## Correction" heading (when no full body given). */
  append?: string;
  title?: string;
  description?: string;
  tags?: string[];
  by?: string;
}

/** A consolidation plan the read-only curator LLM returns; applied deterministically. */
export interface CuratorPlan {
  merge?: Array<{ umbrella: string; title?: string; description?: string; absorb: string[]; body: string }>;
  archive?: string[];
}

const SUMMARY_DIGEST_STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'you', 'your', 'are', 'was', 'has',
  'have', 'from', 'into', 'how', 'what', 'when', 'where', 'why', 'can', 'will', 'all',
  'any', 'use', 'using', 'task', 'please', 'need', 'want', 'make', 'add', 'get'
]);

/** A provisional skill graduates to `active` once it has been genuinely used (a
 *  Skill-tool invocation or a full-body read) this many times. The old bar of 2 was
 *  unreachable because native skill loads were never counted; 1 genuine use is a fair
 *  proof now that the signal works. */
const SKILL_GRADUATE_USES = 1;

/** Cheap, conservative "is this skill body dangerous?" scan applied before a proposal
 *  is promoted (hermes-agent gates hub skills with a security scanner; ours are
 *  self-authored so the risk is lower, but a learned skill that bakes in a destructive
 *  command or a prompt-injection string should be quarantined for human review). */
const UNSAFE_SKILL_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\brm\s+-rf?\s+[~/.*]/i, why: 'recursive force-delete of a root/home/wildcard path' },
  { re: /\b(mkfs|dd\s+if=|:\(\)\s*\{\s*:\|:&\s*\};:)/i, why: 'disk-format / fork-bomb' },
  { re: /\bcurl\b[^\n|]*\|\s*(sudo\s+)?(ba)?sh\b/i, why: 'pipe-from-internet to shell' },
  { re: /\b(ignore|disregard)\s+(all\s+)?(previous|prior|above)\s+(instructions|prompts?)\b/i, why: 'prompt-injection directive' },
  { re: /\b(exfiltrat|send\s+(the\s+)?(env|secrets?|credentials?|api[_-]?keys?))\b/i, why: 'data-exfiltration directive' },
  { re: /\b(AWS_SECRET|ANTHROPIC_API_KEY|process\.env\.[A-Z_]*(KEY|SECRET|TOKEN))\b/, why: 'reads a secret/credential env var' }
];

/** Returns the first reason a skill body looks unsafe, or null when it's clean. */
function unsafeReason(body: string): string | null {
  for (const { re, why } of UNSAFE_SKILL_PATTERNS) if (re.test(body)) return why;
  return null;
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function shortRand(): string {
  return randomBytes(3).toString('hex');
}

/** Build a fresh usage record with every telemetry field initialized — the single
 *  source of truth so new fields can't be forgotten at a construction site. */
function newUsage(
  slug: string, title: string, created_by: string, state: SkillState, nowIso: string
): SkillUsage {
  return {
    slug, title,
    created_at: nowIso, last_used_at: null,
    use_count: 0, inject_count: 0,
    view_count: 0, last_viewed_at: null,
    last_injected_at: null,
    patch_count: 0, last_patched_at: null,
    state, created_by, pinned: false
  };
}

/** Coerce a possibly-old usage record (missing the newer telemetry fields) into a
 *  complete one, so reads of a pre-upgrade usage.json never produce NaN/undefined. */
function fillUsage(u: Partial<SkillUsage> & { slug: string }): SkillUsage {
  return {
    slug: u.slug,
    title: u.title ?? u.slug,
    created_at: u.created_at ?? '',
    last_used_at: u.last_used_at ?? null,
    use_count: u.use_count ?? 0,
    inject_count: u.inject_count ?? 0,
    view_count: u.view_count ?? 0,
    last_viewed_at: u.last_viewed_at ?? null,
    last_injected_at: u.last_injected_at ?? null,
    patch_count: u.patch_count ?? 0,
    last_patched_at: u.last_patched_at ?? null,
    state: u.state ?? 'provisional',
    created_by: u.created_by ?? 'agent',
    pinned: u.pinned ?? false
  };
}

export class KnowledgeManager {
  constructor(
    private getHome: () => string | null,
    private getConfig: () => HarnessConfig
  ) {}

  // — config + paths —

  enabled(): boolean {
    return this.getConfig().skillLearning !== false && this.getHome() !== null;
  }
  knowledgeDir(): string | null {
    const h = this.getHome();
    return h ? join(h, 'knowledge') : null;
  }
  skillsDir(): string | null {
    const k = this.knowledgeDir();
    return k ? join(k, '.claude', 'skills') : null;
  }
  private indexPath(): string | null { const k = this.knowledgeDir(); return k ? join(k, 'index.json') : null; }
  private usagePath(): string | null { const k = this.knowledgeDir(); return k ? join(k, 'usage.json') : null; }
  private proposalsDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, 'proposals') : null; }
  private patchesDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, 'patches') : null; }
  private archiveDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, '.archive') : null; }
  private backupsDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, '.backups') : null; }
  /** Browsable project documents (investigations, briefs, research) — NOT recallable
   *  skills. Kept out of `.claude/skills/` so they never pollute skill injection. */
  deliverablesDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, 'deliverables') : null; }
  private curatorStatePath(): string | null { const k = this.knowledgeDir(); return k ? join(k, '.curator-state.json') : null; }
  private curatorLogsDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, 'logs', 'curator') : null; }

  /** Create the library skeleton + seed empty index/usage. Idempotent; no-op when disabled. */
  ensureScaffold(): void {
    if (!this.enabled()) return;
    const skills = this.skillsDir();
    const proposals = this.proposalsDir();
    const idx = this.indexPath();
    const usage = this.usagePath();
    if (!skills || !proposals || !idx || !usage) return;
    try {
      mkdirSync(skills, { recursive: true });
      mkdirSync(join(proposals, '.done'), { recursive: true });
      mkdirSync(this.archiveDir()!, { recursive: true });
      mkdirSync(this.backupsDir()!, { recursive: true });
      mkdirSync(this.deliverablesDir()!, { recursive: true });
      mkdirSync(this.curatorLogsDir()!, { recursive: true });
      if (!existsSync(idx)) this.writeJson(idx, [] as SkillIndexEntry[]);
      if (!existsSync(usage)) this.writeJson(usage, {} as Record<string, SkillUsage>);
      const moved = this.migrateBareDeliverables();
      if (moved) console.log(`[knowledge] filed ${moved} orphan deliverable(s) under deliverables/`);
    } catch (e) {
      console.error('[knowledge] ensureScaffold failed:', e);
    }
  }

  /** One-time tidy (idempotent): relocate any bare top-level knowledge/<file>.md that is
   *  neither a native skill nor referenced by an index entry's `path` into deliverables/,
   *  so stray investigation docs stop sitting beside the skill library. Never touches
   *  index-referenced files or native skills. Returns the number moved. */
  private migrateBareDeliverables(): number {
    const k = this.knowledgeDir();
    const dest = this.deliverablesDir();
    if (!k || !dest || !existsSync(k)) return 0;
    let moved = 0;
    try {
      const index = this.readIndex();
      const referenced = new Set(index.map((e) => (e.path ?? `${e.slug}.md`).split(/[/\\]/).pop()!));
      const skillSlugs = new Set(index.filter((e) => !e.path).map((e) => e.slug));
      const files = readdirSync(k).filter((f) => f.endsWith('.md'));
      for (const f of files) {
        const slug = this.sanitizeSlug(f.replace(/\.md$/i, ''));
        if (referenced.has(f) || skillSlugs.has(slug)) continue; // keep registered/referenced
        mkdirSync(dest, { recursive: true });
        const target = join(dest, f);
        if (existsSync(target)) continue; // already migrated a same-named file
        renameSync(join(k, f), target);
        moved++;
      }
    } catch (e) {
      console.error('[knowledge] migrateBareDeliverables failed:', e);
    }
    return moved;
  }

  // — hot path: ranking + injection (sync, in-process, no subprocess) —

  /** Top-k skills relevant to a prompt. Keyword overlap is required (≥1 hit); usage
   *  recency and state break ties. Returns [] when disabled/empty. Never throws. */
  rankForPrompt(prompt: string, k: number): SkillIndexEntry[] {
    if (!this.enabled() || !prompt) return [];
    const index = this.readIndex().filter((e) => e.state !== 'archived' && !e.path);
    if (index.length === 0) return [];
    const tokens = this.tokenize(prompt);
    if (tokens.length === 0) return [];
    const usage = this.readUsage();
    const now = Date.now();
    const scored = index.map((e) => {
      const hay = `${e.title} ${e.desc} ${(e.tags ?? []).join(' ')}`.toLowerCase();
      let hits = 0;
      for (const t of tokens) if (hay.includes(t)) hits++;
      if (hits === 0) return null;
      let score = hits * 2;
      const u = usage[e.slug];
      if (u) {
        score += Math.min(u.use_count, 5) * 0.2;
        if (u.last_used_at) {
          const days = (now - Date.parse(u.last_used_at)) / 86_400_000;
          if (days < 7) score += 0.5;
        }
      }
      if (e.state === 'provisional') score -= 0.3; // shown but down-weighted until proven
      if (e.state === 'stale') score -= 0.5;
      return { e, score };
    }).filter((x): x is { e: SkillIndexEntry; score: number } => x !== null);
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(0, k)).map((s) => s.e);
  }

  /** The `additionalContext` block injected on UserPromptSubmit. Hermes-style: the
   *  WHOLE active/provisional inventory (name + desc) is listed so the agent is never
   *  blind to a capability it owns, with the prompt's most-relevant skills HIGHLIGHTED
   *  at the top. The agent loads a skill's full procedure on demand via the native
   *  Skill tool (by slug). Bumps inject_count for everything shown. '' when empty. */
  injectionBlock(prompt: string): string {
    if (!this.enabled()) return '';
    // Only real skills (native SKILL.md) are recallable — bare deliverables (entries
    // with a `path`: briefs/research/investigations) are browsable in the admin tab but
    // never injected as skills. Order by use_count desc so that, if the inventory ever
    // exceeds the budget, the truncation drops the LEAST-used skills rather than whatever
    // happens to sit last in index.json.
    const usage = this.readUsage();
    const index = this.readIndex()
      .filter((e) => (e.state === 'active' || e.state === 'provisional') && !e.path)
      .sort((a, b) =>
        (usage[b.slug]?.use_count ?? 0) - (usage[a.slug]?.use_count ?? 0) ||
        (usage[b.slug]?.inject_count ?? 0) - (usage[a.slug]?.inject_count ?? 0));
    if (index.length === 0) return '';
    const budget = this.getConfig().skillInventoryTokenBudget ?? 3000;
    const highlightK = this.getConfig().maxInjectedSkills ?? 3;
    const ranked = this.rankForPrompt(prompt, highlightK);
    const highlight = new Set(ranked.map((p) => p.slug));
    const { lines, shownSlugs, omitted } = this.inventoryLines(index, highlight, budget);
    if (shownSlugs.length === 0) return '';
    this.bumpInject(shownSlugs);
    // When the task clearly matches a skill, NAME it and push hard to load it — the
    // dominant failure mode is agents acting on this one-line summary and never opening the
    // full procedure (which encodes the pitfalls/bugs the team already paid for).
    const top = ranked.find((p) => shownSlugs.includes(p.slug));
    const header = top
      ? `PROJECT SKILLS — reusable how-to the team learned for THIS project. ★ = directly relevant to your current task. You very likely have a skill for this: load "${top.title}" (${top.slug}) with the Skill tool and FOLLOW its Procedure/Pitfalls BEFORE writing your own — it captures bugs the team already hit. Other skills below; load any by name.`
      : 'PROJECT SKILLS — reusable how-to the team learned for THIS project. ★ = most relevant to your task. Before reinventing a procedure, load the skill\'s full text with the Skill tool (by its name/slug) and follow it.';
    return [
      header,
      ...lines,
      omitted > 0 ? `…and ${omitted} more — list them with the Skill tool if none above fit.` : ''
    ].filter(Boolean).join('\n');
  }

  /** A full-inventory overview injected on SessionStart so a fresh agent knows
   *  everything the team has learned (sorted by most-used), within the token budget. */
  sessionStartDigest(): string {
    if (!this.enabled()) return '';
    const index = this.readIndex().filter((e) => (e.state === 'active' || e.state === 'provisional') && !e.path);
    if (index.length === 0) return '';
    const usage = this.readUsage();
    const sorted = [...index].sort(
      (a, b) => (usage[b.slug]?.use_count ?? 0) - (usage[a.slug]?.use_count ?? 0)
    );
    const budget = this.getConfig().skillInventoryTokenBudget ?? 3000;
    const { lines, omitted } = this.inventoryLines(sorted, new Set(), budget);
    return [
      `This project has a shared SKILL library (${index.length} skill${index.length === 1 ? '' : 's'}) the team built from experience. Load any skill's full procedure with the Skill tool (by name) before reinventing it:`,
      ...lines,
      omitted > 0 ? `…and ${omitted} more.` : '',
      'You\'ll also get a per-task "★ most relevant" note.'
    ].filter(Boolean).join('\n');
  }

  /** Render an ordered inventory into bullet lines that fit a token budget (~4 chars/
   *  token). Highlighted slugs are starred and always sort first (preserving their
   *  incoming order); the rest follow in their incoming order. Returns the lines, the
   *  slugs actually shown (for inject-count bumping), and how many were dropped. */
  private inventoryLines(
    entries: SkillIndexEntry[], highlight: Set<string>, budgetTokens: number
  ): { lines: string[]; shownSlugs: string[]; omitted: number } {
    const ordered = [
      ...entries.filter((e) => highlight.has(e.slug)),
      ...entries.filter((e) => !highlight.has(e.slug))
    ];
    const charBudget = Math.max(0, budgetTokens) * 4;
    const lines: string[] = [];
    const shownSlugs: string[] = [];
    let used = 0;
    for (const e of ordered) {
      const mark = highlight.has(e.slug) ? '★' : '•';
      const desc = e.desc ? ` — ${e.desc}` : '';
      const line = `${mark} ${e.title} (${e.slug})${desc}`;
      if (used + line.length + 1 > charBudget && lines.length > 0) break;
      lines.push(line);
      shownSlugs.push(e.slug);
      used += line.length + 1;
    }
    return { lines, shownSlugs, omitted: ordered.length - shownSlugs.length };
  }

  /** Count a genuine use when an agent READS a skill's SKILL.md body (PostToolUse:Read).
   *  A body read is both a view and real reuse. */
  bumpUseForPath(absPath: string | undefined): void {
    if (!this.enabled() || !absPath) return;
    const dir = this.skillsDir();
    if (!dir || !absPath.startsWith(dir)) return;
    const rest = absPath.slice(dir.length).replace(/^[/\\]+/, '');
    const slug = rest.split(/[/\\]/)[0];
    if (!slug) return;
    this.applyUses([slug], true);
  }

  /** Count a genuine use when an agent invokes a skill via the native Skill tool. The
   *  identifiers are the Skill tool inputs (or skill names) seen in the finished turn's
   *  transcript — each is resolved to a known slug (by slug or title match), so we don't
   *  depend on the exact Skill-tool input shape. This is the DEFINITIVE reuse signal:
   *  native skill loads don't emit a Read, so without this use_count never moved. */
  bumpUseForSkills(identifiers: string[]): void {
    if (!this.enabled() || identifiers.length === 0) return;
    const slugs = this.resolveSlugs(identifiers);
    if (slugs.length) this.applyUses(slugs, true);
  }
  /** Single-name convenience for the PostToolUse:Skill hook branch. */
  bumpUseForSkillName(name: string | undefined): void {
    if (name) this.bumpUseForSkills([name]);
  }

  /** Resolve free-form identifiers (Skill-tool inputs / names) to known slugs. Prefers the
   *  EXPLICIT skill field from a stringified Skill-tool input ({"skill":"<slug>"} / name /
   *  command) so attribution is exact; only falls back to substring scanning when no
   *  structured field is present (older/odd input shapes). */
  private resolveSlugs(identifiers: string[]): string[] {
    const index = this.readIndex();
    const out = new Set<string>();
    for (const raw of identifiers) {
      const s = String(raw ?? '').trim();
      if (!s) continue;

      // 1) Explicit structured identifier (the common case: JSON.stringify of the Skill
      //    tool input). Read the canonical skill field rather than scanning the blob.
      let explicit = '';
      if (s.startsWith('{')) {
        try {
          const o = JSON.parse(s) as Record<string, unknown>;
          for (const key of ['skill', 'name', 'command', 'skillName', 'skill_name']) {
            const v = o[key];
            if (typeof v === 'string' && v.trim()) { explicit = v.trim(); break; }
          }
        } catch { /* not JSON — fall through to substring scan */ }
      } else {
        explicit = s; // a bare name/slug
      }
      if (explicit) {
        const norm = this.sanitizeSlug(explicit);
        const hit = index.find((e) => e.slug === norm || this.sanitizeSlug(e.title) === norm);
        if (hit) { out.add(hit.slug); continue; }
      }

      // 2) Fallback: substring scan over the raw identifier.
      const hay = s.toLowerCase();
      const norm = this.sanitizeSlug(s);
      for (const e of index) {
        const titleSlug = this.sanitizeSlug(e.title);
        if (norm === e.slug || hay.includes(e.slug) || (titleSlug && hay.includes(titleSlug))) out.add(e.slug);
      }
    }
    return [...out];
  }

  /** Apply N uses (and views) to a set of slugs, graduating provisional→active once a
   *  skill has been genuinely used SKILL_GRADUATE_USES times. Best-effort. */
  private applyUses(slugs: string[], alsoView: boolean): void {
    try {
      const usage = this.readUsage();
      const nowIso = new Date().toISOString();
      let touched = false;
      const graduate: string[] = [];
      for (const slug of slugs) {
        const u = usage[slug];
        if (!u) continue;
        u.use_count += 1;
        u.last_used_at = nowIso;
        if (alsoView) { u.view_count += 1; u.last_viewed_at = nowIso; }
        if (u.state === 'provisional' && u.use_count >= SKILL_GRADUATE_USES) {
          u.state = 'active';
          graduate.push(slug);
        }
        touched = true;
      }
      if (touched) this.writeJson(this.usagePath()!, usage);
      for (const slug of graduate) this.setIndexState(slug, 'active');
    } catch (e) {
      console.error('[knowledge] applyUses failed:', e);
    }
  }

  /** Idempotent safety net: graduate any provisional skill whose use_count already meets
   *  the threshold but never flipped to active. applyUses only evaluates graduation at the
   *  increment moment, so a use recorded under an older (higher) SKILL_GRADUATE_USES — or a
   *  state write that didn't stick — leaves the skill stuck `provisional` (and carrying the
   *  rankForPrompt down-weight) forever. Run cheaply every curator cycle. Returns how many
   *  graduated. */
  reconcileGraduations(): number {
    if (!this.enabled()) return 0;
    try {
      const usage = this.readUsage();
      const graduate: string[] = [];
      for (const [slug, u] of Object.entries(usage)) {
        if (u && u.state === 'provisional' && (u.use_count ?? 0) >= SKILL_GRADUATE_USES) {
          u.state = 'active';
          graduate.push(slug);
        }
      }
      if (graduate.length) {
        this.writeJson(this.usagePath()!, usage);
        for (const slug of graduate) this.setIndexState(slug, 'active');
      }
      return graduate.length;
    } catch (e) {
      console.error('[knowledge] reconcileGraduations failed:', e);
      return 0;
    }
  }

  // — capture: promote agent proposals into real skills —

  /** Fold every staged proposal into the library. Returns how many were promoted. */
  promoteProposals(): number {
    if (!this.enabled()) return 0;
    const pdir = this.proposalsDir();
    const skills = this.skillsDir();
    if (!pdir || !skills || !existsSync(pdir)) return 0;
    let files: string[];
    try { files = readdirSync(pdir).filter((f) => f.endsWith('.json')); } catch { return 0; }
    if (files.length === 0) return 0;

    const index = this.readIndex();
    const usage = this.readUsage();
    const bySlug = new Map(index.map((e) => [e.slug, e] as const));
    const doneDir = join(pdir, '.done');
    const quarantineDir = join(pdir, '.quarantine');
    mkdirSync(doneDir, { recursive: true });
    let promoted = 0;

    for (const f of files) {
      const full = join(pdir, f);
      try {
        const p = JSON.parse(readFileSync(full, 'utf8')) as SkillProposal;
        const slug = this.sanitizeSlug(p.slug || slugify(p.title ?? ''));
        const title = (p.title ?? '').trim();
        const body = (p.body ?? '').trim();
        if (!slug || !title || !body) { renameSync(full, join(doneDir, `bad-${f}`)); continue; }
        if (bySlug.has(slug)) { renameSync(full, join(doneDir, f)); continue; } // collision → curator merges

        // Trust gate: a learned skill that bakes in a destructive command or an injection
        // string is quarantined for human review instead of being silently relied upon.
        const danger = unsafeReason(body);
        if (danger) {
          mkdirSync(quarantineDir, { recursive: true });
          renameSync(full, join(quarantineDir, f));
          console.warn(`[knowledge] quarantined proposal ${slug}: ${danger}`);
          continue;
        }

        const sdir = join(skills, slug);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(join(sdir, 'SKILL.md'), this.renderSkillMd(slug, title, p.description ?? '', body), 'utf8');

        const desc = this.clampDesc(p.description ?? title);
        const entry: SkillIndexEntry = { slug, title, desc, tags: (p.tags ?? []).slice(0, 8), state: 'provisional' };
        index.push(entry);
        bySlug.set(slug, entry);
        usage[slug] = newUsage(slug, title, p.by || 'agent', 'provisional', new Date().toISOString());
        renameSync(full, join(doneDir, f));
        promoted += 1;
      } catch {
        try { renameSync(full, join(doneDir, `bad-${f}`)); } catch { /* noop */ }
      }
    }
    if (promoted > 0) { this.writeJson(this.indexPath()!, index); this.writeJson(this.usagePath()!, usage); }
    return promoted;
  }

  /** Apply every staged in-flight correction (knowledge/patches/*.json → applyPatch),
   *  moving each to patches/.done. Returns how many were applied. */
  applyStagedPatches(): number {
    if (!this.enabled()) return 0;
    const pdir = this.patchesDir();
    if (!pdir || !existsSync(pdir)) return 0;
    let files: string[];
    try { files = readdirSync(pdir).filter((f) => f.endsWith('.json')); } catch { return 0; }
    if (files.length === 0) return 0;
    const doneDir = join(pdir, '.done');
    mkdirSync(doneDir, { recursive: true });
    let applied = 0;
    for (const f of files) {
      const full = join(pdir, f);
      try {
        const patch = JSON.parse(readFileSync(full, 'utf8')) as SkillPatch;
        const res = this.applyPatch(patch);
        renameSync(full, join(doneDir, res.ok ? f : `bad-${f}`));
        if (res.ok) applied += 1;
        else console.warn(`[knowledge] patch ${patch?.slug} rejected: ${res.error}`);
      } catch {
        try { renameSync(full, join(doneDir, `bad-${f}`)); } catch { /* noop */ }
      }
    }
    // applyPatch snapshots the whole library before each patch. The only other pruner lives
    // inside applyCuratorPlan's ops>0 branch, which may never fire — so without pruning here
    // patch backups grow unbounded. Cap them to curatorBackupKeep.
    if (applied > 0) this.pruneBackups(this.getConfig().curatorBackupKeep ?? 5);
    return applied;
  }

  // — lifecycle: pure stale → archive transitions (no LLM) —

  /** Age idle agent-created skills: active→stale, then →archived (moved to .archive/,
   *  never deleted). Pinned + non-agent/curator skills are exempt. Returns ops applied. */
  runLifecycle(): number {
    if (!this.enabled()) return 0;
    const cfg = this.getConfig();
    const staleMs = (cfg.skillStaleAfterDays ?? 30) * 86_400_000;
    const archiveMs = (cfg.skillArchiveAfterDays ?? 90) * 86_400_000;
    const index = this.readIndex();
    const usage = this.readUsage();
    const now = Date.now();
    let changed = 0;
    for (const e of index) {
      if (e.state === 'archived') continue;
      const u = usage[e.slug];
      if (!u || u.pinned) continue;
      if (u.created_by === 'human') continue; // protect hand-authored skills; manage agent/curator ones
      // Anchor on the most recent sign of life — used, injected, or created. A skill the
      // team keeps surfacing every task must not age out just because it was opened via
      // the native Skill tool (which historically left last_used_at null).
      const anchor = Math.max(
        u.last_used_at ? Date.parse(u.last_used_at) : 0,
        u.last_injected_at ? Date.parse(u.last_injected_at) : 0,
        u.created_at ? Date.parse(u.created_at) : 0
      );
      const idle = now - anchor;
      if (idle > archiveMs) {
        this.archiveSkillFiles(e.slug);
        e.state = 'archived'; u.state = 'archived'; changed++;
      } else if (idle > staleMs && (e.state === 'active' || e.state === 'provisional')) {
        e.state = 'stale'; u.state = 'stale'; changed++;
      }
    }
    if (changed > 0) { this.writeJson(this.indexPath()!, index); this.writeJson(this.usagePath()!, usage); }
    return changed;
  }

  // — curation: apply a consolidation plan deterministically (curator LLM is read-only) —

  /** Snapshot the whole library before any destructive curation. Returns the backup dir. */
  backup(reason = 'curate'): string | null {
    if (!this.enabled()) return null;
    const k = this.knowledgeDir();
    const backups = this.backupsDir();
    if (!k || !backups || !existsSync(k)) return null;
    try {
      mkdirSync(backups, { recursive: true });
      const dest = join(backups, `${stamp()}-${reason}`);
      mkdirSync(dest, { recursive: true });
      // Copy each top-level entry EXCEPT the transient dirs. We must NOT cpSync(k, dest)
      // because dest lives under k/.backups — Node's cpSync rejects copying a directory
      // into its own subtree (ERR_FS_CP_EINVAL) before any filter runs.
      const skip = new Set(['.backups', 'logs']);
      for (const entry of readdirSync(k)) {
        if (skip.has(entry)) continue;
        cpSync(join(k, entry), join(dest, entry), { recursive: true });
      }
      return dest;
    } catch (e) {
      console.error('[knowledge] backup failed:', e);
      return null;
    }
  }

  /** Apply merges (umbrella absorbs siblings → siblings archived) and archives. Always
   *  backs up first; never deletes; writes a reversible REPORT with the old→new rename
   *  map so a bad consolidation can be understood and undone. Returns the ops applied.
   *  `source` labels the run in the report ('consolidate' = LLM, 'dedup' = fast-path). */
  applyCuratorPlan(plan: CuratorPlan, source = 'consolidate'): number {
    if (!this.enabled() || !plan) return 0;
    const skills = this.skillsDir();
    if (!skills) return 0;
    const backupDir = this.backup('consolidate');
    const index = this.readIndex();
    const usage = this.readUsage();
    const bySlug = new Map(index.map((e) => [e.slug, e] as const));
    let ops = 0;
    const renameMap: Array<{ from: string; to: string }> = []; // absorbed → umbrella
    const archived: string[] = [];

    for (const m of plan.merge ?? []) {
      const absorb = (m.absorb ?? []).map((s) => this.sanitizeSlug(s)).filter((s) => s && bySlug.has(s));
      if (absorb.length === 0 || !m.body?.trim()) continue;
      const umbrellaSlug = this.sanitizeSlug(m.umbrella) || absorb[0];
      const existing = bySlug.get(umbrellaSlug);
      // Don't let a merge clobber a human/pinned skill.
      if (existing && (usage[umbrellaSlug]?.pinned || (usage[umbrellaSlug]?.created_by ?? 'agent') === 'human')) continue;
      const title = (m.title ?? existing?.title ?? umbrellaSlug).trim();
      const desc = this.clampDesc(m.description ?? existing?.desc ?? title);

      const sdir = join(skills, umbrellaSlug);
      try { mkdirSync(sdir, { recursive: true }); writeFileSync(join(sdir, 'SKILL.md'), this.renderSkillMd(umbrellaSlug, title, desc, m.body), 'utf8'); }
      catch (e) { console.error('[knowledge] merge write failed:', e); continue; }

      if (existing) { existing.title = title; existing.desc = desc; existing.state = existing.state === 'archived' ? 'active' : existing.state; }
      else { const e2: SkillIndexEntry = { slug: umbrellaSlug, title, desc, tags: [], state: 'active' }; index.push(e2); bySlug.set(umbrellaSlug, e2); }
      usage[umbrellaSlug] = usage[umbrellaSlug] ?? newUsage(umbrellaSlug, title, 'curator', 'active', new Date().toISOString());
      usage[umbrellaSlug].state = 'active';

      for (const s of absorb) {
        if (s === umbrellaSlug) continue;
        this.archiveSkillFiles(s);
        const e3 = bySlug.get(s); if (e3) e3.state = 'archived';
        if (usage[s]) usage[s].state = 'archived';
        renameMap.push({ from: s, to: umbrellaSlug });
        ops++;
      }
      ops++;
    }

    for (const slug of plan.archive ?? []) {
      const s = this.sanitizeSlug(slug);
      const e = bySlug.get(s);
      if (!e || e.state === 'archived') continue;
      if (usage[s]?.pinned || usage[s]?.created_by === 'human') continue;
      this.archiveSkillFiles(s);
      e.state = 'archived';
      if (usage[s]) usage[s].state = 'archived';
      archived.push(s);
      ops++;
    }

    if (ops > 0) {
      this.writeJson(this.indexPath()!, index);
      this.writeJson(this.usagePath()!, usage);
      this.writeReport({ source, ops, renameMap, archived, backupDir });
      this.pruneBackups(this.getConfig().curatorBackupKeep ?? 5);
    }
    return ops;
  }

  /** Write a per-run REPORT.md + run.json under knowledge/logs/curator/<ts>/ so every
   *  consolidation is explainable and reversible (which backup, what was renamed/
   *  archived). Best-effort. */
  private writeReport(r: { source: string; ops: number; renameMap: Array<{ from: string; to: string }>; archived: string[]; backupDir: string | null }): void {
    const dir = this.curatorLogsDir();
    if (!dir) return;
    try {
      const runDir = join(dir, `${stamp()}-${r.source}`);
      mkdirSync(runDir, { recursive: true });
      const md = [
        `# Curator run — ${r.source}`,
        '',
        `- when: ${new Date().toISOString()}`,
        `- ops applied: ${r.ops}`,
        `- restore from backup: ${r.backupDir ?? '(none)'}`,
        '',
        '## Merged (old → umbrella)',
        ...(r.renameMap.length ? r.renameMap.map((m) => `- \`${m.from}\` → \`${m.to}\``) : ['- (none)']),
        '',
        '## Archived',
        ...(r.archived.length ? r.archived.map((s) => `- \`${s}\``) : ['- (none)'])
      ].join('\n');
      writeFileSync(join(runDir, 'REPORT.md'), `${md}\n`, 'utf8');
      this.writeJson(join(runDir, 'run.json'), r);
    } catch (e) {
      console.error('[knowledge] writeReport failed:', e);
    }
  }

  /** Log a curator run that applied no ops (or failed), so "ran, found nothing" is
   *  observable under logs/curator/ instead of being silent and indistinguishable from
   *  "never ran". `source` e.g. 'consolidate' (empty plan) or 'consolidate-failed'. */
  recordCuratorRun(source: string, ops: number): void {
    this.writeReport({ source, ops, renameMap: [], archived: [], backupDir: null });
  }

  /** Keep only the newest `keep` pre-curation snapshots under .backups/; remove older. */
  private pruneBackups(keep: number): void {
    const backups = this.backupsDir();
    if (!backups || !existsSync(backups) || keep < 0) return;
    try {
      const dirs = readdirSync(backups).filter((n) => !n.startsWith('.')).sort(); // stamp prefix → chronological
      for (const old of dirs.slice(0, Math.max(0, dirs.length - keep))) {
        rmSync(join(backups, old), { recursive: true, force: true });
      }
    } catch (e) {
      console.error('[knowledge] pruneBackups failed:', e);
    }
  }

  /** Persisted curator cadence timestamp (so the 6h consolidation throttle survives app
   *  restarts instead of resetting to "always due" every launch). */
  loadCuratorTimestamp(): number {
    const p = this.curatorStatePath();
    if (!p || !existsSync(p)) return 0;
    try { const v = JSON.parse(readFileSync(p, 'utf8')) as { lastConsolidateAt?: number }; return typeof v.lastConsolidateAt === 'number' ? v.lastConsolidateAt : 0; }
    catch { return 0; }
  }
  saveCuratorTimestamp(ms: number): void {
    const p = this.curatorStatePath();
    if (!p) return;
    try { this.writeJson(p, { lastConsolidateAt: ms }); } catch { /* best-effort */ }
  }

  /** In-flight correction (hermes-agent's skill_patch): rewrite or append to an existing
   *  skill the moment an agent finds it wrong/incomplete. Backs up first; bumps
   *  patch_count. Returns ok=false when the slug is unknown. */
  applyPatch(patch: SkillPatch): { ok: boolean; error?: string } {
    if (!this.enabled()) return { ok: false, error: 'disabled' };
    const skills = this.skillsDir();
    if (!skills) return { ok: false, error: 'no skills directory' };
    const slug = this.sanitizeSlug(patch.slug);
    const index = this.readIndex();
    const entry = index.find((e) => e.slug === slug);
    if (!entry) return { ok: false, error: `unknown skill "${slug}"` };

    const newBody = (patch.body ?? '').trim();
    const append = (patch.append ?? '').trim();
    if (!newBody && !append) return { ok: false, error: 'patch needs body or append' };
    const danger = unsafeReason(newBody || append);
    if (danger) return { ok: false, error: `rejected: ${danger}` };

    this.backup('patch');
    const title = (patch.title ?? entry.title).trim() || entry.title;
    const desc = this.clampDesc(patch.description ?? entry.desc);
    let body = newBody;
    if (!body) {
      const current = this.readSkillBody(slug).replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
      body = `${current}\n\n## Correction (${new Date().toISOString().slice(0, 10)})\n\n${append}`;
    }
    try {
      const sdir = join(skills, slug);
      mkdirSync(sdir, { recursive: true });
      writeFileSync(join(sdir, 'SKILL.md'), this.renderSkillMd(slug, title, desc, body), 'utf8');
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    entry.title = title; entry.desc = desc;
    if (Array.isArray(patch.tags) && patch.tags.length) entry.tags = patch.tags.filter((t) => typeof t === 'string').slice(0, 8);
    const usage = this.readUsage();
    const nowIso = new Date().toISOString();
    const u = usage[slug] ?? newUsage(slug, title, patch.by || 'agent', entry.state, nowIso);
    u.patch_count += 1; u.last_patched_at = nowIso; u.title = title;
    usage[slug] = u;
    this.writeJson(this.indexPath()!, index);
    this.writeJson(this.usagePath()!, usage);
    return { ok: true };
  }

  /** Cheap, no-LLM duplicate detector for the curator's fast-path: cluster non-archived
   *  skills that share a tag AND have token-overlapping titles. Returns merge stubs the
   *  caller hands to applyCuratorPlan (umbrella = the most-used member; body concatenates
   *  the members so no procedure is lost). Conservative: only obvious pairs. */
  findDuplicateMerges(): CuratorPlan {
    if (!this.enabled()) return { merge: [], archive: [] };
    const index = this.readIndex().filter((e) => e.state !== 'archived' && !e.path);
    if (index.length < 2) return { merge: [], archive: [] };
    const usage = this.readUsage();

    // Tokens/tags that appear in a MAJORITY of skills are boilerplate, not topical signal
    // (the project name is in nearly every title; a layer tag like "renderer" rides every
    // UI skill). Discount them so "overlap" reflects genuine subject similarity. Frequency-
    // based, so it generalises without hard-coding the project name.
    const commonCut = Math.max(2, index.length / 3);
    const titleFreq = new Map<string, number>();
    const tagFreq = new Map<string, number>();
    for (const e of index) {
      for (const t of new Set(this.tokenize(e.title))) titleFreq.set(t, (titleFreq.get(t) ?? 0) + 1);
      for (const t of new Set(e.tags ?? [])) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    }
    const topicalTitle = (s: string): Set<string> =>
      new Set(this.tokenize(s).filter((t) => (titleFreq.get(t) ?? 0) <= commonCut));
    const topicalTags = (tags: string[] | undefined): string[] =>
      (tags ?? []).filter((t) => (tagFreq.get(t) ?? 0) <= commonCut);

    const merge: NonNullable<CuratorPlan['merge']> = [];
    const claimed = new Set<string>();
    for (let i = 0; i < index.length; i++) {
      const a = index[i];
      if (claimed.has(a.slug)) continue;
      const aTitle = topicalTitle(a.title);
      const aTags = topicalTags(a.tags);
      const cluster = [a];
      for (let j = i + 1; j < index.length; j++) {
        const b = index[j];
        if (claimed.has(b.slug)) continue;
        let titleOverlap = 0;
        for (const t of topicalTitle(b.title)) if (aTitle.has(t)) titleOverlap++;
        const sharedTags = topicalTags(b.tags).filter((t) => aTags.includes(t)).length;
        // Reachable but conservative: 2 topical title tokens in common, OR 2 topical shared
        // tags. (The old AND-bar — 1 shared tag AND 2 title tokens — missed real near-dups
        // whose tags or titles had diverged.)
        if (titleOverlap >= 2 || sharedTags >= 2) cluster.push(b);
      }
      if (cluster.length < 2) continue;
      // Umbrella = the RICHEST member so the merged skill keeps the best title/slug:
      // most-used, then most-patched, then broadest (tag count), then slug for stability.
      cluster.sort((x, y) =>
        (usage[y.slug]?.use_count ?? 0) - (usage[x.slug]?.use_count ?? 0) ||
        (usage[y.slug]?.patch_count ?? 0) - (usage[x.slug]?.patch_count ?? 0) ||
        (y.tags?.length ?? 0) - (x.tags?.length ?? 0) ||
        x.slug.localeCompare(y.slug));
      const umbrella = cluster[0];
      const body = [`# ${umbrella.title}`, '', ...cluster.map((c) => `## ${c.title}\n\n${this.readSkillBody(c.slug).replace(/^---\n[\s\S]*?\n---\n?/, '').trim()}`)].join('\n\n');
      merge.push({ umbrella: umbrella.slug, title: umbrella.title, description: umbrella.desc, absorb: cluster.map((c) => c.slug), body });
      for (const c of cluster) claimed.add(c.slug);
    }
    return { merge, archive: [] };
  }

  // — read helpers (for IPC / curator prompt) —

  /** The active (non-archived) library, for IPC/UI and the curator's prompt. */
  listSkills(): SkillIndexEntry[] {
    return this.readIndex().filter((e) => e.state !== 'archived' && !e.path);
  }
  status(): { enabled: boolean; total: number; active: number; provisional: number; stale: number; archived: number } {
    const idx = this.readIndex();
    const count = (s: SkillState): number => idx.filter((e) => e.state === s).length;
    return {
      enabled: this.enabled(),
      total: idx.length,
      active: count('active'),
      provisional: count('provisional'),
      stale: count('stale'),
      archived: count('archived')
    };
  }
  /** Full markdown body for a slug — native SKILL.md or a bare deliverable file
   *  (used by the curator's consolidation prompt and the Skills-tab viewer). */
  readSkillBody(slug: string): string {
    const s = this.sanitizeSlug(slug);
    const entry = this.readIndex().find((e) => e.slug === s);
    const p = this.bodyPathFor(s, entry?.path);
    try { return p ? readFileSync(p, 'utf8') : ''; } catch { return ''; }
  }

  // — admin (the Skills tab): list-all, get, save, archive/restore/delete —

  /** Every skill incl. archived, joined with usage telemetry — for the admin UI.
   *  Also unions in any bare `knowledge/*.md` deliverable an agent wrote directly
   *  but never registered, so nothing the team produced is invisible in the tab. */
  listForAdmin(): SkillAdminRow[] {
    const usage = this.readUsage();
    const rows: SkillAdminRow[] = this.readIndex().map((e) => {
      const u = usage[e.slug];
      return {
        slug: e.slug, title: e.title, desc: e.desc, tags: e.tags ?? [], state: e.state,
        created_by: u?.created_by ?? 'agent',
        pinned: u?.pinned ?? false,
        created_at: u?.created_at ?? '',
        last_used_at: u?.last_used_at ?? null,
        use_count: u?.use_count ?? 0,
        inject_count: u?.inject_count ?? 0,
        view_count: u?.view_count ?? 0,
        patch_count: u?.patch_count ?? 0
      };
    });
    const seen = new Set(rows.map((r) => r.slug));
    const k = this.knowledgeDir();
    if (k) {
      let files: string[] = [];
      try { files = readdirSync(k).filter((f) => f.endsWith('.md')); } catch { /* dir may not exist */ }
      for (const f of files) {
        const slug = this.sanitizeSlug(f.replace(/\.md$/i, ''));
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);
        let title = slug;
        try { title = this.titleFromMarkdown(readFileSync(join(k, f), 'utf8')) ?? slug; } catch { /* noop */ }
        rows.push({
          slug, title, desc: '', tags: [], state: 'active',
          created_by: 'agent', pinned: false, created_at: '', last_used_at: null,
          use_count: 0, inject_count: 0, view_count: 0, patch_count: 0
        });
      }
    }
    return rows;
  }

  /** Parsed skill (frontmatter stripped → editable body) for view/edit. Resolves
   *  registered skills/deliverables AND unregistered bare `knowledge/<slug>.md`
   *  files (so any deliverable on disk is viewable). null only when nothing exists. */
  getSkill(slug: string): { slug: string; title: string; description: string; tags: string[]; body: string } | null {
    const s = this.sanitizeSlug(slug);
    const entry = this.readIndex().find((e) => e.slug === s);
    const bodyPath = this.bodyPathFor(s, entry?.path);
    if (!entry && !bodyPath) return null;
    const raw = this.readSkillBody(s);
    const body = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
    return {
      slug: s,
      title: entry?.title ?? this.titleFromMarkdown(raw) ?? s,
      description: entry?.desc ?? '',
      tags: entry?.tags ?? [],
      body
    };
  }

  /** Create (isNew) or update a skill from the UI. User-authored skills become
   *  `created_by:'human'`, which exempts them from the curator's auto-lifecycle. */
  saveSkill(input: { slug?: string; title: string; description?: string; tags?: string[]; body: string; isNew?: boolean }): { ok: boolean; slug?: string; error?: string } {
    if (!this.enabled()) return { ok: false, error: 'skill library disabled or no active project' };
    const skills = this.skillsDir();
    if (!skills) return { ok: false, error: 'no skills directory' };
    const title = (input.title ?? '').trim();
    const body = (input.body ?? '').trim();
    if (!title || !body) return { ok: false, error: 'title and body are required' };

    const index = this.readIndex();
    const usage = this.readUsage();
    const existing = input.slug ? index.find((e) => e.slug === this.sanitizeSlug(input.slug)) : undefined;
    const slug = existing ? existing.slug : (this.sanitizeSlug(input.slug || title) || 'skill');
    if (input.isNew && index.some((e) => e.slug === slug)) return { ok: false, error: `a skill "${slug}" already exists` };

    const desc = this.clampDesc(input.description || title);
    const tags = (input.tags ?? []).filter((t) => typeof t === 'string').slice(0, 8);
    try {
      const sdir = join(skills, slug);
      mkdirSync(sdir, { recursive: true });
      writeFileSync(join(sdir, 'SKILL.md'), this.renderSkillMd(slug, title, desc, body), 'utf8');
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    const nowIso = new Date().toISOString();
    const entry = index.find((e) => e.slug === slug);
    if (entry) { entry.title = title; entry.desc = desc; entry.tags = tags; if (entry.state === 'archived') entry.state = 'active'; }
    else index.push({ slug, title, desc, tags, state: 'active' });
    const prev = usage[slug];
    usage[slug] = {
      ...newUsage(slug, title, 'human', 'active', prev?.created_at ?? nowIso),
      ...(prev ? fillUsage(prev) : {}),
      slug, title,
      last_used_at: nowIso, // a human just touched it → fresh, won't go stale next cycle
      state: 'active',
      created_by: 'human', // user-curated → protected from the curator
    };
    this.writeJson(this.indexPath()!, index);
    this.writeJson(this.usagePath()!, usage);
    return { ok: true, slug };
  }

  /** Manually archive a skill (files → .archive/, recoverable). */
  archiveSkill(slug: string): { ok: boolean; error?: string } {
    if (!this.enabled()) return { ok: false, error: 'disabled' };
    const s = this.sanitizeSlug(slug);
    const index = this.readIndex();
    const e = index.find((x) => x.slug === s);
    if (!e) return { ok: false, error: 'not found' };
    if (e.state !== 'archived') {
      this.archiveSkillFiles(s);
      e.state = 'archived';
      const usage = this.readUsage();
      if (usage[s]) { usage[s].state = 'archived'; this.writeJson(this.usagePath()!, usage); }
      this.writeJson(this.indexPath()!, index);
    }
    return { ok: true };
  }

  /** Bring an archived skill back to active (files move out of .archive/). */
  restoreSkill(slug: string): { ok: boolean; error?: string } {
    if (!this.enabled()) return { ok: false, error: 'disabled' };
    const s = this.sanitizeSlug(slug);
    const skills = this.skillsDir();
    if (!skills) return { ok: false, error: 'no skills directory' };
    const index = this.readIndex();
    const e = index.find((x) => x.slug === s);
    if (!e) return { ok: false, error: 'not found' };
    const src = this.findArchivedDir(s);
    if (src) {
      const dest = join(skills, s);
      try {
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
        renameSync(src, dest);
      } catch {
        try { cpSync(src, dest, { recursive: true }); rmSync(src, { recursive: true, force: true }); }
        catch (e3) { return { ok: false, error: e3 instanceof Error ? e3.message : 'restore failed' }; }
      }
    }
    e.state = 'active';
    const usage = this.readUsage();
    if (usage[s]) { usage[s].state = 'active'; usage[s].last_used_at = new Date().toISOString(); this.writeJson(this.usagePath()!, usage); }
    this.writeJson(this.indexPath()!, index);
    return { ok: true };
  }

  /** Permanently delete a skill (removes files from skills/ or .archive/ + the index/usage entry). */
  deleteSkill(slug: string): { ok: boolean; error?: string } {
    if (!this.enabled()) return { ok: false, error: 'disabled' };
    const s = this.sanitizeSlug(slug);
    const skills = this.skillsDir();
    try {
      if (skills) rmSync(join(skills, s), { recursive: true, force: true });
      const arch = this.findArchivedDir(s);
      if (arch) rmSync(arch, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    const index = this.readIndex().filter((e) => e.slug !== s);
    const usage = this.readUsage();
    delete usage[s];
    this.writeJson(this.indexPath()!, index);
    this.writeJson(this.usagePath()!, usage);
    return { ok: true };
  }

  /** Resolve the archived directory for a slug: exact `<slug>` first, else newest `<slug>-*`. */
  private findArchivedDir(slug: string): string | null {
    const archive = this.archiveDir();
    if (!archive || !existsSync(archive)) return null;
    const exact = join(archive, slug);
    if (existsSync(exact)) return exact;
    try {
      const matches = readdirSync(archive).filter((n) => n === slug || n.startsWith(`${slug}-`)).sort();
      return matches.length ? join(archive, matches[matches.length - 1]) : null;
    } catch { return null; }
  }

  // — internals —

  private archiveSkillFiles(slug: string): void {
    const skills = this.skillsDir();
    const archive = this.archiveDir();
    if (!skills || !archive) return;
    const src = join(skills, slug);
    if (!existsSync(src)) return;
    try {
      mkdirSync(archive, { recursive: true });
      let dest = join(archive, slug);
      if (existsSync(dest)) dest = `${dest}-${stamp()}`; // never clobber a prior archive
      renameSync(src, dest);
    } catch (e) {
      // Cross-device rename can fail; fall back to copy+remove.
      try { cpSync(src, join(archive, `${slug}-${stamp()}`), { recursive: true }); rmSync(src, { recursive: true, force: true }); }
      catch (e2) { console.error('[knowledge] archive failed:', e, e2); }
    }
  }

  private setIndexState(slug: string, state: SkillState): void {
    const index = this.readIndex();
    const e = index.find((x) => x.slug === slug);
    if (!e || e.state === state) return;
    e.state = state;
    this.writeJson(this.indexPath()!, index);
  }

  private bumpInject(slugs: string[]): void {
    try {
      const usage = this.readUsage();
      const nowIso = new Date().toISOString();
      let changed = false;
      for (const s of slugs) { if (usage[s]) { usage[s].inject_count += 1; usage[s].last_injected_at = nowIso; changed = true; } }
      if (changed) this.writeJson(this.usagePath()!, usage);
    } catch { /* telemetry is best-effort */ }
  }

  private tokenize(text: string): string[] {
    const seen = new Set<string>();
    for (const raw of text.toLowerCase().split(/[^a-z0-9]+/)) {
      if (raw.length < 3 || SUMMARY_DIGEST_STOPWORDS.has(raw)) continue;
      seen.add(raw);
    }
    return [...seen];
  }

  private sanitizeSlug(s: string | undefined): string {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }
  private clampDesc(s: string): string {
    const one = (s ?? '').replace(/\s+/g, ' ').trim();
    return one.length <= 80 ? one : `${one.slice(0, 77)}…`;
  }
  private renderSkillMd(slug: string, title: string, description: string, body: string): string {
    // Minimal native frontmatter (name + description) so Claude Code discovers it.
    // Provenance/state/telemetry live in usage.json, not the frontmatter.
    const desc = this.clampDesc(description || title);
    const front = ['---', `name: ${slug}`, `description: ${desc.replace(/\n/g, ' ')}`, '---', ''].join('\n');
    const heading = body.trimStart().startsWith('#') ? '' : `# ${title}\n\n`;
    return `${front}\n${heading}${body.trim()}\n`;
  }

  /** Coerce one raw index record into a coherent SkillIndexEntry, tolerating the
   *  hand-rolled deliverable shape ({id, summary, path}) an agent writes when it
   *  drops a bare `knowledge/<file>.md` instead of going through the proposal
   *  pipeline. The raw record is SPREAD first so a later index rewrite never drops
   *  an entry's original metadata (id/author/createdAt/summary stay alongside the
   *  canonical fields). Non-destructive by construction. */
  private normalizeEntry(raw: Record<string, unknown>): SkillIndexEntry {
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const path = str(raw.path);
    const slug = this.sanitizeSlug(
      str(raw.slug) || str(raw.id) || (path ? path.replace(/\.md$/i, '') : '') || slugify(str(raw.title) ?? '')
    );
    const state = (['provisional', 'active', 'stale', 'archived'] as const).includes(raw.state as SkillState)
      ? (raw.state as SkillState)
      : 'active'; // a bare deliverable has no state → treat as active (browsable, not archived)
    return {
      ...raw,
      slug,
      title: str(raw.title) ?? slug,
      desc: str(raw.desc) ?? str(raw.summary) ?? '',
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === 'string') : [],
      state,
      path
    };
  }

  /** Absolute path to a skill/deliverable's markdown body: the native
   *  `.claude/skills/<slug>/SKILL.md` when present, else the bare
   *  `knowledge/<path|slug>.md` an agent wrote directly. null when neither exists.
   *  `path` is reduced to a basename so a stray `../` in the index can't escape. */
  private bodyPathFor(slug: string, path?: string): string | null {
    const dir = this.skillsDir();
    const native = dir ? join(dir, this.sanitizeSlug(slug), 'SKILL.md') : null;
    if (native && existsSync(native)) return native;
    const k = this.knowledgeDir();
    if (!k) return null;
    const file = (path ?? `${slug}.md`).split(/[/\\]/).pop() || `${slug}.md`;
    const bare = join(k, file);
    return existsSync(bare) ? bare : null;
  }

  /** First `# H1` of a markdown body, or null. Used to title an unregistered file. */
  private titleFromMarkdown(md: string): string | null {
    const m = md.match(/^\s*#\s+(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  }

  private readIndex(): SkillIndexEntry[] {
    const p = this.indexPath();
    if (!p) return [];
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'));
      return Array.isArray(v) ? v.map((e) => this.normalizeEntry((e ?? {}) as Record<string, unknown>)) : [];
    }
    catch { return []; }
  }
  private readUsage(): Record<string, SkillUsage> {
    const p = this.usagePath();
    if (!p) return {};
    try {
      const v = JSON.parse(readFileSync(p, 'utf8'));
      if (!v || typeof v !== 'object') return {};
      // Backfill any record written before the telemetry fields existed.
      const out: Record<string, SkillUsage> = {};
      for (const [slug, rec] of Object.entries(v as Record<string, Partial<SkillUsage>>)) {
        out[slug] = fillUsage({ ...rec, slug });
      }
      return out;
    } catch { return {}; }
  }
  private writeJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }
}
