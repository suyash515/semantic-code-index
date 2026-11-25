// Child process: performs many CAS-guarded writes against a shared index.
import { openDatabase } from '../../src/storage/connection.js';
import { Repository, versionOf } from '../../src/storage/repository.js';
import { encodeVector } from '../../src/storage/vector-codec.js';
import { DEFAULT_EMBEDDING_PROFILE, canonicalProfileJson } from '../../src/config/defaults.js';
import { mapNativeError } from '../../src/errors.js';

const [root, worker, countStr] = process.argv.slice(2);
const count = Number(countStr);
const db = await openDatabase(root!, { create: false });
const repo = new Repository(db);
const profile = canonicalProfileJson(DEFAULT_EMBEDDING_PROFILE);
const vec = new Float32Array(384);
vec[Number(worker) % 384] = 1;
const emb = encodeVector(vec, 384);
const stats = { created: 0, updated: 0, unchanged: 0, conflict: 0, busy: 0 };
for (let i = 0; i < count; i++) {
  // Shared path contended by all workers, plus a private path per worker.
  for (const p of ['shared.ts', `w${worker}/f${i}.ts`]) {
    const expected = versionOf(repo.getRow(p));
    try {
      const [o] = repo.applyIndexWrites(
        [{ path: p, expected, description: `worker ${worker} iteration ${i}`, content_hash: 'a'.repeat(64), size_bytes: 1, language: null, embedding: emb }],
        profile,
        new Date().toISOString()
      );
      stats[o!]++;
    } catch (err) {
      if (mapNativeError(err)?.code === 'DB_BUSY') stats.busy++;
      else throw err;
    }
  }
}
db.close();
process.stdout.write(JSON.stringify(stats));
