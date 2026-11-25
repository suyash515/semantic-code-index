// Child process: indexes files through the public library API with the fake provider.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { openSemanticIndex } from '../../src/service/semantic-index.js';
import { FakeEmbeddingProvider } from './fake-provider.js';

const [root, worker, count] = process.argv.slice(2) as [string, string, string];
const index = await openSemanticIndex({ root, embeddingProvider: new FakeEmbeddingProvider() });
const hash = (p: string) => createHash('sha256').update(readFileSync(path.join(root, p))).digest('hex');
const tally: Record<string, number> = {};
for (let i = 0; i < Number(count); i++) {
  const files = [
    { path: `w${worker}/f${i}.ts`, description: `worker ${worker} file ${i}`, expected_hash: hash(`w${worker}/f${i}.ts`) },
    { path: 'shared.ts', description: `shared by ${worker} at ${i}`, expected_hash: hash('shared.ts') }
  ];
  const res = await index.indexFiles({ files });
  for (const r of res.results) {
    const key = r.status === 'failed' ? r.error.code : r.status;
    tally[key] = (tally[key] ?? 0) + 1;
  }
}
await index.close();
process.stdout.write(JSON.stringify(tally));
