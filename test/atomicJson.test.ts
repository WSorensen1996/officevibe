import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { atomicWriteJson, atomicWriteFile, rotateIfLarge } from '../src/main/atomicJson';

const base = mkdtempSync(join(tmpdir(), 'officevibe-atomic-'));
afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ } });

function tmpResidue(dir: string, name: string): string[] {
  return readdirSync(dir).filter((f) => f.startsWith(`${name}.tmp-`));
}

describe('atomicWriteJson', () => {
  let target: string;
  beforeEach(() => { target = join(base, `state-${Math.random().toString(36).slice(2)}.json`); });

  it('writes valid JSON that reads back equal to the input', () => {
    const data = { tasks: [{ id: 'a', status: 'doing' }], n: 42 };
    atomicWriteJson(target, data);
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual(data);
  });

  it('overwrites an existing file (and leaves no .tmp residue)', () => {
    atomicWriteJson(target, { v: 1 });
    atomicWriteJson(target, { v: 2 });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ v: 2 });
    expect(tmpResidue(dirname(target), basename(target))).toEqual([]);
  });

  it('never exposes a partial file — the target is only ever the complete old or new content', () => {
    // Atomicity is via rename: the temp holds the in-progress bytes, the target is
    // swapped in one syscall. Assert the temp is gone and the target is complete JSON.
    atomicWriteJson(target, { complete: true, items: [1, 2, 3] });
    expect(() => JSON.parse(readFileSync(target, 'utf8'))).not.toThrow();
    expect(tmpResidue(dirname(target), basename(target))).toEqual([]);
  });

  it('applies the requested POSIX mode to the FINAL file', () => {
    atomicWriteJson(target, { secret: true }, { mode: 0o600 });
    // Skip the assertion on platforms without POSIX perms (Windows reports 0o666).
    if (process.platform !== 'win32') {
      expect(statSync(target).mode & 0o777).toBe(0o600);
    }
  });

  it('succeeds even if a stale temp path happens to exist', () => {
    // A leftover temp from a prior crash must not block a fresh write.
    writeFileSync(`${target}.tmp-deadbeef`, 'garbage', 'utf8');
    atomicWriteJson(target, { ok: true });
    expect(JSON.parse(readFileSync(target, 'utf8'))).toEqual({ ok: true });
  });
});

describe('atomicWriteFile', () => {
  it('writes raw string content atomically', () => {
    const target = join(base, 'raw.txt');
    atomicWriteFile(target, 'hello world');
    expect(readFileSync(target, 'utf8')).toBe('hello world');
  });
});

describe('rotateIfLarge', () => {
  it('rotates a file over the cap to .1 (preserving old content) and resets the primary', () => {
    const log = join(base, 'log.jsonl');
    writeFileSync(log, 'x'.repeat(2048), 'utf8');
    rotateIfLarge(log, 1024); // over cap → rotate
    expect(existsSync(log)).toBe(false);                 // primary moved away
    expect(readFileSync(`${log}.1`, 'utf8').length).toBe(2048); // history preserved
    // A subsequent appender re-creates `log`; the rotated copy stays as one generation.
  });

  it('is a no-op when the file is under the cap', () => {
    const log = join(base, 'small.jsonl');
    writeFileSync(log, 'tiny', 'utf8');
    rotateIfLarge(log, 1024);
    expect(readFileSync(log, 'utf8')).toBe('tiny');
    expect(existsSync(`${log}.1`)).toBe(false);
  });

  it('is a no-op when the file is absent', () => {
    expect(() => rotateIfLarge(join(base, 'nope.jsonl'), 1024)).not.toThrow();
  });

  it('overwrites a previous rotation (keeps only one generation)', () => {
    const log = join(base, 'rot.jsonl');
    writeFileSync(`${log}.1`, 'OLD', 'utf8');
    writeFileSync(log, 'y'.repeat(2048), 'utf8');
    rotateIfLarge(log, 1024);
    expect(readFileSync(`${log}.1`, 'utf8').length).toBe(2048); // previous .1 replaced
  });
});
