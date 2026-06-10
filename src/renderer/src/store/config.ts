// Mirrors src/main/config.ts. Kept as a renderer-side type-only module
// so we don't have to reach into the preload package to type-check.

/** A project the user has opened/created — its folder is the data root. */
export interface ProjectRef {
  name: string;
  path: string;
}

/** A user-configured MCP server (mirrors McpServerDef in src/main/mcp.ts). Defs
 *  exchanged over IPC are decrypted — secrets in env/headers are plaintext. */
export interface McpServerDef {
  id: string;
  name: string;
  enabled: boolean;
  scope: 'all' | 'god';
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export interface HarnessConfig {
  onboardingComplete: boolean;
  /** Default parent directory for newly created projects (the old "harness home"). */
  harnessHome: string | null;
  /** The currently open project folder = the data root. */
  activeProjectPath: string | null;
  /** Known projects (drives the switcher). */
  projects: ProjectRef[];
  registeredRepos: string[];
  autoMode: boolean;
  /** When false (default), startup is passive: no orientation prompt on boot and
   *  no inbox auto-nudges until the user kicks off the first task. */
  autoPilot?: boolean;
  /** When true, Michael is auto-sent `/remote-control` on a fresh spawn so the
   *  user can approve permission prompts from their phone. Default false. */
  remoteControl?: boolean;
  defaultCommand: string;
  /** Default model for newly spawned agents (e.g. 'claude-sonnet-4-6[1m]'); unset = CLI default. */
  defaultModel?: string;
  /** Default effort level for newly spawned agents; unset = Claude Code's own default. */
  defaultEffort?: EffortLevel;
  semanticMemory: boolean;
  embeddingModel: 'minilm' | 'embeddinggemma';
  sttModel: 'whisper-base.en' | 'whisper-tiny.en' | 'whisper-base' | 'distil-small.en';
  /** Whisper model for live meeting transcription (CPU-only worker; see main config.ts). */
  meetingSttModel?: 'whisper-base' | 'whisper-base.en' | 'whisper-tiny.en';
  /** Meeting language: 'auto' detects per segment; a fixed code improves accuracy. */
  meetingLanguage?: 'auto' | 'en' | 'da';
  /** Seconds between meeting-analyst ticks. */
  meetingAnalysisIntervalSec?: number;
  /** Capture periodic screen frames for the analyst. */
  meetingFrameCapture?: boolean;
  /** Seconds between captured screen frames. */
  meetingFrameIntervalSec?: number;
  /** Model for the meeting-analyst agent; unset = defaultModel. */
  analystModel?: string;
  /** When true, a task entering Needs Approval is auto-approved (returned to TODO +
   *  dispatched, planMode cleared) without a human Approve click. Persisted. */
  autoApprove?: boolean;
}

/** Claude Code's reasoning/effort levels, passed through as the `--effort` flag.
 *  `xhigh`/`max` are Opus-tier; `undefined` means "no flag" → the CLI default. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The Sonnet model with the 1M-token context window — used for Michael's prep
 *  assistant (cheap, large-context context gathering). Mirrors ASSISTANT_MODEL
 *  in src/main/assistant.ts; keep the two in sync. */
export const ASSISTANT_MODEL = 'claude-sonnet-4-6[1m]';

export interface ModelOption {
  /** undefined = use the CLI default (no --model flag) */
  id?: string;
  label: string;
  /** Marks a non-default model that overrides the subscription default and may
   *  draw extra cost — Opus, or the 1M-context `[1m]` variants. Surfaced in the
   *  picker so a manual pick is an informed, opt-in choice. */
  premium?: boolean;
}

/** The models offered in the "add agent" picker and the per-agent selector.
 *  `[1m]` selects the 1M-token context window variant. Anything past `default`
 *  pins an explicit `--model`; the `premium` ones may not be in every plan. */
export const AGENT_MODELS: ModelOption[] = [
  { id: undefined, label: 'default' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8', premium: true },
  { id: 'claude-opus-4-8[1m]', label: 'Opus 4.8 · 1M', premium: true },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { id: ASSISTANT_MODEL, label: 'Sonnet 4.6 · 1M', premium: true },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' }
];

export interface EffortOption {
  /** undefined = no --effort flag (Claude Code's own default) */
  id?: EffortLevel;
  label: string;
  /** Marks an Opus-tier level (xhigh/max) — surfaced as a hint in the picker. */
  opus?: boolean;
}

/** The effort levels offered in the "add agent" picker, the per-agent selector,
 *  and the global default in Settings. `default` leaves the flag off so the agent
 *  inherits Claude Code's own effort setting. */
export const AGENT_EFFORTS: EffortOption[] = [
  { id: undefined, label: 'default' },
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'X-High', opus: true },
  { id: 'max', label: 'Max', opus: true }
];

/** Build the command line to feed into spawnPty, honoring autoMode and the
 *  optional per-agent model (`--model <model>`) and effort (`--effort <level>`)
 *  overrides. The `--effort` flag overrides any settings.json effortLevel. */
export function buildSpawnCommand(
  config: Pick<HarnessConfig, 'defaultCommand' | 'autoMode'>,
  model?: string,
  effort?: EffortLevel
): string {
  const base = config.defaultCommand || 'claude';
  const withModel = model ? `${base} --model ${model}` : base;
  const withEffort = effort ? `${withModel} --effort ${effort}` : withModel;
  return config.autoMode ? `${withEffort} --permission-mode bypassPermissions` : withEffort;
}
