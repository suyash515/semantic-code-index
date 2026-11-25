import { describe, expect, it } from 'vitest';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { setupIndex } from '../helpers/index-fixture.js';
import { openDatabase } from '../../src/storage/connection.js';
import { Repository } from '../../src/storage/repository.js';
import { SemanticIndexError } from '../../src/errors.js';
import { openSemanticIndex } from '../../src/service/semantic-index.js';
import { FakeEmbeddingProvider } from '../helpers/fake-provider.js';
import { makeProject } from '../helpers/fixtures.js';

const DESC = 'Processes customer payments through Stripe and records transaction results.';

describe('indexing', () => {
  it('creates, is idempotent, updates description, reuses vector on reaffirmed description with new hash', async () => {
    const f = await setupIndex({ 'src/pay.ts': 'export const pay = 1;\n' });
    const h1 = f.hash('src/pay.ts');
    expect(await f.index.indexFile({ path: 'src/pay.ts', description: `  ${DESC}  `, expected_hash: h1 })).toEqual({ path: 'src/pay.ts', status: 'created', content_hash: h1 });
    expect(f.provider.embedCalls.length).toBe(1);
    expect(await f.index.indexFile({ path: './src//pay.ts', description: DESC, expected_hash: h1 })).toEqual({ path: 'src/pay.ts', status: 'unchanged', content_hash: h1 });
    expect(f.provider.embedCalls.length).toBe(1);

    expect((await f.index.indexFile({ path: 'src/pay.ts', description: 'Different description.', expected_hash: h1 })).status).toBe('updated');
    expect(f.provider.embedCalls.length).toBe(2);

    writeFileSync(path.join(f.root, 'src/pay.ts'), 'export const pay = 2;\n');
    const h2 = f.hash('src/pay.ts');
    const before = await f.index.getFile({ path: 'src/pay.ts' });
    expect(before.state).toBe('stale');
    expect((await f.index.indexFile({ path: 'src/pay.ts', description: 'Different description.', expected_hash: h2 })).status).toBe('updated');
    expect(f.provider.embedCalls.length).toBe(2); // vector reused
    const after = await f.index.getFile({ path: 'src/pay.ts' });
    expect(after.state).toBe('indexed');
    expect(after.record!.content_hash).toBe(h2);
    expect(after.record!.indexed_at).toBe(before.record!.indexed_at);
    expect(after.record!.size_bytes).toBe(22);
    expect(after.record!.language).toBe('typescript');
    expect(after.record).not.toHaveProperty('embedding');
  });

  it('rejects wrong / malformed hashes with FILE_CHANGED / INVALID_INPUT and keeps prior record', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    await f.add('a.ts', DESC);
    const r = await f.index.indexFile({ path: 'a.ts', description: 'new', expected_hash: 'b'.repeat(64) });
    expect(r).toMatchObject({ status: 'failed', error: { code: 'FILE_CHANGED', retryable: true } });
    expect((await f.index.getFile({ path: 'a.ts' })).record!.description).toBe(DESC);
    expect(await f.index.indexFile({ path: 'a.ts', description: 'x', expected_hash: 'ABC' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await f.index.indexFile({ path: 'a.ts', description: 'x', expected_hash: 'A'.repeat(64) })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
  });

  it('FILE_CHANGED when file changes during embedding; prior record kept; never a placeholder vector', async () => {
    const f = await setupIndex({ 'a.ts': 'one' });
    await f.add('a.ts', DESC);
    const h = f.hash('a.ts');
    writeFileSync(path.join(f.root, 'a.ts'), 'two');
    const h2 = f.hash('a.ts');
    f.provider.onEmbed = () => writeFileSync(path.join(f.root, 'a.ts'), 'three');
    const r = await f.index.indexFile({ path: 'a.ts', description: 'Updated description', expected_hash: h2 });
    expect(r).toMatchObject({ status: 'failed', error: { code: 'FILE_CHANGED' } });
    const rec = (await f.index.getFile({ path: 'a.ts' })).record!;
    expect(rec.description).toBe(DESC);
    expect(rec.content_hash).toBe(h);
    // deleted during embedding
    f.provider.onEmbed = () => unlinkSync(path.join(f.root, 'a.ts'));
    writeFileSync(path.join(f.root, 'a.ts'), 'four');
    expect(await f.index.indexFile({ path: 'a.ts', description: 'Another', expected_hash: f.hash('a.ts') })).toMatchObject({ error: { code: 'FILE_CHANGED' } });
    expect((await f.index.getFile({ path: 'a.ts' })).record!.description).toBe(DESC);
  });

  it('batch: ordered outcomes, aggregate counts, mixed failures, provider failure leaves data intact', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c', 'img.png': 'x', '.env': 'S=1', 'bin.dat': Buffer.from([0, 1]) });
    await f.add('b.ts', 'old b');
    const res = await f.index.indexFiles({
      files: [
        { path: 'a.ts', description: 'Alpha module', expected_hash: f.hash('a.ts') },
        { path: 'b.ts', description: 'Beta module', expected_hash: f.hash('b.ts') },
        { path: 'c.ts', description: 'Gamma', expected_hash: 'f'.repeat(64) },
        { path: 'img.png', description: 'image', expected_hash: f.hash('img.png') },
        { path: '.env', description: 'secrets', expected_hash: f.hash('.env') },
        { path: 'nope.ts', description: 'nothing', expected_hash: 'f'.repeat(64) },
        { path: '../escape.ts', description: 'bad', expected_hash: 'f'.repeat(64) },
        { path: 'bin.dat', description: 'binary', expected_hash: f.hash('bin.dat') },
        { path: 'c.ts', description: '   ', expected_hash: f.hash('c.ts') }
      ].map((x, i) => (i === 8 ? { ...x, path: './c.ts' } : x)).slice(0, 8)
    });
    expect(res.results.map((r) => r.status)).toEqual(['created', 'updated', 'failed', 'failed', 'failed', 'failed', 'failed', 'failed']);
    expect(res.results.map((r) => (r.status === 'failed' ? r.error.code : null))).toEqual([
      null, null, 'FILE_CHANGED', 'FILE_NOT_ELIGIBLE', 'FILE_NOT_ELIGIBLE', 'NOT_FOUND', 'INVALID_PATH', 'FILE_NOT_ELIGIBLE'
    ]);
    expect(res).toMatchObject({ total: 8, created: 1, updated: 1, unchanged: 0, failed: 6 });

    f.provider.failNext = new SemanticIndexError('EMBEDDING_FAILED', 'boom');
    const res2 = await f.index.indexFiles({
      files: [
        { path: 'a.ts', description: 'Alpha changed', expected_hash: f.hash('a.ts') },
        { path: 'b.ts', description: 'Beta module', expected_hash: f.hash('b.ts') }
      ]
    });
    expect(res2.results[0]).toMatchObject({ status: 'failed', error: { code: 'EMBEDDING_FAILED' } });
    expect(res2.results[1]).toMatchObject({ status: 'unchanged' });
    expect((await f.index.getFile({ path: 'a.ts' })).record!.description).toBe('Alpha module');
  });

  it('rejects duplicate normalized paths and invalid batch sizes before any change', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    const h = f.hash('a.ts');
    await expect(f.index.indexFiles({ files: [{ path: 'a.ts', description: 'x', expected_hash: h }, { path: './a.ts', description: 'y', expected_hash: h }] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect((await f.index.getFile({ path: 'a.ts' })).record).toBeNull();
    await expect(f.index.indexFiles({ files: [] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const many = Array.from({ length: 51 }, (_, i) => ({ path: `f${i}.ts`, description: 'x', expected_hash: h }));
    await expect(f.index.indexFiles({ files: many })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(f.index.indexFiles({ files: [{ path: 'a.ts', description: 'x', expected_hash: h, extra: 1 } as never] })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('enforces description limits (code points and tokens) with TEXT_TOO_LONG', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    const h = f.hash('a.ts');
    expect(await f.index.indexFile({ path: 'a.ts', description: 'x'.repeat(1201), expected_hash: h })).toMatchObject({ error: { code: 'TEXT_TOO_LONG' } });
    const tooManyTokens = Array.from({ length: 255 }, () => 'w').join(' ');
    const r = await f.index.indexFile({ path: 'a.ts', description: tooManyTokens, expected_hash: h });
    expect(r).toMatchObject({ error: { code: 'TEXT_TOO_LONG', details: { token_count: 257, max_tokens: 256 } } });
    expect(f.provider.embedCalls.length).toBe(0);
  });

  it('applies scan policy to explicit paths (ignored, hard-excluded, symlinked)', async () => {
    const f = await setupIndex({ '.gitignore': 'secret/\n', 'secret/x.ts': 'x', 'node_modules/m.js': 'm', 'real.ts': 'r' }, { git: true });
    for (const p of ['secret/x.ts', 'node_modules/m.js']) {
      expect(await f.index.indexFile({ path: p, description: 'x', expected_hash: f.hash(p) })).toMatchObject({ error: { code: 'FILE_NOT_ELIGIBLE' } });
    }
    const { symlinkSync } = await import('node:fs');
    symlinkSync(path.join(f.root, 'real.ts'), path.join(f.root, 'link.ts'));
    expect(await f.index.indexFile({ path: 'link.ts', description: 'x', expected_hash: f.hash('real.ts') })).toMatchObject({ error: { code: 'FILE_NOT_ELIGIBLE' } });
    expect(await f.index.indexFile({ path: '/etc/passwd', description: 'x', expected_hash: 'a'.repeat(64) })).toMatchObject({ error: { code: 'INVALID_PATH' } });
  });

  it('remove deletes only the index row, is idempotent', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    await f.add('a.ts', DESC);
    expect(await f.index.removeFile({ path: 'a.ts' })).toEqual({ path: 'a.ts', removed: true });
    expect(existsSync(path.join(f.root, 'a.ts'))).toBe(true);
    expect(await f.index.removeFile({ path: 'a.ts' })).toEqual({ path: 'a.ts', removed: false });
    expect((await f.index.getFile({ path: 'a.ts' })).state).toBe('unindexed');
    await expect(f.index.removeFile({ path: '../x' })).rejects.toMatchObject({ code: 'INVALID_PATH' });
  });

  it('get_file covers unindexed/missing/ineligible states and errors', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b', 'pic.png': 'p' });
    expect(await f.index.getFile({ path: 'a.ts' })).toEqual({ path: 'a.ts', state: 'unindexed', current_hash: f.hash('a.ts'), current_size_bytes: 1, record: null });
    await expect(f.index.getFile({ path: 'missing.ts' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.index.getFile({ path: 'pic.png' })).rejects.toMatchObject({ code: 'FILE_NOT_ELIGIBLE' });
    await f.add('b.ts', DESC);
    unlinkSync(path.join(f.root, 'b.ts'));
    expect(await f.index.getFile({ path: 'b.ts' })).toMatchObject({ state: 'missing', current_hash: null, record: { description: DESC } });
  });

  it('MODEL_MISMATCH blocks indexing and search but not status/list/remove', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    await f.add('a.ts', DESC);
    await f.index.close();
    const other = new FakeEmbeddingProvider();
    other.profile = { ...other.profile, revision: 'deadbeef'.repeat(5) };
    const idx = await openSemanticIndex({ root: f.root, embeddingProvider: other });
    await expect(idx.indexFile({ path: 'a.ts', description: 'x', expected_hash: f.hash('a.ts') })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    await expect(idx.searchFiles({ query: 'payments' })).rejects.toMatchObject({ code: 'MODEL_MISMATCH' });
    expect((await idx.getIndexStatus()).model_compatible).toBe(false);
    expect((await idx.listUnindexedFiles()).files).toEqual([]);
    expect((await idx.removeFile({ path: 'a.ts' })).removed).toBe(true);
    await idx.close();
  });

  it('close is idempotent and rejects later calls; open requires init', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    await f.index.close();
    await f.index.close();
    await expect(f.index.getIndexStatus()).rejects.toBeInstanceOf(SemanticIndexError);
    await expect(openSemanticIndex({ root: makeProject() })).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
  });

  it('reopen after restart preserves descriptions and vectors', async () => {
    const f = await setupIndex({ 'a.ts': 'a' });
    await f.add('a.ts', DESC);
    const db1 = await openDatabase(f.root, { create: false });
    const emb = new Repository(db1).getEmbedding('a.ts');
    db1.close();
    await f.index.close();
    const idx = await openSemanticIndex({ root: f.root, embeddingProvider: new FakeEmbeddingProvider() });
    expect((await idx.getFile({ path: 'a.ts' })).record!.description).toBe(DESC);
    const db2 = await openDatabase(f.root, { create: false });
    expect(new Repository(db2).getEmbedding('a.ts')!.equals(emb!)).toBe(true);
    db2.close();
    await idx.close();
  });
});
