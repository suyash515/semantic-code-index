/** Explicit maintenance: re-embedding (all-or-nothing), reset, model download (spec §11, §8.2). */
import { SemanticIndexError, asSemanticIndexError } from '../errors.js';
import { LIMITS } from '../config/defaults.js';
import { encodeVector } from '../storage/vector-codec.js';
import { profileJson } from '../embeddings/provider.js';
import type { DownloadModelResult, ReembedResult, ResetResult } from '../types.js';
import { checkAborted, expectedProfileJson, type ServiceContext } from './context.js';

/**
 * Rebuild every vector from stored descriptions. All embeddings are computed outside the
 * write transaction; the live rows are replaced atomically only if the index generation is
 * unchanged. Any failure leaves the index untouched.
 */
export async function reembed(ctx: ServiceContext, signal?: AbortSignal): Promise<ReembedResult> {
  const provider = ctx.provider();
  const startGeneration = ctx.repo.getGeneration();
  const staged = new Map<number, Buffer>();
  const batch = LIMITS.indexBatchMax;
  let afterId = 0;
  for (;;) {
    checkAborted(signal);
    const rows = ctx.repo.descriptionsAfter(afterId, batch);
    if (rows.length === 0) break;
    try {
      const counts = await provider.countTokens(rows.map((r) => r.description));
      const tooLong = rows.filter((_, i) => counts[i]! > provider.maxTokens);
      if (tooLong.length > 0) {
        throw new SemanticIndexError('EMBEDDING_FAILED', `${tooLong.length} stored description(s) exceed the model token limit; nothing was changed. Re-index those files with shorter descriptions or reset.`, {
          details: { paths: tooLong.slice(0, 10).map((r) => r.path) }
        });
      }
      const vectors = await provider.embed(rows.map((r) => r.description));
      if (vectors.length !== rows.length) throw new SemanticIndexError('EMBEDDING_FAILED', 'Provider returned the wrong number of embeddings.');
      rows.forEach((r, i) => staged.set(r.id, encodeVector(vectors[i]!, provider.profile.dimensions)));
    } catch (err) {
      const e = asSemanticIndexError(err);
      throw e.code === 'INTERNAL_ERROR' ? new SemanticIndexError('EMBEDDING_FAILED', 'Re-embedding failed; nothing was changed.', { cause: err }) : e;
    }
    afterId = rows[rows.length - 1]!.id;
    if (ctx.repo.getGeneration() !== startGeneration) {
      throw new SemanticIndexError('INDEX_CHANGED', 'The index changed while re-embedding; nothing was modified. Retry.');
    }
  }
  const generation = ctx.repo.applyReembed(startGeneration, staged, profileJson(provider));
  return { reembedded: staged.size, embedding_model: provider.profile.model, index_generation: generation };
}

export async function reset(ctx: ServiceContext, req: unknown): Promise<ResetResult> {
  const confirm = !!req && typeof req === 'object' && (req as { confirm?: unknown }).confirm === true;
  if (!confirm) {
    throw new SemanticIndexError('INVALID_INPUT', 'Reset removes every index record and requires explicit confirmation ({ confirm: true } / --yes).');
  }
  return { removed: ctx.repo.reset(expectedProfileJson(ctx)) };
}

export async function downloadModel(ctx: ServiceContext, cacheConfigured: boolean): Promise<DownloadModelResult> {
  const provider = ctx.provider();
  await provider.download();
  const p = provider.profile;
  return { embedding_model: p.model, revision: p.revision, dtype: p.dtype, dimensions: p.dimensions, cache_dir_configured: cacheConfigured };
}
