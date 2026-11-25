import { describe, expect, it } from 'vitest';
import { chmodSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setupIndex } from '../helpers/index-fixture.js';
import { unitVector } from '../helpers/vectors.js';
import { openDatabase } from '../../src/storage/connection.js';
import { Repository } from '../../src/storage/repository.js';

async function rankingFixture() {
  const f = await setupIndex({
    'api/best.ts': '1', 'api/a.ts': '2', 'api/b.ts': '3', 'api-old/x.ts': '4', 'api/orth.ts': '5', 'api/neg.ts': '6', 'lib/z.ts': '7'
  });
  const v = f.provider.vectors;
  v.set('QUERY', unitVector(384, { 0: 1 }));
  v.set('best', unitVector(384, { 0: 1 }));
  v.set('tieA', unitVector(384, { 0: 1, 1: 1 }));
  v.set('tieB', unitVector(384, { 0: 1, 1: 1 }));
  v.set('old', unitVector(384, { 0: 1 }));
  v.set('orth', unitVector(384, { 2: 1 }));
  v.set('neg', unitVector(384, { 0: -1 }));
  v.set('z', unitVector(384, { 0: 3, 1: 1 }));
  await f.add('api/best.ts', 'best');
  await f.add('api/b.ts', 'tieB');
  await f.add('api/a.ts', 'tieA');
  await f.add('api-old/x.ts', 'old');
  await f.add('api/orth.ts', 'orth');
  await f.add('api/neg.ts', 'neg');
  await f.add('lib/z.ts', 'z');
  return f;
}

describe('search', () => {
  it('ranks by exact cosine with known scores, ties by path, prefix boundary, min_score, limit', async () => {
    const f = await rankingFixture();
    const r = await f.index.searchFiles({ query: 'QUERY', path_prefix: 'api/' });
    expect(r.results.map((x) => x.path)).toEqual(['api/best.ts', 'api/a.ts', 'api/b.ts', 'api/orth.ts', 'api/neg.ts']);
    expect(r.results[0]!.score).toBeCloseTo(1, 5);
    expect(r.results[1]!.score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(r.results[1]!.score).toBe(r.results[2]!.score);
    expect(r.results[3]!.score).toBeCloseTo(0, 5);
    expect(r.results[4]!.score).toBeCloseTo(-1, 5);
    expect(r.embedding_model).toBe('Xenova/all-MiniLM-L6-v2');
    expect(r.results[0]).toEqual({
      path: 'api/best.ts', description: 'best', score: r.results[0]!.score, state: 'indexed',
      content_hash: f.hash('api/best.ts'), current_hash: f.hash('api/best.ts'), language: 'typescript', updated_at: expect.any(String)
    });
    expect((await f.index.searchFiles({ query: 'QUERY', path_prefix: 'api' })).results.length).toBe(5);
    expect((await f.index.searchFiles({ query: 'QUERY', min_score: 0.5, path_prefix: 'api/' })).results.map((x) => x.path)).toEqual(['api/best.ts', 'api/a.ts', 'api/b.ts']);
    expect((await f.index.searchFiles({ query: 'QUERY', limit: 2 })).results.map((x) => x.path)).toEqual(['api-old/x.ts', 'api/best.ts']);
    expect((await f.index.searchFiles({ query: 'QUERY', path_prefix: 'none/' })).results).toEqual([]);
    const all = await f.index.searchFiles({ query: 'QUERY' });
    expect(all.results.map((x) => x.path).slice(0, 3)).toEqual(['api-old/x.ts', 'api/best.ts', 'lib/z.ts']);
  });

  it('validates query, limit, min_score, prefix', async () => {
    const f = await rankingFixture();
    for (const bad of [{ query: '' }, { query: '   ' }, { query: 'q', limit: 0 }, { query: 'q', limit: 51 }, { query: 'q', limit: 1.5 }, { query: 'q', min_score: 2 }, { query: 'q', min_score: Number.NaN }, { query: 'q', path_prefix: '../x' }, { query: 'q', bogus: 1 }]) {
      await expect(f.index.searchFiles(bad as never)).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_INPUT|INVALID_PATH/) });
    }
    await expect(f.index.searchFiles({ query: 'x'.repeat(1001) })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    await expect(f.index.searchFiles({ query: Array.from({ length: 300 }, () => 'w').join(' ') })).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
  });

  it('skips missing/stale/ineligible/unavailable top candidates and fills the limit from lower ranks', async () => {
    const f = await rankingFixture();
    unlinkSync(path.join(f.root, 'api-old/x.ts')); // missing (rank 1)
    writeFileSync(path.join(f.root, 'api/best.ts'), 'changed'); // stale (rank 2)
    writeFileSync(path.join(f.root, 'lib/z.ts'), Buffer.from([0, 1, 2])); // ineligible (rank 3)
    const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0;
    if (canChmod) chmodSync(path.join(f.root, 'api/a.ts'), 0o000); // unavailable (rank 4)
    try {
      const r = await f.index.searchFiles({ query: 'QUERY', limit: 2 });
      expect(r.results.map((x) => x.path)).toEqual(canChmod ? ['api/b.ts', 'api/orth.ts'] : ['api/a.ts', 'api/b.ts']);
      expect(r.skipped).toEqual({ stale: 1, missing: 1, ineligible: 1, unavailable: canChmod ? 1 : 0 });
      if (canChmod) expect(r.warnings.join(' ')).not.toContain(f.root);
      const withStale = await f.index.searchFiles({ query: 'QUERY', limit: 2, include_stale: true });
      expect(withStale.results[0]).toMatchObject({ path: 'api/best.ts', state: 'stale', content_hash: expect.any(String) });
      expect(withStale.results[0]!.current_hash).not.toBe(withStale.results[0]!.content_hash);
    } finally {
      if (canChmod) chmodSync(path.join(f.root, 'api/a.ts'), 0o644);
    }
  });

  it('a stale record restored on disk is fresh again before reconcile', async () => {
    const f = await rankingFixture();
    writeFileSync(path.join(f.root, 'api/best.ts'), 'changed');
    await f.index.reconcileIndex();
    expect((await f.index.getFile({ path: 'api/best.ts' })).record!.state).toBe('stale');
    writeFileSync(path.join(f.root, 'api/best.ts'), '1');
    const r = await f.index.searchFiles({ query: 'QUERY', path_prefix: 'api/', limit: 1 });
    expect(r.results[0]).toMatchObject({ path: 'api/best.ts', state: 'indexed' });
  });

  it('empty index returns no results without loading the model; warning when all excluded', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    const r = await f.index.searchFiles({ query: 'anything' });
    expect(r.results).toEqual([]);
    expect(f.provider.embedCalls.length).toBe(0);
    await f.add('a.ts', 'alpha');
    unlinkSync(path.join(f.root, 'a.ts'));
    const r2 = await f.index.searchFiles({ query: 'alpha' });
    expect(r2.results).toEqual([]);
    expect(r2.skipped.missing).toBe(1);
    expect(r2.warnings.length).toBe(1);
  });

  it('read operations never mutate rows or the generation', async () => {
    const f = await rankingFixture();
    writeFileSync(path.join(f.root, 'api/best.ts'), 'changed');
    unlinkSync(path.join(f.root, 'lib/z.ts'));
    const snapshot = async () => {
      const db = await openDatabase(f.root, { create: false });
      const repo = new Repository(db);
      const out = JSON.stringify({ g: repo.getGeneration(), rows: repo.rowsInPrefix(null) });
      db.close();
      return out;
    };
    const before = await snapshot();
    await f.index.searchFiles({ query: 'QUERY', include_stale: true });
    await f.index.getIndexStatus();
    await f.index.listUnindexedFiles();
    await f.index.listStaleFiles();
    await f.index.getFile({ path: 'api/best.ts' });
    await f.index.getFile({ path: 'lib/z.ts' });
    await f.index.reconcileIndex({ dry_run: true });
    expect(await snapshot()).toBe(before);
  });

  it('iterates many candidates in bounded batches', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 120; i++) files[`f/${String(i).padStart(3, '0')}.ts`] = String(i);
    const f = await setupIndex(files);
    const batch = Object.keys(files).map((p, i) => ({ path: p, description: `file number ${i}`, expected_hash: f.hash(p) }));
    for (let i = 0; i < batch.length; i += 50) await f.index.indexFiles({ files: batch.slice(i, i + 50) });
    // make the 110 best-ranked files stale so verification must page past several batches
    f.provider.vectors.set('needle', unitVector(384, { 7: 1 }));
    const r = await f.index.searchFiles({ query: 'file number 5', limit: 50 });
    expect(r.results.length).toBe(50);
    for (let i = 0; i < 110; i++) writeFileSync(path.join(f.root, `f/${String(i).padStart(3, '0')}.ts`), `changed ${i}`);
    const r2 = await f.index.searchFiles({ query: 'file number 5', limit: 5 });
    expect(r2.results.length).toBe(5);
    expect(r2.skipped.stale).toBe(110);
  });
});
