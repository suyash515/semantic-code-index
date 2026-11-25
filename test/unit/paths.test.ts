import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { normalizeRelativePath, normalizePrefix, isWithinPrefix, isContained, inspectPath, resolveRoot, toAbsolute } from '../../src/project/paths.js';
import { tempDir, writeFiles } from '../helpers/fixtures.js';

const bad = (p: unknown, opts?: { windows?: boolean }) => expect(() => normalizeRelativePath(p, opts)).toThrowError(expect.objectContaining({ code: 'INVALID_PATH' }));

describe('normalizeRelativePath', () => {
  it('normalizes . and redundant separators', () => {
    expect(normalizeRelativePath('./src//a/./b.ts')).toBe('src/a/b.ts');
    expect(normalizeRelativePath('src/')).toBe('src');
    expect(normalizeRelativePath('Src/File.TS')).toBe('Src/File.TS');
    expect(normalizeRelativePath('dir with space/naïve ü.ts')).toBe('dir with space/naïve ü.ts');
  });
  it('rejects absolute, UNC, drive, traversal, control chars, empty', () => {
    bad('/etc/passwd');
    bad('//server/share/x');
    bad('C:/x');
    bad('c:x');
    bad('../x');
    bad('a/../../x');
    bad('a/..');
    bad('a\u0000b');
    bad('a\nb');
    bad('');
    bad('.');
    bad('./');
    bad(42);
    bad('x'.repeat(5000));
  });
  it('rejects backslashes on POSIX but accepts them on Windows', () => {
    bad('src\\a.ts', { windows: false });
    expect(normalizeRelativePath('src\\a.ts', { windows: true })).toBe('src/a.ts');
    bad('\\\\server\\share', { windows: true });
    bad('C:\\x', { windows: true });
  });
});

describe('prefix', () => {
  it('normalizes and matches whole components', () => {
    expect(normalizePrefix('api')).toBe('api/');
    expect(normalizePrefix('api/')).toBe('api/');
    expect(normalizePrefix('./api//v1/')).toBe('api/v1/');
    expect(normalizePrefix(undefined)).toBeNull();
    expect(normalizePrefix('')).toBeNull();
    expect(normalizePrefix('.')).toBeNull();
    expect(() => normalizePrefix('/')).toThrow();
    expect(() => normalizePrefix('../x')).toThrow();
    expect(isWithinPrefix('api/helpers/x.js', 'api/')).toBe(true);
    expect(isWithinPrefix('api-old/x.js', 'api/')).toBe(false);
    expect(isWithinPrefix('apix.js', 'api/')).toBe(false);
    expect(isWithinPrefix('anything', null)).toBe(true);
  });
});

describe('containment', () => {
  it('is path-aware, not a string prefix test', () => {
    expect(isContained('/a/root', '/a/root/x')).toBe(true);
    expect(isContained('/a/root', '/a/root')).toBe(true);
    expect(isContained('/a/root', '/a/root2/x')).toBe(false);
    expect(isContained('/a/root', '/a/x')).toBe(false);
    expect(isContained('/a/root', '/a/root/..x/y')).toBe(true);
    expect(toAbsolute('/a/root', 'b/c')).toBe(path.join('/a/root', 'b', 'c'));
  });
});

describe('inspectPath', () => {
  it('classifies files, missing, symlinks in any component, and non-files', async () => {
    const root = tempDir();
    const outside = tempDir();
    writeFiles(root, { 'src/a.ts': 'x', 'real/b.ts': 'y' });
    writeFileSync(path.join(outside, 'secret.txt'), 's');
    symlinkSync(path.join(root, 'real'), path.join(root, 'linkdir'));
    symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'src', 'link.txt'));
    mkdirSync(path.join(root, 'emptydir'));
    expect((await inspectPath(root, 'src/a.ts')).kind).toBe('file');
    expect((await inspectPath(root, 'src/nope.ts')).kind).toBe('missing');
    expect((await inspectPath(root, 'nope/x.ts')).kind).toBe('missing');
    expect((await inspectPath(root, 'src/a.ts/x')).kind).toBe('missing');
    expect((await inspectPath(root, 'linkdir/b.ts')).kind).toBe('symlink');
    expect((await inspectPath(root, 'src/link.txt')).kind).toBe('symlink');
    expect((await inspectPath(root, 'emptydir')).kind).toBe('not-file');
  });
  it('resolveRoot returns a real directory and rejects files/missing', async () => {
    const root = tempDir();
    writeFiles(root, { 'f.txt': 'x' });
    expect(await resolveRoot(root)).toBe(root);
    await expect(resolveRoot(path.join(root, 'f.txt'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(resolveRoot(path.join(root, 'missing'))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
