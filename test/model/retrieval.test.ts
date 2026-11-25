/**
 * Retrieval-quality fixture (spec §18.3): real model, real SQLite, labeled relevant files.
 * Reports recall@5; asserts every labeled query retrieves its file in the top 5.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { initializeProject } from '../../src/config/init.js';
import { openSemanticIndex } from '../../src/service/semantic-index.js';
import { TransformersEmbeddingProvider } from '../../src/embeddings/transformers-provider.js';
import { makeProject } from '../helpers/fixtures.js';
import { MODEL_CACHE } from '../helpers/e2e.js';

const fixture = JSON.parse(readFileSync(path.resolve(import.meta.dirname, '../fixtures/retrieval/fixture.json'), 'utf8')) as {
  files: Record<string, string>;
  queries: { query: string; relevant: string[] }[];
};

describe('retrieval quality (recall@5)', () => {
  it('retrieves labeled files in the top 5', async () => {
    const sources: Record<string, string> = {};
    for (const p of Object.keys(fixture.files)) sources[p] = `// ${p}\nexport {};\n`;
    const root = makeProject(sources);
    await initializeProject({ root });
    const index = await openSemanticIndex({ root, embeddingProvider: new TransformersEmbeddingProvider({ cacheDir: MODEL_CACHE }) });
    const entries = Object.entries(fixture.files).map(([p, description]) => ({
      path: p,
      description,
      expected_hash: createHash('sha256').update(sources[p]!).digest('hex')
    }));
    for (let i = 0; i < entries.length; i += 50) {
      const r = await index.indexFiles({ files: entries.slice(i, i + 50) });
      expect(r.failed).toBe(0);
    }
    let hits = 0;
    const report: string[] = [];
    for (const q of fixture.queries) {
      const r = await index.searchFiles({ query: q.query, limit: 5 });
      const top = r.results.map((x) => x.path);
      const hit = q.relevant.every((p) => top.includes(p));
      if (hit) hits++;
      const rank = top.indexOf(q.relevant[0]!) + 1;
      report.push(`${hit ? 'HIT ' : 'MISS'} rank=${rank || '-'} score=${r.results[0]?.score.toFixed(3)} "${q.query}" -> ${top[0]}`);
    }
    await index.close();
    const recall = hits / fixture.queries.length;
    console.log(`recall@5 = ${recall.toFixed(3)} (${hits}/${fixture.queries.length})\n${report.join('\n')}`);
    expect(recall).toBe(1);
  });
});
