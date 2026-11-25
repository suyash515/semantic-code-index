import { describe, expect, it } from 'vitest';
import { mkdirSync, symlinkSync, chmodSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { Project, compareUtf8 } from '../../src/project/scanner.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { git, gitInit, makeProject, writeFiles } from '../helpers/fixtures.js';

const cfg = () => defaultConfig();

describe('git scanner', () => {
  it('lists tracked + untracked, excludes ignored, keeps tracked-then-ignored, handles whitespace/unicode', async () => {
    const root = makeProject(
      {
        '.gitignore': 'ignored/\n*.log\ntracked-ignored.txt\n',
        'src/a.ts': 'a',
        'src/b c.ts': 'b',
        'src/ünï.ts': 'u',
        'ignored/x.ts': 'x',
        'debug.log': 'l',
        'tracked-ignored.txt': 't',
        'node_modules/m/index.js': 'm',
        '.env': 'SECRET=1',
        'img.png': 'notreally'
      },
      { git: true }
    );
    git(root, 'add', '-f', 'tracked-ignored.txt', 'src/a.ts');
    git(root, 'commit', '-qm', 'init');
    const p = new Project(root, cfg());
    const s = await p.scan(null);
    expect(s.mode).toBe('git');
    expect(s.complete).toBe(true);
    expect(s.paths).toEqual(['src/a.ts', 'src/b c.ts', 'src/ünï.ts', 'tracked-ignored.txt']);
    expect((await p.scan('src/')).paths).toEqual(['src/a.ts', 'src/b c.ts', 'src/ünï.ts']);
    expect((await p.scan('nope/')).paths).toEqual([]);
  });

  it('nested root only enumerates its own subtree', async () => {
    const repo = makeProject({ 'outside.ts': 'o', 'pkg/inner.ts': 'i', 'pkg/sub/deep.ts': 'd' }, { git: true });
    const p = new Project(path.join(repo, 'pkg'), cfg());
    const s = await p.scan(null);
    expect(s.mode).toBe('git');
    expect(s.paths).toEqual(['inner.ts', 'sub/deep.ts']);
  });

  it('does not recurse into nested repositories or submodules', async () => {
    const root = makeProject({ 'a.ts': 'a' }, { git: true });
    const nested = path.join(root, 'nested');
    mkdirSync(nested);
    gitInit(nested);
    writeFiles(nested, { 'n.ts': 'n' });
    git(nested, 'add', '.');
    git(nested, 'commit', '-qm', 'n');
    const p = new Project(root, cfg());
    expect((await p.scan(null)).paths).toEqual(['a.ts']);
    const obs = await p.observe(['nested/n.ts']);
    expect(obs.get('nested/n.ts')).toMatchObject({ state: 'ineligible' });
  });

  it('observe applies ignore rules to explicit paths', async () => {
    const root = makeProject({ '.gitignore': 'secret/\n', 'secret/x.ts': 'x', 'ok.ts': 'ok' }, { git: true });
    const p = new Project(root, cfg());
    const obs = await p.observe(['secret/x.ts', 'ok.ts', 'missing.ts', '.env']);
    expect(obs.get('secret/x.ts')).toMatchObject({ state: 'ineligible', reason: 'ignored' });
    expect(obs.get('ok.ts')).toMatchObject({ state: 'eligible', size: 2 });
    expect(obs.get('missing.ts')).toEqual({ state: 'missing' });
  });
});

describe('filesystem scanner', () => {
  it('walks without git, applies root .gitignore, hard exclusions, hidden rules, prunes nested repos', async () => {
    const root = makeProject({
      '.gitignore': 'tmp/\n',
      'src/a.ts': 'a',
      'src/z.md': 'z',
      'tmp/x.ts': 'x',
      'dist/out.js': 'o',
      '.hidden/h.ts': 'h',
      '.eslintrc': '{}',
      'nested/.git/HEAD': 'ref',
      'nested/n.ts': 'n',
      'Makefile': 'all:'
    });
    symlinkSync(path.join(root, 'src'), path.join(root, 'srclink'));
    symlinkSync(path.join(root, 'src', 'a.ts'), path.join(root, 'alink.ts'));
    const p = new Project(root, cfg());
    const s = await p.scan(null);
    expect(s.mode).toBe('filesystem');
    expect(s.paths).toEqual(['Makefile', 'src/a.ts', 'src/z.md']);
    const obs = await p.observe(['alink.ts', 'srclink/a.ts', 'tmp/x.ts', 'nested/n.ts']);
    expect(obs.get('alink.ts')).toMatchObject({ state: 'ineligible' });
    expect(obs.get('srclink/a.ts')).toMatchObject({ state: 'ineligible' });
    expect(obs.get('tmp/x.ts')).toMatchObject({ state: 'ineligible' });
    expect(obs.get('nested/n.ts')).toMatchObject({ state: 'ineligible' });
  });

  it('reports incomplete scans for unreadable directories', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return;
    const root = makeProject({ 'a.ts': 'a', 'locked/b.ts': 'b' });
    chmodSync(path.join(root, 'locked'), 0o000);
    try {
      const s = await new Project(root, cfg()).scan(null);
      expect(s.complete).toBe(false);
      expect(s.warnings.length).toBe(1);
      expect(s.paths).toEqual(['a.ts']);
    } finally {
      chmodSync(path.join(root, 'locked'), 0o755);
    }
  });

  it('observes binary / oversize / deleted files', async () => {
    const root = makeProject({ 'bin.dat': Buffer.from([1, 0, 2]), 'big.txt': 'x'.repeat(100), 'gone.ts': 'g' });
    const c = cfg();
    c.scan.maxFileBytes = 50;
    const p = new Project(root, c);
    unlinkSync(path.join(root, 'gone.ts'));
    const obs = await p.observe(['bin.dat', 'big.txt', 'gone.ts']);
    expect(obs.get('bin.dat')).toEqual({ state: 'ineligible', reason: 'binary' });
    expect(obs.get('big.txt')).toEqual({ state: 'ineligible', reason: 'too-large' });
    expect(obs.get('gone.ts')).toEqual({ state: 'missing' });
  });

  it('orders by UTF-8 bytes', () => {
    expect(['b', 'a', 'B', '\u{1F600}', '\uE000'].sort(compareUtf8)).toEqual(['B', 'a', 'b', '\uE000', '\u{1F600}']);
  });
});
