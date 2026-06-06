import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Resolve the Claude Code transcript directory for a given working directory.
 *  Claude Code stores per-project transcripts under ~/.claude/projects, keying
 *  each project by its absolute cwd with the leading slash dropped and every
 *  remaining slash turned into a dash (e.g. /Users/me/app → Users-me-app). */
export function projectDir(cwd: string): string {
  return path.join(os.homedir(), '.claude/projects', cwd.replace(/^\//, '').replaceAll('/', '-'));
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCostUsd: number;
}

// Sonnet pricing, USD per million tokens.
const PRICE_INPUT_PER_M = 3;
const PRICE_OUTPUT_PER_M = 15;
const PRICE_CACHE_READ_PER_M = 0.3;
const PRICE_CACHE_WRITE_PER_M = 3.75;

function zero(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCostUsd: 0 };
}

/** Sum real token usage across every Claude Code transcript for `cwd` and
 *  estimate the dollar cost using Sonnet pricing. Resilient by design: any
 *  unreadable file or malformed line is skipped, and any unexpected failure
 *  yields a zeroed result rather than throwing into the IPC handler. */
export function readAgentUsage(cwd: string): AgentUsage {
  const usage = zero();
  try {
    const dir = projectDir(cwd);
    if (!existsSync(dir)) return usage;
    const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    for (const file of files) {
      try {
        const text = readFileSync(path.join(dir, file), 'utf8');
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let rec: { type?: unknown; message?: { usage?: Record<string, unknown> } };
          try {
            rec = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (rec.type !== 'assistant') continue;
          const u = rec.message?.usage;
          if (!u) continue;
          usage.inputTokens += num(u.input_tokens);
          usage.outputTokens += num(u.output_tokens);
          usage.cacheWriteTokens += num(u.cache_creation_input_tokens);
          usage.cacheReadTokens += num(u.cache_read_input_tokens);
        }
      } catch {
        // Skip this file; keep accumulating across the rest.
      }
    }
    usage.estimatedCostUsd =
      (usage.inputTokens / 1_000_000) * PRICE_INPUT_PER_M +
      (usage.outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M +
      (usage.cacheReadTokens / 1_000_000) * PRICE_CACHE_READ_PER_M +
      (usage.cacheWriteTokens / 1_000_000) * PRICE_CACHE_WRITE_PER_M;
    return usage;
  } catch {
    return zero();
  }
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
