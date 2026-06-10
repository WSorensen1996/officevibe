import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileText, writeFileText, listDir } from '../src/main/fs';

// realpath the temp base so macOS /tmp → /private/tmp doesn't confuse containment.
const base = realpathSync(mkdtempSync(join(tmpdir(), 'officevibe-fs-')));
const root = join(base, 'project');
const outside = join(base, 'secret.txt');
mkdirSync(root, { recursive: true });
writeFileSync(outside, 'TOP SECRET', 'utf8');
writeFileSync(join(root, 'inside.txt'), 'hello', 'utf8');

afterAll(() => { try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ } });

describe('safeJoin path confinement (via fs public API)', () => {
  it('reads a legitimate file inside the root', async () => {
    const res = await readFileText(root, 'inside.txt');
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.content).toBe('hello');
  });

  it('rejects lexical ../ traversal', async () => {
    const res = await readFileText(root, '../secret.txt');
    expect(res.ok).toBe(false);
  });

  it('rejects an absolute path outside the root', async () => {
    const res = await readFileText(root, outside);
    expect(res.ok).toBe(false);
  });

  it('rejects reading THROUGH a symlink that escapes the root', async () => {
    symlinkSync(outside, join(root, 'escape-link'));
    const res = await readFileText(root, 'escape-link');
    // The symlink is lexically inside root, but realpath resolves outside it.
    expect(res.ok).toBe(false);
    if (res.ok) expect(res.content).not.toContain('TOP SECRET');
  });

  it('rejects WRITING through a symlinked directory that escapes the root', async () => {
    symlinkSync(base, join(root, 'escape-dir')); // escape-dir → base (parent of root)
    const res = await writeFileText(root, 'escape-dir/pwned.txt', 'x');
    expect(res.ok).toBe(false);
  });

  it('allows writing a NEW file inside the root (path need not pre-exist)', async () => {
    // writeFileText doesn't create parent dirs, so target the root directly —
    // the point is that a not-yet-existing file still passes the realpath guard.
    const res = await writeFileText(root, 'new.txt', 'fresh');
    expect(res.ok).toBe(true);
  });

  it('lists the root directory', async () => {
    const res = await listDir(root, '.');
    expect(res.ok).toBe(true);
  });
});
