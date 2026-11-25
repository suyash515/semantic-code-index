/**
 * Real-model tests (explicit suite: `npm run test:model`). Downloads the pinned model into
 * an isolated cache on first run (or reuses SEMANTIC_INDEX_TEST_CACHE_DIR).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { TransformersEmbeddingProvider } from '../../src/embeddings/transformers-provider.js';
import { vectorNorm } from '../../src/storage/vector-codec.js';
import { tempDir } from '../helpers/fixtures.js';
import { runTsChild } from '../helpers/child.js';

import { MODEL_CACHE } from '../helpers/e2e.js';

function cos(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!;
  return s;
}

describe('real model (Xenova/all-MiniLM-L6-v2, pinned revision, q8)', () => {
  const provider = new TransformersEmbeddingProvider({ cacheDir: MODEL_CACHE });

  beforeAll(async () => {
    await provider.download();
  });

  it('caches the pinned revision and q8 artifact', () => {
    const dir = path.join(MODEL_CACHE, 'Xenova', 'all-MiniLM-L6-v2', provider.profile.revision);
    expect(existsSync(path.join(dir, 'onnx', 'model_quantized.onnx'))).toBe(true);
    expect(existsSync(path.join(dir, 'tokenizer.json'))).toBe(true);
    // nothing cached outside the pinned revision folder
    expect(readdirSync(path.join(MODEL_CACHE, 'Xenova', 'all-MiniLM-L6-v2'))).toEqual([provider.profile.revision]);
  });

  it('produces 384-dim finite normalized vectors, deterministic across calls', async () => {
    const texts = ['Processes customer payments and handles failures.', 'Renders the login page.'];
    const a = await provider.embed(texts);
    const b = await provider.embed(texts);
    for (const v of a) {
      expect(v.length).toBe(384);
      expect(v.every(Number.isFinite)).toBe(true);
      expect(Math.abs(vectorNorm(v) - 1)).toBeLessThan(1e-5);
    }
    for (let i = 0; i < a.length; i++) expect(cos(a[i]!, b[i]!)).toBeGreaterThan(0.99999);
    // batch composition does not change a vector (each text is inferred without padding)
    const [single] = await provider.embed([texts[1]!]);
    expect(Array.from(single!)).toEqual(Array.from(a[1]!));
  });

  it('enforces the 256 token limit including special tokens, without truncation', async () => {
    const words = (n: number) => Array.from({ length: n }, () => 'payment').join(' ');
    const [c254] = await provider.countTokens([words(254)]);
    expect(c254).toBe(256);
    const [c255] = await provider.countTokens([words(255)]);
    expect(c255).toBe(257);
    await expect(provider.embed([words(255)])).rejects.toMatchObject({ code: 'TEXT_TOO_LONG' });
    const [v] = await provider.embed([words(254)]);
    expect(v!.length).toBe(384);
    // long inputs over 128 tokens are not truncated at the tokenizer.json default (128)
    const base = words(130);
    const [x] = await provider.embed([`${base} ${'login '.repeat(60)}`]);
    const [y] = await provider.embed([`${base} ${'shipping '.repeat(60)}`]);
    expect(cos(x!, y!)).toBeLessThan(0.99);
  });

  it('semantic similarity is sensible', async () => {
    const [q, pay, auth] = await provider.embed([
      'Where are failed credit card payments handled?',
      'Processes customer payments through Stripe and handles declined card failures.',
      'Validates user passwords and issues session tokens for login.'
    ]);
    expect(cos(q!, pay!)).toBeGreaterThan(cos(q!, auth!));
  });

  it('works offline with network blocked after download', async () => {
    const script = path.resolve(import.meta.dirname, 'offline-child.ts');
    const r = await runTsChild(script, [MODEL_CACHE]);
    expect(r.code, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: true, dims: 384, fetches: 0 });
  });

  it('returns MODEL_NOT_AVAILABLE offline with an empty cache (no network)', async () => {
    const empty = tempDir('sci-empty-cache-');
    const script = path.resolve(import.meta.dirname, 'offline-child.ts');
    const r = await runTsChild(script, [empty]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ ok: false, code: 'MODEL_NOT_AVAILABLE', fetches: 0 });
  });
});
