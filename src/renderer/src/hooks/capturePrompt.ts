/**
 * Read the on-screen prompt out of an agent's (always-live, pooled) xterm buffer
 * and classify it into a BlockReason the messages-tab card can render.
 *
 * Why this works without touching the main process: every agent's terminal is
 * pre-warmed (App.tsx) and subscribes to its pty stream for the terminal's whole
 * lifetime (terminalPool.acquireTerminal), so `term.buffer.active` is a fully
 * rendered, scrollback-complete grid at all times — even when no terminal tab is
 * mounted. We just read the bottom rows on demand when an agent goes blocked.
 *
 * Detection is anchored to the BOTTOM of the screen (the live prompt). Matching the
 * whole tail would pick up a stale menu / "(y/n)" still sitting in scrollback and
 * falsely mark an idle agent as blocked — which would drop it from the autonomous
 * wake-nudge / message-drain loops. So a prompt only counts when nothing but chrome
 * sits below it.
 */
import { acquireTerminal } from '@/components/terminalPool';
import type { BlockReason } from '@/store/store';

// Claude colors its TUI with SGR escapes; translateToString already resolves the
// grid, but strip any stray sequences defensively.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
// Claude renders prompts inside a box; strip a leading/trailing vertical border so
// "│ ❯ 1. Yes              │" classifies as "❯ 1. Yes".
const LBORDER_RE = /^\s*[│┃|]\s?/;
const RBORDER_RE = /\s*[│┃|]\s*$/;

// A numbered selection item, e.g. "❯ 1. Yes" / "  2. Yes, and don't ask again…".
const MENU_ITEM_RE = /^\s*[❯>▶]?\s*(\d+)[.)]\s+(.+?)\s*$/;
const PROCEED_RE = /Do you want to proceed/i;
// Inline yes/no confirmation, e.g. "Overwrite file? (y/n)".
const YESNO_RE = /[([]\s*y\s*\/\s*n\s*[)\]]/i;

/**
 * Read the last `lines` rendered rows of the agent's xterm buffer (what's on
 * screen now), with box borders stripped and trailing blank rows trimmed. Returns
 * '' if the terminal can't be read.
 */
export function readPtyTail(ptyId: string, lines = 40): string {
  try {
    const { term } = acquireTerminal(ptyId);
    const buf = term.buffer.active;
    // Read from the buffer's actual end (the current screen is always at the
    // bottom). Using buf.length (not the viewport) keeps this correct even for a
    // terminal whose tab was never opened — or one on the alternate screen buffer.
    const end = buf.length - 1;
    const start = Math.max(0, end - lines + 1);
    const rows: string[] = [];
    for (let i = start; i <= end; i++) {
      const raw = (buf.getLine(i)?.translateToString(true) ?? '').replace(ANSI_RE, '');
      rows.push(raw.replace(LBORDER_RE, '').replace(RBORDER_RE, ''));
    }
    // Trim trailing blank rows so "the bottom" means the last real content.
    while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
    return rows.join('\n');
  } catch {
    return '';
  }
}

/** TUI chrome we never want to treat as a prompt (footer / box borders / input box). */
function isChrome(line: string): boolean {
  const t = line.trim();
  if (!t) return true;
  return (
    /esc to interrupt/i.test(t) ||
    /for shortcuts/i.test(t) ||
    /bypass permissions/i.test(t) ||
    /^[\s│─╭╮╰╯└┘┌┐┏┓┗┛━┃|>❯▶_·•⏎]+$/.test(t)
  );
}

/** True if every line below `idx` is empty/chrome — i.e. `idx` is the live prompt
 *  at the bottom of the screen, not a stale one buried under newer output. */
function onlyChromeBelow(lines: string[], idx: number): boolean {
  if (idx < 0) return false;
  for (let i = idx + 1; i < lines.length; i++) {
    if (!isChrome(lines[i])) return false;
  }
  return true;
}

/** Last non-chrome line ending in '?' within `lines` (the question). */
function lastQuestionLine(lines: string[]): string | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    if (t.endsWith('?') && !isChrome(t)) return t;
  }
  return undefined;
}

/** Canonical short label + button kind for a numbered menu item. */
function labelFor(itemText: string): { label: string; kind: 'approve' | 'deny' | 'neutral' } {
  if (/^yes\b.*(don['’]t ask|do not ask|and)/i.test(itemText)) return { label: 'Always allow', kind: 'neutral' };
  if (/^yes\b/i.test(itemText)) return { label: 'Approve', kind: 'approve' };
  if (/^no\b/i.test(itemText)) return { label: 'Deny', kind: 'deny' };
  const short = itemText.length > 24 ? itemText.slice(0, 23) + '…' : itemText;
  return { label: short, kind: 'neutral' };
}

/** Best-effort: the action being confirmed (line above the question). */
function extractCommand(lines: string[], questionIdx: number): string | undefined {
  for (let i = questionIdx - 1; i >= 0 && i >= questionIdx - 6; i--) {
    const t = lines[i].trim();
    if (!t || MENU_ITEM_RE.test(lines[i]) || isChrome(t)) continue;
    return t.length > 120 ? t.slice(0, 119) + '…' : t;
  }
  return undefined;
}

/**
 * Classify a captured PTY tail into a BlockReason, or null if no LIVE prompt is at
 * the bottom of the screen (the false-positive guard — callers must NOT force
 * 'blocked' on null). Detects three shapes: a numbered permission menu, an inline
 * (y/n) confirmation, or (conservatively) a free-text question Claude is waiting on.
 */
export function classifyPrompt(tail: string): BlockReason | null {
  if (!tail.trim()) return null;
  const lines = tail.split('\n');

  // 1) Numbered approval menu (Claude Code's permission box). Requires a Yes+No
  //    pair, and that the menu is the live bottom element (nothing but chrome below
  //    its last item) so a stale menu in scrollback can't trigger it.
  const menu: Array<{ idx: number; index: number; label: string }> = [];
  let proceedIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = MENU_ITEM_RE.exec(lines[i]);
    if (m) menu.push({ idx: i, index: parseInt(m[1], 10), label: m[2].trim() });
    if (PROCEED_RE.test(lines[i])) proceedIdx = i;
  }
  const hasYes = menu.some((i) => /^yes\b/i.test(i.label));
  const hasNo = menu.some((i) => /^no\b/i.test(i.label));
  const lastMenuIdx = menu.length ? menu[menu.length - 1].idx : -1;
  if (menu.length >= 2 && hasYes && hasNo && onlyChromeBelow(lines, lastMenuIdx)) {
    const summary = (proceedIdx >= 0 && proceedIdx <= lastMenuIdx ? lines[proceedIdx].trim() : '')
      || lastQuestionLine(lines.slice(0, lastMenuIdx + 1))
      || 'Approve this action?';
    const anchor = proceedIdx >= 0 ? proceedIdx : menu[0].idx;
    return {
      promptKind: 'menu',
      summary,
      detail: 'Answer here, or in the agent’s terminal.',
      command: extractCommand(lines, anchor),
      menuItems: menu.map((i) => ({ index: i.index, label: i.label, send: `${i.index}\r` })),
      actions: menu.map((i) => {
        const { label, kind } = labelFor(i.label);
        return { label, kind, send: `${i.index}\r` };
      })
    };
  }

  // 2) Inline (y/n) confirmation — must be the bottom-most non-chrome line.
  // 3) Free-text question — the bottom-most non-chrome line ends with '?'.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (isChrome(lines[i])) continue;
    const t = lines[i].trim();
    if (YESNO_RE.test(t)) {
      return {
        promptKind: 'yesno',
        summary: t,
        detail: 'Answer here, or in the agent’s terminal.',
        actions: [
          { label: 'Approve', kind: 'approve', send: 'y\r' },
          { label: 'Deny', kind: 'deny', send: 'n\r' }
        ]
      };
    }
    if (t.endsWith('?')) {
      return { promptKind: 'text', summary: t, detail: 'Type your answer below.', actions: [] };
    }
    return null; // bottom-most real line is neither → not a prompt
  }

  return null;
}

/** Last-resort card when we know an agent needs input but couldn't parse the
 *  prompt. Defaults to Claude Code's standard 3-option permission menu keystrokes
 *  (1=yes, 2=always, 3=no), which is by far the most common blocking prompt. */
export function genericBlockReason(): BlockReason {
  return {
    promptKind: 'menu',
    summary: 'An agent needs your approval',
    detail: 'Couldn’t read the exact prompt — choose below, or open the terminal to see it.',
    menuItems: [
      { index: 1, label: 'Yes', send: '1\r' },
      { index: 2, label: 'Yes, and don’t ask again', send: '2\r' },
      { index: 3, label: 'No', send: '3\r' }
    ],
    actions: [
      { label: 'Approve', kind: 'approve', send: '1\r' },
      { label: 'Always allow', kind: 'neutral', send: '2\r' },
      { label: 'Deny', kind: 'deny', send: '3\r' }
    ]
  };
}

// --- post-answer guard (content-aware) ---------------------------------------
// When the user answers, the prompt lingers in the buffer for a beat before Claude
// repaints. We must suppress re-raising THAT prompt — but a DIFFERENT prompt that
// appears right after (e.g. approving one tool leads straight into another) must
// surface immediately. So we remember a signature of the answered prompt and only
// suppress while the freshly-classified prompt matches it.
const answered = new Map<string, { sig: string; ts: number }>();

export function signatureOf(r: BlockReason): string {
  return [r.promptKind ?? '', r.summary, r.command ?? '', (r.menuItems ?? []).map((m) => m.label).join(',')].join('|');
}
export function markAnswered(agentId: string, reason: BlockReason): void {
  answered.set(agentId, { sig: signatureOf(reason), ts: Date.now() });
}
/** True if `reason` is the same prompt the user just answered (still painting). */
export function isJustAnswered(agentId: string, reason: BlockReason, withinMs = 4000): boolean {
  const a = answered.get(agentId);
  return !!a && Date.now() - a.ts < withinMs && a.sig === signatureOf(reason);
}
