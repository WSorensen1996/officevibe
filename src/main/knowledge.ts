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

/** Per-skill telemetry + provenance (the curator's source of truth). */
export interface SkillUsage {
  slug: string;
  title: string;
  created_at: string;            // ISO
  last_used_at: string | null;   // ISO; null until first read
  use_count: number;
  inject_count: number;
  state: SkillState;
  created_by: string;            // agent id, or 'curator'
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

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function shortRand(): string {
  return randomBytes(3).toString('hex');
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
  private archiveDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, '.archive') : null; }
  private backupsDir(): string | null { const k = this.knowledgeDir(); return k ? join(k, '.backups') : null; }

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
      if (!existsSync(idx)) this.writeJson(idx, [] as SkillIndexEntry[]);
      if (!existsSync(usage)) this.writeJson(usage, {} as Record<string, SkillUsage>);
    } catch (e) {
      console.error('[knowledge] ensureScaffold failed:', e);
    }
  }

  // — hot path: ranking + injection (sync, in-process, no subprocess) —

  /** Top-k skills relevant to a prompt. Keyword overlap is required (≥1 hit); usage
   *  recency and state break ties. Returns [] when disabled/empty. Never throws. */
  rankForPrompt(prompt: string, k: number): SkillIndexEntry[] {
    if (!this.enabled() || !prompt) return [];
    const index = this.readIndex().filter((e) => e.state !== 'archived');
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

  /** The `additionalContext` block injected on UserPromptSubmit. Bumps inject_count
   *  for the shown skills. '' when disabled or nothing relevant. */
  injectionBlock(prompt: string): string {
    if (!this.enabled()) return '';
    const k = this.getConfig().maxInjectedSkills ?? 3;
    const picks = this.rankForPrompt(prompt, k);
    if (picks.length === 0) return '';
    const dir = this.skillsDir();
    this.bumpInject(picks.map((p) => p.slug));
    const lines = picks.map((p) => {
      const bodyPath = this.bodyPathFor(p.slug, p.path) ?? (dir ? join(dir, p.slug, 'SKILL.md') : p.slug);
      return `• ${p.title} — ${p.desc} [load full: read ${bodyPath}]`;
    });
    return [
      'RELEVANT PROJECT SKILLS — the team has learned these for this project; consult them before starting (load a skill\'s full text by reading its file):',
      ...lines
    ].join('\n');
  }

  /** A short overview injected on SessionStart so a fresh agent knows the library exists. */
  sessionStartDigest(): string {
    if (!this.enabled()) return '';
    const index = this.readIndex().filter((e) => e.state === 'active' || e.state === 'provisional');
    if (index.length === 0) return '';
    const usage = this.readUsage();
    const top = [...index]
      .sort((a, b) => (usage[b.slug]?.use_count ?? 0) - (usage[a.slug]?.use_count ?? 0))
      .slice(0, Math.max(3, (this.getConfig().maxInjectedSkills ?? 3) * 2));
    const dir = this.skillsDir();
    return [
      `This project has a shared SKILL library (${index.length} skill${index.length === 1 ? '' : 's'}) the team built from experience. Most-used:`,
      ...top.map((e) => `• ${e.title} — ${e.desc}`),
      dir ? `Browse/read them under ${dir}; you'll also get a per-task "relevant skills" note.` : ''
    ].filter(Boolean).join('\n');
  }

  /** Bump use_count when an agent reads a skill file (driven by the PostToolUse hook). */
  bumpUseForPath(absPath: string | undefined): void {
    if (!this.enabled() || !absPath) return;
    const dir = this.skillsDir();
    if (!dir || !absPath.startsWith(dir)) return;
    const rest = absPath.slice(dir.length).replace(/^[/\\]+/, '');
    const slug = rest.split(/[/\\]/)[0];
    if (!slug) return;
    try {
      const usage = this.readUsage();
      const u = usage[slug];
      if (!u) return;
      u.use_count += 1;
      u.last_used_at = new Date().toISOString();
      // Cheap graduation: a provisional skill that's actually been used twice is trusted.
      if (u.state === 'provisional' && u.use_count >= 2) {
        u.state = 'active';
        this.setIndexState(slug, 'active');
      }
      this.writeJson(this.usagePath()!, usage);
    } catch (e) {
      console.error('[knowledge] bumpUseForPath failed:', e);
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

        const sdir = join(skills, slug);
        mkdirSync(sdir, { recursive: true });
        writeFileSync(join(sdir, 'SKILL.md'), this.renderSkillMd(slug, title, p.description ?? '', body), 'utf8');

        const desc = this.clampDesc(p.description ?? title);
        const entry: SkillIndexEntry = { slug, title, desc, tags: (p.tags ?? []).slice(0, 8), state: 'provisional' };
        index.push(entry);
        bySlug.set(slug, entry);
        const nowIso = new Date().toISOString();
        usage[slug] = {
          slug, title, created_at: nowIso, last_used_at: null,
          use_count: 0, inject_count: 0, state: 'provisional',
          created_by: p.by || 'agent', pinned: false
        };
        renameSync(full, join(doneDir, f));
        promoted += 1;
      } catch {
        try { renameSync(full, join(doneDir, `bad-${f}`)); } catch { /* noop */ }
      }
    }
    if (promoted > 0) { this.writeJson(this.indexPath()!, index); this.writeJson(this.usagePath()!, usage); }
    return promoted;
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
      const anchor = u.last_used_at ? Date.parse(u.last_used_at) : Date.parse(u.created_at);
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
      cpSync(k, dest, {
        recursive: true,
        filter: (src) => !src.includes(`${'.backups'}`) // never copy the backups dir into itself
      });
      return dest;
    } catch (e) {
      console.error('[knowledge] backup failed:', e);
      return null;
    }
  }

  /** Apply merges (umbrella absorbs siblings → siblings archived) and archives. Always
   *  backs up first; never deletes. Returns the number of ops applied. */
  applyCuratorPlan(plan: CuratorPlan): number {
    if (!this.enabled() || !plan) return 0;
    const skills = this.skillsDir();
    if (!skills) return 0;
    this.backup('consolidate');
    const index = this.readIndex();
    const usage = this.readUsage();
    const bySlug = new Map(index.map((e) => [e.slug, e] as const));
    let ops = 0;

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
      usage[umbrellaSlug] = usage[umbrellaSlug] ?? {
        slug: umbrellaSlug, title, created_at: new Date().toISOString(), last_used_at: null,
        use_count: 0, inject_count: 0, state: 'active', created_by: 'curator', pinned: false
      };
      usage[umbrellaSlug].state = 'active';

      for (const s of absorb) {
        if (s === umbrellaSlug) continue;
        this.archiveSkillFiles(s);
        const e3 = bySlug.get(s); if (e3) e3.state = 'archived';
        if (usage[s]) usage[s].state = 'archived';
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
      ops++;
    }

    if (ops > 0) { this.writeJson(this.indexPath()!, index); this.writeJson(this.usagePath()!, usage); }
    return ops;
  }

  // — read helpers (for IPC / curator prompt) —

  /** The active (non-archived) library, for IPC/UI and the curator's prompt. */
  listSkills(): SkillIndexEntry[] {
    return this.readIndex().filter((e) => e.state !== 'archived');
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
        inject_count: u?.inject_count ?? 0
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
          use_count: 0, inject_count: 0
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
      slug, title,
      created_at: prev?.created_at ?? nowIso,
      last_used_at: nowIso, // a human just touched it → fresh, won't go stale next cycle
      use_count: prev?.use_count ?? 0,
      inject_count: prev?.inject_count ?? 0,
      state: 'active',
      created_by: 'human', // user-curated → protected from the curator
      pinned: prev?.pinned ?? false
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
      let changed = false;
      for (const s of slugs) { if (usage[s]) { usage[s].inject_count += 1; changed = true; } }
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
    try { const v = JSON.parse(readFileSync(p, 'utf8')); return v && typeof v === 'object' ? v as Record<string, SkillUsage> : {}; }
    catch { return {}; }
  }
  private writeJson(p: string, data: unknown): void {
    const tmp = `${p}.tmp-${shortRand()}`;
    writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    renameSync(tmp, p);
  }
}
