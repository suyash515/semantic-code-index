// Child process: blocks all network access, then embeds in offline mode.
import { TransformersEmbeddingProvider } from '../../src/embeddings/transformers-provider.js';
import { SemanticIndexError } from '../../src/errors.js';
import net from 'node:net';

let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  throw new Error('network blocked by test');
}) as typeof fetch;
net.Socket.prototype.connect = function () {
  fetches++;
  throw new Error('socket blocked by test');
} as typeof net.Socket.prototype.connect;

const p = new TransformersEmbeddingProvider({ cacheDir: process.argv[2]!, offline: true });
try {
  const [v] = await p.embed(['offline smoke test']);
  process.stdout.write(JSON.stringify({ ok: true, dims: v!.length, fetches }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, code: err instanceof SemanticIndexError ? err.code : String(err), fetches }));
} finally {
  await p.close();
}
