import { mkdir, readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path';

/**
 * Confines `path` inside `root` to prevent path-traversal escapes.
 * Returns the resolved absolute path on success, or null on violation.
 */
function safeJoin(root: string, rel: string): string | null {
  const absRoot = resolve(root);
  const absPath = isAbsolute(rel) ? normalize(rel) : resolve(absRoot, rel);
  const rel2 = relative(absRoot, absPath);
  if (rel2.startsWith('..') || isAbsolute(rel2)) return null;
  return absPath;
}

export interface DirEntry {
  name: string;
  isDir: boolean;
  size: number;
  mtime: number;
}

export async function listDir(root: string, rel: string): Promise<{
  ok: true; entries: DirEntry[]; path: string;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const names = await readdir(abs);
    const entries = await Promise.all(names.map(async (name): Promise<DirEntry> => {
      try {
        const s = await stat(join(abs, name));
        return { name, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs };
      } catch {
        return { name, isDir: false, size: 0, mtime: 0 };
      }
    }));
    entries.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    return { ok: true, entries, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const MAX_READ_BYTES = 2 * 1024 * 1024; // 2 MB
const MAX_WRITE_BYTES = 5 * 1024 * 1024; // 5 MB — guards the text write path

export async function readFileText(root: string, rel: string): Promise<{
  ok: true; content: string; path: string; size: number;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const s = await stat(abs);
    if (s.size > MAX_READ_BYTES) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await readFile(abs);
    // Reject obvious binary files based on null-byte sniff
    if (buf.includes(0)) return { ok: false, error: 'binary file (not displayable)' };
    return { ok: true, content: buf.toString('utf8'), path: abs, size: s.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function writeFileText(root: string, rel: string, content: string): Promise<{
  ok: true; path: string;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  if (Buffer.byteLength(content, 'utf8') > MAX_WRITE_BYTES) {
    return { ok: false, error: `content too large (max ${MAX_WRITE_BYTES / 1024 / 1024} MB)` };
  }
  try {
    await writeFile(abs, content, 'utf8');
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// Generous cap for pasted images / attachments (the text path stays at 2 MB).
const MAX_ATTACH_BYTES = 25 * 1024 * 1024; // 25 MB

/** Write a base64-decoded buffer under `root`, creating parent dirs as needed.
 *  The binary sibling of writeFileText — used for task attachments (text-only
 *  writeFileText can't hold image bytes). */
export async function writeFileBinary(root: string, rel: string, base64: string): Promise<{
  ok: true; path: string;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const buf = Buffer.from(base64, 'base64');
    if (buf.length > MAX_ATTACH_BYTES) {
      return { ok: false, error: `file too large (${(buf.length / 1024 / 1024).toFixed(1)} MB, max 25 MB)` };
    }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buf);
    return { ok: true, path: abs };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', avif: 'image/avif',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  csv: 'text/csv', zip: 'application/zip'
};

/** Read a file under `root` and return it as a data: URL (mime guessed from the
 *  extension). The binary counterpart of readFileText — lets the renderer show
 *  attachment thumbnails without ever handling a file:// path. */
export async function readFileBinary(root: string, rel: string): Promise<{
  ok: true; dataUrl: string; size: number;
} | { ok: false; error: string }> {
  const abs = safeJoin(root, rel);
  if (!abs) return { ok: false, error: 'path escapes root' };
  try {
    const s = await stat(abs);
    if (s.size > MAX_ATTACH_BYTES) {
      return { ok: false, error: `file too large (${(s.size / 1024 / 1024).toFixed(1)} MB)` };
    }
    const buf = await readFile(abs);
    const dot = abs.lastIndexOf('.');
    const ext = dot >= 0 ? abs.slice(dot + 1).toLowerCase() : '';
    const mime = MIME_BY_EXT[ext] ?? 'application/octet-stream';
    return { ok: true, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, size: s.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
