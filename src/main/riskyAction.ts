/**
 * Best-effort "is this tool call destructive/outbound?" heuristic for the approval
 * gate (see hooks.ts). Kept electron-free and side-effect-free so the patterns can
 * be unit-tested directly.
 *
 * IMPORTANT — this is a heuristic, NOT a sandbox. Its job is to catch *common*
 * destructive shapes so a full-auto (autoMode) agent doesn't quietly do something
 * irreversible. An agent already has full shell in its project and can defeat these
 * patterns — indirection (`bash -c "$VAR"`), obfuscation, a tool the list doesn't
 * know. The real safeguard is running OfficeVibe only on projects/tools you trust;
 * this gate just reduces foot-guns.
 *
 * Risky Bash: deletes, in-place rewrites, history/remote rewrites, disk/permission
 * changes, privilege escalation, process/power control, pipe-to-shell, indirect
 * interpreters, publish/deploy.
 */
export const RISKY_BASH: RegExp[] = [
  /\brm\b/, /\brmdir\b/, /\bunlink\b/, /\bshred\b/,
  /\bfind\b[^|]*-delete\b/, /\b(?:truncate|fallocate)\b/, />\s*\/dev\/(?:sd|nvme|disk|mmcblk|vd)/,
  /\bsed\b[^|]*\s-i/, /\bperl\b[^|]*\s-i\b/,
  /\bgit\s+push\b/, /\bgit\s+reset\s+--hard\b/, /\bgit\s+clean\s+-[a-z]*f/, /\bgit\s+branch\s+-D\b/,
  /\bdd\b\s+if=/, /\bmkfs\b/, /\bchmod\s+-R\b/, /\bchown\s+-R\b/,
  /\bsudo\b/, /\bsu\s/,
  /\bkill(all)?\b/, /\bpkill\b/, /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
  /\|\s*(sh|bash|zsh)\b/, /\b(curl|wget)\b[^|]*\|/,
  // Indirect execution — the destructive payload hides in a var/file/inline string,
  // so the literal patterns above can't see it. Surface the card to be safe.
  /\beval\b/, /\b(?:bash|sh|zsh|dash|ksh|fish)\s+-[A-Za-z]*c\b/,
  /\b(?:bash|sh|zsh|dash|ksh)\s+(?:-[A-Za-z]+\s+)*\S*\.(?:sh|bash|zsh)\b/,
  // Language interpreters running inline code: python/php use -c, perl/ruby/node use -e.
  /\b(?:python3?|perl|ruby|node|php)\s+-[A-Za-z]*[ce]\b/,
  /\b(npm|yarn|pnpm)\s+publish\b/, /\bdocker\s+push\b/, /\bgh\s+release\b/, /\bnpm\s+run\s+deploy\b/
];

// Risky MCP tool name fragments: outbound sends / deletes / payments. The MCP tool
// id is `mcp__<server>__<action>`, so a substring match on the lowercased id flags
// e.g. gmail send/compose/transmit, slack post, calendar/drive delete, a payment
// charge. Heuristic only — a server can always name an outbound action neutrally.
export const RISKY_MCP = [
  'send', 'delete', 'remove', 'trash', 'payment', 'charge', 'transfer', 'publish', 'post',
  'email', 'mail', 'dispatch', 'transmit', 'compose', 'notify', 'upload'
];

/** Expand bash `$'...'` ANSI-C escapes (\xHH hex, \NNN octal) so a command hiding a
 *  risky token as `$'\x72\x6d -rf'` is still tested against the patterns. Best-effort
 *  — bash has other forms (printf, var indirection) this can't statically resolve. */
export function expandAnsiCEscapes(cmd: string): string {
  return cmd.replace(/\$'((?:[^'\\]|\\.)*)'/g, (_m, body: string) =>
    body
      .replace(/\\x([0-9a-fA-F]{2})/g, (_s, h: string) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\([0-7]{1,3})/g, (_s, o: string) => String.fromCharCode(parseInt(o, 8)))
  );
}

/** True when a tool call is destructive/outbound and should surface the approval
 *  card even under autoMode. Read/search/edit tools and read-only MCP are safe.
 *  See the heuristic caveat above — a foot-gun reducer, not a sandbox. */
export function isRiskyAction(tool: string, input: unknown): boolean {
  if (tool === 'Bash') {
    const raw = (input && typeof input === 'object' && 'command' in input)
      ? String((input as { command?: unknown }).command ?? '') : '';
    // Test the raw command AND an escape-expanded copy (newline-joined so neither
    // form's matches are lost) to catch hex/octal-obfuscated risky tokens.
    const cmd = raw + '\n' + expandAnsiCEscapes(raw);
    return RISKY_BASH.some((re) => re.test(cmd));
  }
  if (tool.startsWith('mcp__')) {
    const t = tool.toLowerCase();
    return RISKY_MCP.some((v) => t.includes(v));
  }
  return false;
}
