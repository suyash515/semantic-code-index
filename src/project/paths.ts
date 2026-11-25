/**
 * The single shared path resolver (spec §6.3). Every file operation in the
 * package goes through these functions.
 */
import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import path from 'node:path';
import { SemanticIndexError } from '../errors.js';

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_PATH_LENGTH = 4096;
const IS_WINDOWS = process.platform === 'win32';
/** Platforms whose default filesystems are case-insensitive. */
export const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

function invalid(message: string): SemanticIndexError {
  return new SemanticIndexError('INVALID_PATH', message);
}

/**
 * Lexically validate and normalize a project-relative path.
 * Returns a canonical POSIX relative path (no leading `./`, no trailing slash).
 */
export function normalizeRelativePath(input: unknown, { windows = IS_WINDOWS } = {}): string {
  if (typeof input !== 'string' || input.length === 0) throw invalid('Path must be a nonempty project-relative string.');
  if (input.length > MAX_PATH_LENGTH) throw invalid('Path is too long.');
  if (CONTROL_CHARS.test(input)) throw invalid('Path contains NUL or control characters.');
  let p = input;
  if (p.includes('\\')) {
    if (!windows) throw invalid('Backslashes are not accepted as path separators on this platform; use "/".');
    p = p.replace(/\\/g, '/');
  }
  if (p.startsWith('//')) throw invalid('UNC paths are not allowed; use a project-relative path.');
  if (p.startsWith('/')) throw invalid('Absolute paths are not allowed; use a project-relative path.');
  if (/^[A-Za-z]:/.test(p)) throw invalid('Drive-prefixed paths are not allowed; use a project-relative path.');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') throw invalid('Path traversal ("..") is not allowed.');
    parts.push(seg);
  }
  if (parts.length === 0) throw invalid('Path must name a file inside the project.');
  return parts.join('/');
}

/** Normalize an optional directory scope to a prefix ending in `/`, or null for the whole project. */
export function normalizePrefix(input: unknown): string | null {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'string') throw invalid('path_prefix must be a string.');
  const trimmed = input.trim();
  if (trimmed === '' || trimmed === '.' || trimmed === './' || trimmed === '/') {
    if (trimmed === '/') throw invalid('Absolute paths are not allowed; use a project-relative path.');
    return null;
  }
  return `${normalizeRelativePath(trimmed)}/`;
}

/** Whole-component prefix match. `api/` matches `api/x.js` but not `api-old/x.js`. */
export function isWithinPrefix(relPath: string, prefix: string | null): boolean {
  return prefix === null || relPath.startsWith(prefix);
}

/** Path-aware containment test (not a string-prefix test). */
export function isContained(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  if (rel === '') return true;
  return !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
}

/** Join a validated relative path to the root, verifying lexical containment. */
export function toAbsolute(root: string, relPath: string): string {
  const abs = path.join(root, ...relPath.split('/'));
  if (!isContained(root, abs)) throw invalid('Path escapes the project root.');
  return abs;
}

/** Resolve the project root once: real absolute directory. */
export async function resolveRoot(input?: string): Promise<string> {
  const candidate = path.resolve(process.cwd(), input ?? '.');
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new SemanticIndexError('INVALID_INPUT', 'Project root does not exist or cannot be resolved.');
  }
  const st = await stat(real).catch(() => null);
  if (!st || !st.isDirectory()) throw new SemanticIndexError('INVALID_INPUT', 'Project root is not a directory.');
  return real;
}

export type PathInspection =
  | { kind: 'file'; abs: string; stat: Stats }
  | { kind: 'missing' }
  | { kind: 'symlink' }
  | { kind: 'not-file' }
  | { kind: 'case-mismatch' }
  | { kind: 'error'; code: string };

/**
 * Walk each component from the root with lstat, rejecting symlinks/junctions anywhere,
 * then confirm the realpath is still inside the root. Never follows links.
 */
export async function inspectPath(root: string, relPath: string): Promise<PathInspection> {
  const parts = relPath.split('/');
  let current = root;
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const next = path.join(current, name);
    let st: Stats;
    try {
      st = await lstat(next);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      return { kind: 'error', code };
    }
    if (st.isSymbolicLink()) return { kind: 'symlink' };
    if (CASE_INSENSITIVE_FS) {
      try {
        const entries = await readdir(current);
        if (!entries.includes(name)) return { kind: 'case-mismatch' };
      } catch (err) {
        return { kind: 'error', code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
      }
    }
    const last = i === parts.length - 1;
    if (!last && !st.isDirectory()) return { kind: 'missing' };
    if (last && !st.isFile()) return { kind: 'not-file' };
    current = next;
    if (last) {
      try {
        const real = await realpath(current);
        if (!isContained(root, real)) return { kind: 'symlink' };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
        if (code === 'ENOENT') return { kind: 'missing' };
        return { kind: 'error', code };
      }
      return { kind: 'file', abs: current, stat: st };
    }
  }
  return { kind: 'missing' };
}

/** Lstat-walk a directory scope (prefix) and confirm each component is a real directory. */
export async function inspectDirectory(root: string, relDir: string): Promise<'dir' | 'missing' | 'invalid' | 'error'> {
  let current = root;
  for (const name of relDir.split('/').filter(Boolean)) {
    current = path.join(current, name);
    try {
      const st = await lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) return 'invalid';
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return 'missing';
      return 'error';
    }
  }
  return 'dir';
}
