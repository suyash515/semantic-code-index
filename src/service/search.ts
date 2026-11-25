/**
 * Semantic search (spec §10): exact cosine ranking in SQL with the scope applied before
 * ranking, then per-candidate freshness verification against current file bytes.
 * Read-only: never mutates rows or the index generation.
 */
import { SemanticIndexError } from '../errors.js';
import { normalizePrefix } from '../project/paths.js';
import { encodeVector, distanceToScore } from '../storage/vector-codec.js';
import { tokenLimitError, validateTextBounds } from '../embeddings/provider.js';
import type { SearchCandidate } from '../storage/repository.js';
import type { SearchResult, SearchResultItem } from '../types.js';
import { assertModelCompatible, checkAborted, finalizeWarnings, type ServiceContext } from './context.js';

const MAX_RESTARTS = 3;

function validateSearch(ctx: ServiceContext, req: unknown) {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new SemanticIndexError('INVALID_INPUT', 'Search request must be an object.');
  const r = req as Record<string, unknown>;
  const allowed = new Set(['query', 'limit', 'min_score', 'path_prefix', 'include_stale']);
  const unknown = Object.keys(r).filter((k) => !allowed.has(k));
  if (unknown.length > 0) throw new SemanticIndexError('INVALID_INPUT', `Unknown search parameters: ${unknown.slice(0, 5).join(', ')}.`);
  const query = validateTextBounds(r.query, 'query');
  const max = ctx.config.search.maxLimit;
  let limit = ctx.config.search.defaultLimit;
  if (r.limit !== undefined) {
    if (typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > max) {
      throw new SemanticIndexError('INVALID_INPUT', `limit must be an integer from 1 to ${max}.`);
    }
    limit = r.limit;
  }
  let minScore: number | null = null;
  if (r.min_score !== undefined && r.min_score !== null) {
    if (typeof r.min_score !== 'number' || !Number.isFinite(r.min_score) || r.min_score < -1 || r.min_score > 1) {
      throw new SemanticIndexError('INVALID_INPUT', 'min_score must be a finite number in [-1, 1].');
    }
    minScore = r.min_score;
  }
  if (r.include_stale !== undefined && typeof r.include_stale !== 'boolean') throw new SemanticIndexError('INVALID_INPUT', 'include_stale must be a boolean.');
  const includeStale = (r.include_stale as boolean | undefined) ?? ctx.config.search.includeStaleByDefault;
  const prefix = normalizePrefix(r.path_prefix);
  return { query, limit, minScore, includeStale, prefix };
}

export async function searchFiles(ctx: ServiceContext, request: unknown, signal?: AbortSignal): Promise<SearchResult> {
  const { query, limit, minScore, includeStale, prefix } = validateSearch(ctx, request);
  ctx.project.fresh();
  assertModelCompatible(ctx);
  const base: SearchResult = {
    query,
    results: [],
    skipped: { stale: 0, missing: 0, ineligible: 0, unavailable: 0 },
    embedding_model: ctx.expectedProfile.model,
    warnings: []
  };
  // No possible candidates: return without loading the model.
  if (ctx.repo.countInPrefix(prefix) === 0) return base;

  const provider = ctx.provider();
  const [tokens] = await provider.countTokens([query]);
  if (tokens! > provider.maxTokens) throw tokenLimitError('query', tokens!, provider.maxTokens);
  const [vector] = await provider.embed([query]);
  const queryBlob = encodeVector(vector!, ctx.expectedProfile.dimensions);
  checkAborted(signal);

  for (let attempt = 0; attempt < MAX_RESTARTS; attempt++) {
    const outcome = await rankAndVerify(ctx, queryBlob, prefix, limit, minScore, includeStale, signal);
    if (outcome) {
      const { results, skipped, warnings, examined } = outcome;
      if (results.length === 0 && examined > 0) {
        warnings.push('Index records exist in scope but every examined candidate was excluded (stale, missing, ineligible or unavailable). Run reconcile_index or re-index stale files.');
      }
      return { ...base, results, skipped, warnings: finalizeWarnings(warnings) };
    }
  }
  throw new SemanticIndexError('INDEX_CHANGED', 'The index kept changing during search; retry.');
}

/** Returns null if the index generation changed mid-iteration (caller restarts). */
async function rankAndVerify(
  ctx: ServiceContext,
  queryBlob: Buffer,
  prefix: string | null,
  limit: number,
  minScore: number | null,
  includeStale: boolean,
  signal: AbortSignal | undefined
) {
  const results: SearchResultItem[] = [];
  const skipped = { stale: 0, missing: 0, ineligible: 0, unavailable: 0 };
  const warnings: string[] = [];
  const batchSize = Math.min(100, Math.max(20, limit * 2));
  let after: { distance: number; path: string } | null = null;
  let generation: number | null = null;
  let examined = 0;

  for (;;) {
    checkAborted(signal);
    const batch: { generation: number; rows: SearchCandidate[] } = ctx.repo.searchBatch(queryBlob, prefix, after, batchSize);
    if (generation === null) generation = batch.generation;
    else if (batch.generation !== generation) return null;
    if (batch.rows.length === 0) break;

    // Stop at the score threshold (compared against the unrounded score).
    const rows: { row: SearchCandidate; score: number }[] = [];
    let thresholdReached = false;
    for (const row of batch.rows) {
      const score = distanceToScore(row.distance);
      if (minScore !== null && score < minScore) {
        thresholdReached = true;
        break;
      }
      rows.push({ row, score });
    }
    const observations = await ctx.project.observe(rows.map((r) => r.row.path), undefined, signal);
    for (const { row, score } of rows) {
      examined++;
      const obs = observations.get(row.path)!;
      if (obs.state === 'missing') skipped.missing++;
      else if (obs.state === 'ineligible') skipped.ineligible++;
      else if (obs.state === 'unavailable') {
        skipped.unavailable++;
        if (warnings.length < 10) warnings.push(`A candidate could not be verified (${obs.reason}) and was skipped.`);
      } else {
        const fresh = obs.hash === row.content_hash;
        if (!fresh && !includeStale) {
          skipped.stale++;
        } else {
          results.push({
            path: row.path,
            description: row.description,
            score,
            state: fresh ? 'indexed' : 'stale',
            content_hash: row.content_hash,
            current_hash: obs.hash,
            language: row.language,
            updated_at: row.updated_at
          });
          if (results.length >= limit) return { results, skipped, warnings, examined };
        }
      }
    }
    if (thresholdReached || batch.rows.length < batchSize) break;
    const last = batch.rows[batch.rows.length - 1]!;
    after = { distance: last.distance, path: last.path };
  }
  return { results, skipped, warnings, examined };
}
