import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { initializeProject } from '../../src/config/init.js';
import { openSemanticIndex, type SemanticIndex } from '../../src/service/semantic-index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';
import { makeProject } from './fixtures.js';

export interface Fixture {
  root: string;
  index: SemanticIndex;
  provider: FakeEmbeddingProvider;
  hash(rel: string): string;
  /** Index a file with its current hash. */
  add(rel: string, description: string): Promise<void>;
}

export async function setupIndex(files: Record<string, string | Buffer>, opts: { git?: boolean } = {}): Promise<Fixture> {
  const root = makeProject(files, opts);
  await initializeProject({ root });
  const provider = new FakeEmbeddingProvider();
  const index = await openSemanticIndex({ root, embeddingProvider: provider });
  const hash = (rel: string) => createHash('sha256').update(readFileSync(path.join(root, ...rel.split('/')))).digest('hex');
  return {
    root,
    index,
    provider,
    hash,
    async add(rel, description) {
      const r = await index.indexFile({ path: rel, description, expected_hash: hash(rel) });
      if (r.status === 'failed') throw new Error(`index failed: ${JSON.stringify(r.error)}`);
    }
  };
}
