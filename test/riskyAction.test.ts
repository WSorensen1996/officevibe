import { describe, expect, it } from 'vitest';
import { isRiskyAction, expandAnsiCEscapes } from '../src/main/riskyAction';

const bash = (command: string) => isRiskyAction('Bash', { command });

describe('isRiskyAction — Bash heuristic', () => {
  it('treats ordinary read/build commands as safe', () => {
    for (const c of ['ls -la', 'cat file.txt', 'npm run build', 'grep -r foo .', 'echo hi 2>/dev/null']) {
      expect(bash(c), c).toBe(false);
    }
  });

  it('flags the classic destructive commands', () => {
    for (const c of ['rm -rf build', 'git push origin main', 'sudo apt install x', 'chmod -R 777 .', 'dd if=/dev/zero of=x']) {
      expect(bash(c), c).toBe(true);
    }
  });

  it('flags bypass shapes that the old literal-only list missed', () => {
    const cases = [
      'find . -name "*.log" -delete', // find -delete
      'truncate -s 0 important.db',   // truncate
      'sed -i "s/a/b/" config.yml',   // in-place edit
      'perl -i -pe "s/x/y/" f',       // in-place edit
      'bash /tmp/payload.sh',         // run an external script file
      'bash -c "$DESTRUCTIVE"',       // inline code with the payload in a var
      'eval "$(cat cmds)"',           // eval indirection
      'python3 -c "import os; os.remove(\'x\')"', // interpreter inline
      "$'\\x72\\x6d' -rf /tmp/x"      // hex-escaped `rm`
    ];
    for (const c of cases) expect(bash(c), c).toBe(true);
  });
});

describe('isRiskyAction — MCP heuristic', () => {
  it('flags outbound/destructive MCP actions, including neutrally-named sends', () => {
    for (const t of ['mcp__gmail__send_email', 'mcp__slack__post_message', 'mcp__drive__delete_file',
      'mcp__gmail__compose_and_transmit', 'mcp__pay__charge_card']) {
      expect(isRiskyAction(t, {}), t).toBe(true);
    }
  });

  it('treats read-only MCP tools as safe', () => {
    for (const t of ['mcp__db__list_rows', 'mcp__drive__get_file', 'mcp__search__query']) {
      expect(isRiskyAction(t, {}), t).toBe(false);
    }
  });
});

describe('expandAnsiCEscapes', () => {
  it('expands hex and octal escapes inside $\'...\'', () => {
    expect(expandAnsiCEscapes("$'\\x72\\x6d'")).toBe('rm');
    expect(expandAnsiCEscapes("$'\\162\\155'")).toBe('rm');
    expect(expandAnsiCEscapes('plain text')).toBe('plain text');
  });
});
