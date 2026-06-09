import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { McpServerDef } from './mcp';

/** A scheduled auto-dispatch handled by the scheduler. Historically a recurring
 *  "mission" (label/to/body fired every intervalMs); now also backs Tasks-tab
 *  schedules via taskId + mode. Mirrored in preload/index.ts and TasksKanban.tsx
 *  — keep the three in sync. */
export interface ScheduledMission {
  id: string;
  label: string;
  intervalMs: number;
  to: string;
  body: string;
  enabled: boolean;
  lastFiredAt?: number;
  /** When set, this schedule auto-dispatches a Tasks-tab task (re-read live at
   *  fire time); label/to are a best-effort snapshot and body is unused. */
  taskId?: string;
  /** 'recurring' fires every intervalMs; 'once' fires a single time at runAt.
   *  Absent ⇒ 'recurring' (back-compat with pre-existing missions). */
  mode?: 'recurring' | 'once';
  /** Epoch ms of the single fire when mode === 'once'. */
  runAt?: number;
}

/** A project the user has opened or created. Each project is a self-contained
 *  folder (the data collection formerly called the "hive") named `officevibe-<slug>`. */
export interface ProjectRef {
  /** Display name (e.g. "Acme"); persisted in the folder's officevibe.json manifest. */
  name: string;
  /** Absolute path to the project folder = the data root the managers point at. */
  path: string;
}

export interface HarnessConfig {
  /** Has the user completed the first-run onboarding? */
  onboardingComplete: boolean;
  /** Default PARENT directory for newly created projects (the old "harness home").
   *  Project folders live under here by default; an opened project may live anywhere. */
  harnessHome: string | null;
  /** The currently open project folder = the data root (agents, registry, tasks,
   *  board, log, palace). Replaces the old `<harnessHome>/hive` path. */
  activeProjectPath: string | null;
  /** Every project the user has opened/created — drives the project switcher. */
  projects: ProjectRef[];
  /** Folders the user registered during onboarding (used as quick-picks). */
  registeredRepos: string[];
  /** When true, new agents are spawned with --permission-mode bypassPermissions. */
  autoMode: boolean;
  /** When true, Michael is auto-oriented on boot and idle agents are auto-nudged
   *  to drain their inbox. When false (default), startup is passive — Michael
   *  spawns idle and nothing runs until the user dispatches the first task. */
  autoPilot?: boolean;
  /** When true, Michael is auto-sent `/remote-control` ~4s after a fresh spawn so
   *  the human can approve permission prompts from their phone. Default false:
   *  the slash command is skipped and the user can run it manually if desired. */
  remoteControl?: boolean;
  /** The command we run when spawning a new agent. */
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Default effort level for newly spawned agents (passed as `--effort <level>`);
   *  unset = Claude Code's own default. xhigh/max are Opus-tier. */
  defaultEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Enable semantic memory (MemPalace CLI). No-op if mempalace isn't installed. */
  semanticMemory: boolean;
  /** Embedding model for the palace: lightweight 'minilm' or multilingual 'embeddinggemma'. */
  embeddingModel: 'minilm' | 'embeddinggemma';
  /** Enable the self-improvement skill loop (capture → inject → curate). Independent
   *  of semanticMemory: ranking falls back to recency when MemPalace is absent. */
  skillLearning: boolean;
  /** Minutes between background curator cycles (promote proposals + lifecycle + consolidate). */
  curatorIntervalMinutes?: number;
  /** Days of inactivity before an agent-created skill is marked stale. */
  skillStaleAfterDays?: number;
  /** Days of inactivity before a stale skill is archived (moved aside, never deleted). */
  skillArchiveAfterDays?: number;
  /** Max number of skills HIGHLIGHTED as "most relevant" at the top of the injected
   *  block. The full skill inventory is always injected (Hermes-style); this only
   *  controls how many get the relevance call-out. */
  maxInjectedSkills?: number;
  /** Token budget for the always-on skill inventory injected at task start (Hermes
   *  "Level 0"). When the inventory would exceed this, it falls back to the
   *  highest-ranked subset that fits. Roughly 4 chars/token. */
  skillInventoryTokenBudget?: number;
  /** How many pre-curation library snapshots to keep under knowledge/.backups (older
   *  ones are pruned). */
  curatorBackupKeep?: number;
  /** Skip the curator's LLM consolidation when 5h or 7d Claude usage exceeds this percent. */
  curatorUsageCeilingPercent?: number;
  /** Whisper dictation model: accurate 'whisper-base.en' (default), lighter/faster
   *  'whisper-tiny.en', or the GPU tier 'distil-small.en' (WebGPU, CPU fallback). The
   *  string is the on-disk model folder name the STT worker loads. */
  sttModel: 'whisper-base.en' | 'whisper-tiny.en' | 'distil-small.en';
  /** When true, any task that ENTERS the Needs Approval sub-section is immediately
   *  auto-approved (returned to TODO + dispatched, planMode cleared) without waiting
   *  for a human Approve click. Persisted so it survives restart. Default false. */
  autoApprove?: boolean;
  /** Recurring auto-dispatch missions handled by the scheduler. */
  missions?: ScheduledMission[];
  /** Fire native desktop notifications on agent lifecycle events (idle finish / waiting for input). */
  notifications?: boolean;
  /** Master toggle for the Slack → Michael's-queue integration. */
  slackEnabled?: boolean;
  /** Slack app signing secret (Basic Information → Signing Secret). Never logged. */
  slackSigningSecret?: string;
  /** Restrict ingestion to one channel id; empty/undefined = any channel. */
  slackChannelId?: string;
  /** Local HTTP port the webhook server binds to (default 3847). */
  slackPort?: number;
  /** User-configured MCP servers wired into spawned agents (see src/main/mcp.ts).
   *  Secret-bearing values (env/header values) are encrypted at rest. */
  mcpServers?: McpServerDef[];
  /** Persisted localhost port for the in-app browser MCP server. Reused across
   *  restarts so the port baked into each agent's mcp.json stays valid — no agent
   *  restart needed after the first run. Falls back to an ephemeral port if taken,
   *  and the actual bound port is persisted back. 127.0.0.1-only; unset on first run. */
  browserMcpPort?: number;
}

const DEFAULTS: HarnessConfig = {
  onboardingComplete: false,
  harnessHome: null,
  activeProjectPath: null,
  projects: [],
  registeredRepos: [],
  autoMode: true,
  autoPilot: false,
  remoteControl: false,
  defaultCommand: 'claude',
  semanticMemory: true,
  embeddingModel: 'minilm',
  skillLearning: true,
  curatorIntervalMinutes: 60,
  skillStaleAfterDays: 30,
  skillArchiveAfterDays: 90,
  maxInjectedSkills: 3,
  skillInventoryTokenBudget: 3000,
  curatorBackupKeep: 5,
  curatorUsageCeilingPercent: 80,
  sttModel: 'whisper-base.en',
  autoApprove: false,
  missions: [],
  notifications: false,
  slackEnabled: false,
  slackSigningSecret: undefined,
  slackChannelId: undefined,
  slackPort: undefined,
  mcpServers: []
};

function configPath(): string {
  return join(app.getPath('userData'), 'config.json');
}

export function readConfig(): HarnessConfig {
  const p = configPath();
  if (!existsSync(p)) return { ...DEFAULTS };
  try {
    const raw = readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    return migrateProjects({ ...DEFAULTS, ...parsed });
  } catch {
    return { ...DEFAULTS };
  }
}

/** Back-compat + self-heal: a config saved before the "project" concept has
 *  `harnessHome` and data at `<harnessHome>/hive`, but no `activeProjectPath`. Adopt
 *  that hive folder in place as the first project (no data is moved). Also prunes
 *  phantom/duplicate projects (a folder that no longer exists, or a non-project
 *  parent directory that lacks an officevibe.json manifest) and guarantees the
 *  active project is present in `projects`. Pure (never writes) — boot persists it once. */
function migrateProjects(cfg: HarnessConfig): HarnessConfig {
  // 1. Drop phantoms (missing folders, non-project parent dirs) and de-dupe.
  const projects = pruneProjects(Array.isArray(cfg.projects) ? cfg.projects : []);

  // 2. Legacy adoption: a pre-"project" config has data at <harnessHome>/hive and
  //    no activeProjectPath. Adopt that folder in place if it still exists.
  let activeProjectPath = cfg.activeProjectPath ?? null;
  if (!activeProjectPath && cfg.harnessHome) {
    const legacy = join(cfg.harnessHome, 'hive');
    if (existsSync(legacy)) activeProjectPath = legacy;
  }

  // 3. Validate the active path with a LENIENT folder-level check (NOT the manifest
  //    test): a freshly opened folder or never-activated legacy hive has no manifest
  //    yet. If the active folder is gone, repoint at the first surviving real project
  //    (from the already-pruned list) so the app never points at a ghost.
  if (activeProjectPath && !existsSync(activeProjectPath)) {
    activeProjectPath = projects[0]?.path ?? null;
  }

  // 4. Guarantee the (validated) active project is present in the list. It may have
  //    been pruned in step 1 for lacking a manifest yet — re-add it with a derived name.
  if (activeProjectPath && !projects.some((p) => p.path === activeProjectPath)) {
    projects.push({ name: deriveProjectName(activeProjectPath), path: activeProjectPath });
  }

  return { ...cfg, activeProjectPath, projects };
}

export function writeConfig(patch: Partial<HarnessConfig>): HarnessConfig {
  const current = readConfig();
  const next: HarnessConfig = { ...current, ...patch };
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

/** Wipe the persisted config back to first-run defaults so the app boots into
 *  onboarding again. Used by the "reset & start over" flow. */
export function resetConfig(): HarnessConfig {
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(DEFAULTS, null, 2), 'utf8');
  return { ...DEFAULTS };
}

/** Ensure a folder exists on disk (used for harnessHome + project folders). */
export function ensureHarnessHome(path: string): { ok: boolean; error?: string } {
  try {
    mkdirSync(path, { recursive: true });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Projects ────────────────────────────────────────────────────────────────

/** Filesystem-safe slug for a project name, e.g. "My Project!" → "my-project". */
export function slugify(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
}

/** On-disk folder name for a new project: `officevibe-<slug>`. */
export function projectFolderName(name: string): string {
  return `officevibe-${slugify(name)}`;
}

/** Default parent directory for newly created projects. */
export function defaultProjectsDir(cfg: HarnessConfig): string {
  if (cfg.harnessHome) return cfg.harnessHome;
  if (cfg.activeProjectPath) return dirname(cfg.activeProjectPath);
  return process.env.HOME ?? process.cwd();
}

/** Human-readable name for a project folder: prefer its officevibe.json manifest,
 *  then fall back to the folder basename (stripping the `officevibe-` prefix). The
 *  legacy `hive` folder maps to "Default". */
export function deriveProjectName(path: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(path, 'officevibe.json'), 'utf8')) as { name?: unknown };
    if (manifest && typeof manifest.name === 'string' && manifest.name.trim()) return manifest.name.trim();
  } catch { /* no manifest — derive from the folder name */ }
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? 'project';
  if (base === 'hive') return 'Default';
  return base.replace(/^officevibe-/i, '') || base;
}

/** Robust "is this a real OfficeVibe project" test: the folder must exist AND
 *  contain an officevibe.json manifest. Rejects both a missing folder and a
 *  non-project parent directory. Never throws. */
export function isProjectFolder(path: string): boolean {
  try {
    return existsSync(join(path, 'officevibe.json'));
  } catch {
    return false;
  }
}

/** De-dupe a project list by path (keeping the last/newest display name, matching
 *  upsertProject) and drop any entry that is not a real project folder on disk. */
export function pruneProjects(projects: ProjectRef[]): ProjectRef[] {
  const byPath = new Map<string, ProjectRef>();
  for (const p of projects) {
    if (p && typeof p.path === 'string' && isProjectFolder(p.path)) byPath.set(p.path, p);
  }
  return [...byPath.values()];
}

/** Upsert a project into the list by path (keeps the newest display name). */
export function upsertProject(projects: ProjectRef[], ref: ProjectRef): ProjectRef[] {
  const rest = projects.filter((p) => p.path !== ref.path);
  return [...rest, ref];
}
