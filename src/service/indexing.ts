/**
 * Hash-guarded batch upsert (spec §9.3). Files are hashed before embedding and again
 * immediately before the write; no SQLite transaction is held across inference.
 */
import { SemanticIndexError, asSemanticIndexError, type ErrorPayload } from '../errors.js';
import { LIMITS } from '../config/defaults.js';
import { CASE_INSENSITIVE_FS, normalizeRelativePath } from '../project/paths.js';
import { SHA256_RE } from '../project/hash.js';
import { inferLanguage } from '../project/language.js';
import type { Observation } from '../project/scanner.js';
import { versionOf, type FileRow, type IndexWrite } from '../storage/repository.js';
import { encodeVector } from '../storage/vector-codec.js';
import { tokenLimitError, validateTextBounds } from '../embeddings/provider.js';
import type { IndexFileInput, IndexFileResult, IndexFilesResult } from '../types.js';
import { assertModelCompatible, checkAborted, expectedProfileJson, type ServiceContext } from './context.js';

interface WorkItem {
  index: number;
  inputPath: string;
  path: string;
  description: string;
  expectedHash: string;
  prior: FileRow | null;
  size: number;
  embedding: Buffer | null;
  needsEmbedding: boolean;
  error: ErrorPayload | null;
  result: IndexFileResult | null;
}

function fail(item: WorkItem, err: unknown): void {
  item.error = err instanceof SemanticIndexError ? err.toPayload() : asSemanticIndexError(err).toPayload();
}

/** Validate the overall request shape; a completely invalid request is an error. */
export function validateIndexRequest(files: unknown): IndexFileInput[] {
  if (!Array.isArray(files)) throw new SemanticIndexError('INVALID_INPUT', '`files` must be an array.');
  if (files.length < 1 || files.length > LIMITS.indexBatchMax) {
    throw new SemanticIndexError('INVALID_INPUT', `\`files\` must contain 1–${LIMITS.indexBatchMax} entries.`);
  }
  return files.map((f, i) => {
    if (!f || typeof f !== 'object' || Array.isArray(f)) throw new SemanticIndexError('INVALID_INPUT', `files[${i}] must be an object.`);
    const { path, description, expected_hash, ...rest } = f as Record<string, unknown>;
    if (Object.keys(rest).length > 0) throw new SemanticIndexError('INVALID_INPUT', `files[${i}] has unknown keys: ${Object.keys(rest).slice(0, 5).join(', ')}.`);
    if (typeof path !== 'string' || typeof description !== 'string' || typeof expected_hash !== 'string') {
      throw new SemanticIndexError('INVALID_INPUT', `files[${i}] requires string path, description and expected_hash.`);
    }
    return { path, description, expected_hash };
  });
}

function observationError(obs: Observation | undefined, phase: 'initial' | 'recheck'): SemanticIndexError | null {
  if (!obs) return new SemanticIndexError('INTERNAL_ERROR', 'File was not observed.');
  switch (obs.state) {
    case 'eligible':
      return null;
    case 'missing':
      return phase === 'initial'
        ? new SemanticIndexError('NOT_FOUND', 'File does not exist.', { retryable: false })
        : new SemanticIndexError('FILE_CHANGED', 'File was deleted during indexing; the previous record was kept.');
    case 'ineligible':
      return new SemanticIndexError('FILE_NOT_ELIGIBLE', `File is not eligible for indexing (${obs.reason}).`, { details: { reason: obs.reason } });
    case 'unavailable':
      return new SemanticIndexError('IO_ERROR', 'File could not be read; the previous record was kept.', { details: { reason: obs.reason } });
  }
}

export async function indexFiles(ctx: ServiceContext, input: unknown, signal?: AbortSignal): Promise<IndexFilesResult> {
  const files = validateIndexRequest(input);
  ctx.project.fresh();

  // 1. Normalize and reject duplicate normalized paths (incl. case aliases) before any change.
  const items: WorkItem[] = files.map((f, index) => ({
    index,
    inputPath: f.path,
    path: f.path,
    description: f.description,
    expectedHash: f.expected_hash,
    prior: null,
    size: 0,
    embedding: null,
    needsEmbedding: false,
    error: null,
    result: null
  }));
  const seen = new Map<string, number>();
  for (const item of items) {
    try {
      item.path = normalizeRelativePath(item.inputPath);
    } catch (err) {
      fail(item, err);
      continue;
    }
    const key = CASE_INSENSITIVE_FS ? item.path.toLowerCase() : item.path;
    if (seen.has(key)) {
      throw new SemanticIndexError('INVALID_INPUT', `Duplicate path in batch: "${item.path}" (entries ${seen.get(key)} and ${item.index}). No changes were made.`);
    }
    seen.set(key, item.index);
  }

  assertModelCompatible(ctx);

  // 2. Validate hash format and description bounds.
  for (const item of items) {
    if (item.error) continue;
    if (!SHA256_RE.test(item.expectedHash)) {
      fail(item, new SemanticIndexError('INVALID_INPUT', 'expected_hash must be 64 lowercase hexadecimal characters (SHA-256 from discovery).'));
      continue;
    }
    try {
      item.description = validateTextBounds(item.description, 'description');
    } catch (err) {
      fail(item, err);
    }
  }

  // 3. Eligibility + exact-byte hash before embedding.
  const live = () => items.filter((i) => !i.error && !i.result);
  const firstObs = await ctx.project.observe(live().map((i) => i.path), undefined, signal);
  for (const item of live()) {
    const obs = firstObs.get(item.path);
    const err = observationError(obs, 'initial');
    if (err) {
      fail(item, err);
      continue;
    }
    const o = obs as Extract<Observation, { state: 'eligible' }>;
    if (o.hash !== item.expectedHash) {
      fail(item, new SemanticIndexError('FILE_CHANGED', 'File changed since discovery; read it again and resubmit with the new hash.', { details: { current_hash: o.hash } }));
      continue;
    }
    item.size = o.size;
    // 4. Prior row (compare-and-swap token) and reuse decisions.
    item.prior = ctx.repo.getRow(item.path);
    const p = item.prior;
    if (p && p.description === item.description && p.content_hash === item.expectedHash && p.state === 'indexed' && p.observed_hash === item.expectedHash) {
      item.result = { path: item.path, status: 'unchanged', content_hash: item.expectedHash };
    } else if (p && p.description === item.description) {
      item.needsEmbedding = false; // reaffirmed description: reuse the existing vector
    } else {
      item.needsEmbedding = true;
    }
  }

  // 5. Token limits and embeddings only for entries that need new vectors.
  const toEmbed = live().filter((i) => i.needsEmbedding);
  if (toEmbed.length > 0) {
    checkAborted(signal);
    const provider = ctx.provider();
    try {
      const counts = await provider.countTokens(toEmbed.map((i) => i.description));
      toEmbed.forEach((item, k) => {
        if (counts[k]! > provider.maxTokens) fail(item, tokenLimitError('description', counts[k]!, provider.maxTokens));
      });
      const ready = toEmbed.filter((i) => !i.error);
      if (ready.length > 0) {
        const vectors = await provider.embed(ready.map((i) => i.description));
        if (vectors.length !== ready.length) throw new SemanticIndexError('EMBEDDING_FAILED', 'Provider returned the wrong number of embeddings.');
        ready.forEach((item, k) => {
          try {
            item.embedding = encodeVector(vectors[k]!, ctx.expectedProfile.dimensions);
          } catch (err) {
            fail(item, err);
          }
        });
      }
    } catch (err) {
      // Provider-wide failure: fail every pending embedding item; existing rows untouched.
      const payload = asSemanticIndexError(err);
      const code = payload.code === 'INTERNAL_ERROR' ? new SemanticIndexError('EMBEDDING_FAILED', 'Embedding failed.', { cause: err, retryable: true }) : payload;
      for (const item of toEmbed) if (!item.error) fail(item, code);
    }
  }

  // 6. Re-hash immediately before the write with the same containment/eligibility checks.
  checkAborted(signal);
  const writable = live();
  if (writable.length > 0) {
    const recheck = await ctx.project.observe(writable.map((i) => i.path), undefined, signal);
    for (const item of writable) {
      const obs = recheck.get(item.path);
      const err = observationError(obs, 'recheck');
      if (err) fail(item, err);
      else if ((obs as Extract<Observation, { state: 'eligible' }>).hash !== item.expectedHash) {
        fail(item, new SemanticIndexError('FILE_CHANGED', 'File changed during indexing; the previous record was kept. Read it again and resubmit.'));
      }
    }
  }

  // 7. Short write transaction with per-row compare-and-swap.
  const toWrite = live();
  if (toWrite.length > 0) {
    checkAborted(signal);
    const writes: IndexWrite[] = toWrite.map((i) => ({
      path: i.path,
      expected: versionOf(i.prior),
      description: i.description,
      content_hash: i.expectedHash,
      size_bytes: i.size,
      language: inferLanguage(i.path),
      embedding: i.embedding
    }));
    try {
      const outcomes = ctx.repo.applyIndexWrites(writes, expectedProfileJson(ctx), new Date().toISOString());
      toWrite.forEach((item, k) => {
        const o = outcomes[k]!;
        if (o === 'conflict') {
          fail(item, new SemanticIndexError('INDEX_CHANGED', 'The record was changed concurrently; fetch it again and retry.'));
        } else {
          item.result = { path: item.path, status: o, content_hash: item.expectedHash };
        }
      });
    } catch (err) {
      const e = asSemanticIndexError(err);
      if (e.code === 'MODEL_MISMATCH') throw e;
      for (const item of toWrite) fail(item, e);
    }
  }

  const results: IndexFileResult[] = items.map((i) =>
    i.result ?? { path: i.path, status: 'failed', error: i.error ?? { code: 'INTERNAL_ERROR', message: 'Item was not processed.', retryable: true } }
  );
  return {
    total: results.length,
    created: results.filter((r) => r.status === 'created').length,
    updated: results.filter((r) => r.status === 'updated').length,
    unchanged: results.filter((r) => r.status === 'unchanged').length,
    failed: results.filter((r) => r.status === 'failed').length,
    results
  };
}
