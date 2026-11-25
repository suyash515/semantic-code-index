import { describe, expect, it } from 'vitest';
import { chmodSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupIndex } from '../helpers/index-fixture.js';
import { git, writeFiles, makeProject } from '../helpers/fixtures.js';
import { openDatabase } from '../../src/storage/connection.js';
import { Repository } from '../../src/storage/repository.js';
import { openSemanticIndex } from '../../src/service/semantic-index.js';
import { initializeProject } from '../../src/config/init.js';
import { FakeEmbeddingProvider } from '../helpers/fake-provider.js';
import { SemanticIndexError } from '../../src/errors.js';
import { runTsChild } from '../helpers/child.js';

const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('status', () => {
  it('reports totals, coverage and separate missing/ineligible counts', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'd.ts': 'd', 'e.ts': 'e', 'pic.png': 'x' });
    expect(await f.index.getIndexStatus()).toMatchObject({ eligible: 5, fresh: 0, stale: 0, unindexed: 5, coverage: 0, complete: true, scan_mode: 'filesystem', model_compatible: true, schema_version: 1 });
    await f.add('a.ts', 'A');
    await f.add('b.ts', 'B');
    await f.add('c.ts', 'C');
    await f.add('d.ts', 'D');
    writeFileSync(path.join(f.root, 'b.ts'), 'changed');
    unlinkSync(path.join(f.root, 'c.ts'));
    writeFileSync(path.join(f.root, 'd.ts'), Buffer.from([0]));
    const s = await f.index.getIndexStatus();
    expect(s).toMatchObject({ eligible: 3, fresh: 1, stale: 1, unindexed: 1, missing: 1, ineligible: 1, unavailable: 0 });
    expect(s.coverage).toBeCloseTo(1 / 3);
    expect((await f.index.getIndexStatus({ path_prefix: 'nothing' })).coverage).toBeNull();
  });

  it('empty index status', async () => {
    const f = await setupIndex({});
    expect(await f.index.getIndexStatus()).toMatchObject({ eligible: 0, coverage: null, complete: true });
  });

  it('reports unavailable without implying completeness', async () => {
    if (!canChmod) return;
    const f = await setupIndex({ 'a.ts': 'a' });
    await f.add('a.ts', 'A');
    chmodSync(path.join(f.root, 'a.ts'), 0o000);
    try {
      expect(await f.index.getIndexStatus()).toMatchObject({ unavailable: 1, fresh: 0, complete: false });
    } finally {
      chmodSync(path.join(f.root, 'a.ts'), 0o644);
    }
  });
});

describe('listing and pagination', () => {
  it('pages unindexed files in path order with cursors bound to generation', async () => {
    const f = await setupIndex({ 'e.ts': 'e', 'a.ts': 'a', 'c.ts': 'c', 'b.ts': 'b', 'd.ts': 'd', 'sub/x.ts': 'x', 'bin.dat': Buffer.from([0]) });
    const p1 = await f.index.listUnindexedFiles({ limit: 2 });
    expect(p1.files.map((x) => x.path)).toEqual(['a.ts', 'b.ts']);
    expect(p1.files[0]).toEqual({ path: 'a.ts', size_bytes: 1, current_hash: f.hash('a.ts'), language: 'typescript', state: 'unindexed' });
    expect(p1.scan_mode).toBe('filesystem');
    const p2 = await f.index.listUnindexedFiles({ limit: 2, cursor: p1.next_cursor! });
    expect(p2.files.map((x) => x.path)).toEqual(['c.ts', 'd.ts']);
    const p3 = await f.index.listUnindexedFiles({ limit: 2, cursor: p2.next_cursor! });
    expect(p3.files.map((x) => x.path)).toEqual(['e.ts', 'sub/x.ts']);
    expect(p3.next_cursor).toBeNull();
    expect((await f.index.listUnindexedFiles({ path_prefix: 'sub' })).files.map((x) => x.path)).toEqual(['sub/x.ts']);

    await f.add('a.ts', 'A');
    await expect(f.index.listUnindexedFiles({ limit: 2, cursor: p1.next_cursor! })).rejects.toMatchObject({ code: 'INDEX_CHANGED' });
    await expect(f.index.listUnindexedFiles({ cursor: 'garbage' })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    const fresh = await f.index.listUnindexedFiles({ limit: 2 });
    await expect(f.index.listStaleFiles({ cursor: fresh.next_cursor! })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(f.index.listUnindexedFiles({ limit: 2, path_prefix: 'sub', cursor: fresh.next_cursor! })).rejects.toMatchObject({ code: 'INVALID_CURSOR' });
    await expect(f.index.listUnindexedFiles({ limit: 201 })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await f.index.listUnindexedFiles()).files.length).toBe(5);
  });

  it('lists stale files with stored description and pages them', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'd.ts': 'd' });
    for (const p of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) await f.add(p, `desc ${p}`);
    for (const p of ['a.ts', 'c.ts', 'd.ts']) writeFileSync(path.join(f.root, p), `changed ${p}`);
    const p1 = await f.index.listStaleFiles({ limit: 2 });
    expect(p1.files.map((x) => x.path)).toEqual(['a.ts', 'c.ts']);
    expect(p1.files[0]).toMatchObject({ state: 'stale', description: 'desc a.ts', content_hash: expect.any(String), current_hash: f.hash('a.ts') });
    const p2 = await f.index.listStaleFiles({ limit: 2, cursor: p1.next_cursor! });
    expect(p2.files.map((x) => x.path)).toEqual(['d.ts']);
    expect(p2.next_cursor).toBeNull();
  });
});

describe('reconcile', () => {
  it('dry run detects changes without side effects; real run applies them; renames become remove + unindexed', async () => {
    const f = await setupIndex({ 'keep.ts': 'k', 'edit.ts': 'e', 'gone.ts': 'g', 'old-name.ts': 'r', 'bin.ts': 'b', 'new.ts': 'n' });
    for (const p of ['keep.ts', 'edit.ts', 'gone.ts', 'old-name.ts', 'bin.ts']) await f.add(p, `desc ${p}`);
    writeFileSync(path.join(f.root, 'edit.ts'), 'edited');
    unlinkSync(path.join(f.root, 'gone.ts'));
    renameSync(path.join(f.root, 'old-name.ts'), path.join(f.root, 'new-name.ts'));
    writeFileSync(path.join(f.root, 'bin.ts'), Buffer.from([0, 0]));

    const dry = await f.index.reconcileIndex({ dry_run: true });
    expect(dry).toMatchObject({ dry_run: true, complete: true, unindexed: 2, marked_stale: 1, restored_fresh: 0, removed_missing: 2, removed_ineligible: 1, unchanged: 1, unavailable: 0, conflicts: 0 });
    expect(dry.samples.removed_missing).toEqual({ paths: ['gone.ts', 'old-name.ts'], omitted_count: 0 });
    expect((await f.index.getFile({ path: 'edit.ts' })).record!.state).toBe('indexed');

    const real = await f.index.reconcileIndex();
    expect(real).toMatchObject({ dry_run: false, unindexed: 2, marked_stale: 1, removed_missing: 2, removed_ineligible: 1, unchanged: 1 });
    const edit = (await f.index.getFile({ path: 'edit.ts' })).record!;
    expect(edit).toMatchObject({ state: 'stale', description: 'desc edit.ts', observed_hash: f.hash('edit.ts') });
    expect((await f.index.getFile({ path: 'new-name.ts' })).state).toBe('unindexed');
    await expect(f.index.getFile({ path: 'gone.ts' })).rejects.toMatchObject({ code: 'NOT_FOUND' });

    // reverting the edit restores fresh state
    writeFileSync(path.join(f.root, 'edit.ts'), 'e');
    expect(await f.index.reconcileIndex()).toMatchObject({ restored_fresh: 1, marked_stale: 0 });
    expect((await f.index.getFile({ path: 'edit.ts' })).record!.state).toBe('indexed');
    expect(await f.index.reconcileIndex()).toMatchObject({ restored_fresh: 0, marked_stale: 0, removed_missing: 0, unchanged: 2 });
  });

  it('deletes newly ignored records (git) and scopes mutations to the prefix', async () => {
    const f = await setupIndex({ 'src/a.ts': 'a', 'lib/b.ts': 'b' }, { git: true });
    await f.add('src/a.ts', 'A');
    await f.add('lib/b.ts', 'B');
    unlinkSync(path.join(f.root, 'src/a.ts'));
    unlinkSync(path.join(f.root, 'lib/b.ts'));
    const r = await f.index.reconcileIndex({ path_prefix: 'src/' });
    expect(r).toMatchObject({ removed_missing: 1, scan_mode: 'git' });
    expect((await f.index.getFile({ path: 'lib/b.ts' })).record).not.toBeNull();

    writeFiles(f.root, { 'lib/b.ts': 'b', '.gitignore': 'lib/\n' });
    expect(await f.index.reconcileIndex()).toMatchObject({ removed_ineligible: 1 });
  });

  it('never deletes on transient I/O errors or incomplete scans', async () => {
    if (!canChmod) return;
    const f = await setupIndex({ 'a.ts': 'a', 'dir/b.ts': 'b' });
    await f.add('a.ts', 'A');
    await f.add('dir/b.ts', 'B');
    chmodSync(path.join(f.root, 'a.ts'), 0o000);
    try {
      const r = await f.index.reconcileIndex();
      expect(r).toMatchObject({ unavailable: 1, removed_missing: 0, removed_ineligible: 0 });
      expect((await f.index.getFile({ path: 'a.ts' })).record).not.toBeNull();
      const s = await f.index.searchFiles({ query: 'A' });
      expect(s.results.map((x) => x.path)).not.toContain('a.ts');
    } finally {
      chmodSync(path.join(f.root, 'a.ts'), 0o644);
    }
    chmodSync(path.join(f.root, 'dir'), 0o000);
    try {
      await expect(f.index.reconcileIndex()).rejects.toMatchObject({ code: 'SCAN_FAILED' });
      await expect(f.index.reconcileIndex({ dry_run: true })).rejects.toMatchObject({ code: 'SCAN_FAILED' });
    } finally {
      chmodSync(path.join(f.root, 'dir'), 0o755);
    }
    expect((await f.index.getFile({ path: 'dir/b.ts' })).record).not.toBeNull();
  });

  it('Git failure returns SCAN_FAILED with no changes (no fallback traversal)', async () => {
    const f = await setupIndex({ 'a.ts': 'a' }, { git: true });
    await f.add('a.ts', 'A');
    unlinkSync(path.join(f.root, 'a.ts'));
    writeFileSync(path.join(f.root, '.git', 'index'), 'corrupt index');
    await expect(f.index.reconcileIndex()).rejects.toMatchObject({ code: 'SCAN_FAILED' });
    const db = await openDatabase(f.root, { create: false });
    expect(new Repository(db).getRow('a.ts')).not.toBeNull();
    db.close();
  });

  it('bounds samples with omitted_count', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) files[`f${String(i).padStart(2, '0')}.ts`] = String(i);
    const f = await setupIndex(files);
    const r = await f.index.reconcileIndex({ dry_run: true });
    expect(r.unindexed).toBe(60);
    expect(r.samples.unindexed.paths.length).toBe(50);
    expect(r.samples.unindexed.omitted_count).toBe(10);
  });
});

describe('reset and reembed', () => {
  it('reset requires explicit confirmation and keeps config/schema', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b' });
    await f.add('a.ts', 'A');
    await f.add('b.ts', 'B');
    await expect(f.index.reset({ confirm: false })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.index.reset(undefined as never)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await f.index.getIndexStatus()).fresh).toBe(2);
    expect(await f.index.reset({ confirm: true })).toEqual({ removed: 2 });
    expect(await f.index.getIndexStatus()).toMatchObject({ fresh: 0, unindexed: 2, model_compatible: true });
    expect(readFileSync(path.join(f.root, '.semantic-index.json'), 'utf8')).toContain('configVersion');
    expect(readFileSync(path.join(f.root, 'a.ts'), 'utf8')).toBe('a');
  });

  it('reembed is all-or-nothing and resolves a profile mismatch', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b' });
    await f.add('a.ts', 'payments module');
    await f.add('b.ts', 'auth module');
    await f.index.close();

    const next = new FakeEmbeddingProvider();
    next.profile = { ...next.profile, revision: 'feedface'.repeat(5) };
    const idx = await openSemanticIndex({ root: f.root, embeddingProvider: next });
    await expect(idx.searchFiles({ query: 'payments' })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });

    next.failNext = new SemanticIndexError('EMBEDDING_FAILED', 'provider down');
    await expect(idx.reembed()).rejects.toMatchObject({ code: 'EMBEDDING_FAILED' });
    expect((await idx.getIndexStatus()).model_compatible).toBe(false);

    const r = await idx.reembed();
    expect(r.reembedded).toBe(2);
    expect((await idx.getIndexStatus()).model_compatible).toBe(true);
    expect((await idx.searchFiles({ query: 'payments module' })).results[0]!.path).toBe('a.ts');
    expect((await idx.getFile({ path: 'a.ts' })).record!.description).toBe('payments module');
    await idx.close();
  });

  it('reembed aborts with INDEX_CHANGED if the index changes mid-way, leaving vectors intact', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b' });
    await f.add('a.ts', 'A');
    const db = await openDatabase(f.root, { create: false });
    const before = new Repository(db).getEmbedding('a.ts');
    f.provider.onEmbed = async () => {
      f.provider.onEmbed = null;
      await f.add('b.ts', 'B');
    };
    await expect(f.index.reembed()).rejects.toMatchObject({ code: 'INDEX_CHANGED' });
    expect(new Repository(db).getEmbedding('a.ts')!.equals(before!)).toBe(true);
    db.close();
  });
});

describe('worktrees and branches', () => {
  it('separate worktrees keep independent indexes', async () => {
    const f = await setupIndex({ 'a.ts': 'a' }, { git: true });
    git(f.root, 'add', 'a.ts', '.gitignore', '.semantic-index.json');
    git(f.root, 'commit', '-qm', 'init');
    const wt = path.join(path.dirname(f.root), `${path.basename(f.root)}-wt`);
    git(f.root, 'worktree', 'add', '-q', wt);
    await f.add('a.ts', 'main worktree description');
    await expect(openSemanticIndex({ root: wt })).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    await initializeProject({ root: wt });
    const other = await openSemanticIndex({ root: wt, embeddingProvider: new FakeEmbeddingProvider() });
    expect((await other.getIndexStatus()).fresh).toBe(0);
    expect((await other.getIndexStatus()).scan_mode).toBe('git');
    await other.indexFile({ path: 'a.ts', description: 'worktree description', expected_hash: f.hash('a.ts') });
    expect((await f.index.getFile({ path: 'a.ts' })).record!.description).toBe('main worktree description');
    await other.close();
  });

  it('branch switch marks files stale and switching back restores them', async () => {
    const f = await setupIndex({ 'pay.ts': 'v1', 'only-main.ts': 'm' }, { git: true });
    git(f.root, 'add', '.');
    git(f.root, 'commit', '-qm', 'main');
    git(f.root, 'checkout', '-qb', 'feature');
    writeFileSync(path.join(f.root, 'pay.ts'), 'v2');
    git(f.root, 'rm', '-q', 'only-main.ts');
    git(f.root, 'commit', '-qam', 'feature');
    git(f.root, 'checkout', '-q', 'main');
    await f.add('pay.ts', 'payments');
    await f.add('only-main.ts', 'main only');
    git(f.root, 'checkout', '-q', 'feature');
    expect(await f.index.getIndexStatus()).toMatchObject({ stale: 1, missing: 1 });
    git(f.root, 'checkout', '-q', 'main');
    expect(await f.index.getIndexStatus()).toMatchObject({ fresh: 2, stale: 0, missing: 0 });
  });
});

describe('multi-process', () => {
  it('two processes indexing concurrently: no lost updates, no corruption', async () => {
    const files: Record<string, string> = { 'shared.ts': 'shared' };
    for (const w of ['1', '2']) for (let i = 0; i < 15; i++) files[`w${w}/f${i}.ts`] = `${w}-${i}`;
    const root = makeProject(files);
    await initializeProject({ root });
    const script = path.resolve(import.meta.dirname, '../helpers/service-writer.ts');
    const runs = await Promise.all([runTsChild(script, [root, '1', '15']), runTsChild(script, [root, '2', '15'])]);
    for (const r of runs) expect(r.code, r.stderr).toBe(0);
    const tallies = runs.map((r) => JSON.parse(r.stdout) as Record<string, number>);
    const total = tallies.reduce((n, t) => n + Object.values(t).reduce((a, b) => a + b, 0), 0);
    expect(total).toBe(60);
    for (const t of tallies) for (const k of Object.keys(t)) expect(['created', 'updated', 'unchanged', 'INDEX_CHANGED', 'DB_BUSY']).toContain(k);
    const db = await openDatabase(root, { create: false });
    const repo = new Repository(db);
    expect(repo.countInPrefix('w1/')).toBe(15);
    expect(repo.countInPrefix('w2/')).toBe(15);
    expect(repo.getRow('shared.ts')!.description).toMatch(/^shared by [12] at \d+$/);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    db.close();
  });
});
