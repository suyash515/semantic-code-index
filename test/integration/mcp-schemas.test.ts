import { describe, expect, it } from 'vitest';
import { unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import * as S from '../../src/mcp/schemas.js';
import { setupIndex } from '../helpers/index-fixture.js';
import { toErrorPayload, SemanticIndexError } from '../../src/errors.js';

describe('service results satisfy MCP output schemas', () => {
  it('all tool outputs validate', async () => {
    const f = await setupIndex({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' }, { git: true });
    const page = await f.index.listUnindexedFiles({ limit: 2 });
    S.unindexedPageSchema.parse(page);
    const batch = await f.index.indexFiles({ files: [
      { path: 'a.ts', description: 'Alpha', expected_hash: f.hash('a.ts') },
      { path: 'b.ts', description: 'Beta', expected_hash: 'f'.repeat(64) }
    ] });
    S.indexFilesResultSchema.parse(batch);
    S.indexFileResultSchema.parse(batch.results[1]);
    await f.add('c.ts', 'Gamma');
    writeFileSync(path.join(f.root, 'c.ts'), 'changed');
    S.stalePageSchema.parse(await f.index.listStaleFiles());
    S.searchResultSchema.parse(await f.index.searchFiles({ query: 'alpha', include_stale: true }));
    S.getFileResultSchema.parse(await f.index.getFile({ path: 'a.ts' }));
    S.getFileResultSchema.parse(await f.index.getFile({ path: 'b.ts' }));
    S.statusResultSchema.parse(await f.index.getIndexStatus());
    unlinkSync(path.join(f.root, 'a.ts'));
    S.getFileResultSchema.parse(await f.index.getFile({ path: 'a.ts' }));
    S.reconcileResultSchema.parse(await f.index.reconcileIndex({ dry_run: true }));
    S.reconcileResultSchema.parse(await f.index.reconcileIndex());
    S.removeFileResultSchema.parse(await f.index.removeFile({ path: 'c.ts' }));
  });

  it('error payloads validate and are sanitized', () => {
    S.errorPayloadSchema.parse(toErrorPayload(new SemanticIndexError('IO_ERROR', 'x', { details: { reason: '/abs/path' } })));
    const p = toErrorPayload(new TypeError('secret /home/me/x'));
    S.errorPayloadSchema.parse(p);
    expect(p.message).not.toContain('/home');
  });

  it('input schemas are strict', () => {
    expect(S.searchInputSchema.safeParse({ query: 'x', extra: 1 }).success).toBe(false);
    expect(S.indexFilesInputSchema.safeParse({ files: [] }).success).toBe(false);
    expect(S.indexFileInputSchema.safeParse({ path: 'a', description: 'd', expected_hash: 'A'.repeat(64) }).success).toBe(false);
    expect(S.listInputSchema.safeParse({ limit: 201 }).success).toBe(false);
  });
});
