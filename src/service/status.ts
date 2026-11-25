/** Status and discovery listings (spec §9.5). Read-only; freshness is computed from disk. */
import { SemanticIndexError } from '../errors.js';
import { LIMITS, SCHEMA_VERSION } from '../config/defaults.js';
import { normalizePrefix } from '../project/paths.js';
import { inferLanguage } from '../project/language.js';
import { compareUtf8 } from '../project/scanner.js';
import type { FileSummary, IndexStatus, ListRequest, Page, StaleFileSummary } from '../types.js';
import { finalizeWarnings, isModelCompatible, checkAborted, type ServiceContext } from './context.js';
import { decodeCursor, encodeCursor } from './cursor.js';

function scopeArg(req: unknown, allowed: string[]): Record<string, unknown> {
  if (req === undefined || req === null) return {};
  if (typeof req !== 'object' || Array.isArray(req)) throw new SemanticIndexError('INVALID_INPUT', 'Request must be an object.');
  const unknown = Object.keys(req).filter((k) => !allowed.includes(k));
  if (unknown.length > 0) throw new SemanticIndexError('INVALID_INPUT', `Unknown parameters: ${unknown.slice(0, 5).join(', ')}.`);
  return req as Record<string, unknown>;
}

export async function getIndexStatus(ctx: ServiceContext, req: unknown, signal?: AbortSignal): Promise<IndexStatus> {
  const prefix = normalizePrefix(scopeArg(req, ['path_prefix']).path_prefix);
  ctx.project.fresh();
  const rows = ctx.repo.rowsInPrefix(prefix);
  const scan = await ctx.project.scan(prefix, signal);
  const scanned = new Set(scan.paths);
  const rowByPath = new Map(rows.map((r) => [r.path, r]));
  const all = [...new Set([...scan.paths, ...rows.map((r) => r.path)])];
  const obs = await ctx.project.observe(all, scanned, signal);

  const counts = { fresh: 0, stale: 0, unindexed: 0, missing: 0, ineligible: 0, unavailable: 0 };
  const warnings = [...scan.warnings];
  let unreadableCandidates = 0;
  for (const p of all) {
    const o = obs.get(p)!;
    const row = rowByPath.get(p);
    if (o.state === 'eligible') {
      if (!row) counts.unindexed++;
      else if (o.hash === row.content_hash) counts.fresh++;
      else counts.stale++;
    } else if (row) {
      counts[o.state]++;
    } else if (o.state === 'unavailable') {
      unreadableCandidates++;
    }
  }
  if (unreadableCandidates > 0) warnings.push(`${unreadableCandidates} candidate file(s) could not be read and were not counted.`);
  if (!scan.complete) warnings.push('The scan was incomplete; counts are partial.');
  const eligible = counts.fresh + counts.stale + counts.unindexed;
  const compatible = isModelCompatible(ctx);
  if (!compatible) warnings.push('The stored embedding profile differs from the active model; indexing and search return MODEL_MISMATCH until `reembed` or `reset --yes`.');
  return {
    eligible,
    ...counts,
    coverage: eligible === 0 ? null : counts.fresh / eligible,
    complete: scan.complete && counts.unavailable === 0 && unreadableCandidates === 0,
    scan_mode: scan.mode,
    embedding_model: ctx.expectedProfile.model,
    model_compatible: compatible,
    schema_version: SCHEMA_VERSION,
    warnings: finalizeWarnings(warnings, LIMITS.warningsMax)
  };
}

function listArgs(req: unknown) {
  const r = scopeArg(req, ['path_prefix', 'cursor', 'limit']);
  const prefix = normalizePrefix(r.path_prefix);
  let limit: number = LIMITS.listPageDefault;
  if (r.limit !== undefined) {
    if (typeof r.limit !== 'number' || !Number.isInteger(r.limit) || r.limit < 1 || r.limit > LIMITS.listPageMax) {
      throw new SemanticIndexError('INVALID_INPUT', `limit must be an integer from 1 to ${LIMITS.listPageMax}.`);
    }
    limit = r.limit;
  }
  if (r.cursor !== undefined && r.cursor !== null && typeof r.cursor !== 'string') throw new SemanticIndexError('INVALID_CURSOR', 'cursor must be a string.');
  return { prefix, limit, cursor: (r.cursor as string | undefined | null) ?? null };
}

export async function listUnindexedFiles(ctx: ServiceContext, req: ListRequest | undefined, signal?: AbortSignal): Promise<Page<FileSummary>> {
  const { prefix, limit, cursor } = listArgs(req);
  ctx.project.fresh();
  const generation = ctx.repo.getGeneration();
  const after = cursor ? decodeCursor(cursor, 'unindexed', prefix, generation) : null;
  const scan = await ctx.project.scan(prefix, signal);
  const scanned = new Set(scan.paths);
  const indexed = ctx.repo.pathsInPrefix(prefix);
  const candidates = scan.paths.filter((p) => !indexed.has(p) && (after === null || compareUtf8(p, after) > 0));

  const files: FileSummary[] = [];
  const warnings = [...scan.warnings];
  if (!scan.complete) warnings.push('The scan was incomplete; this listing may be partial.');
  let i = 0;
  let unreadable = 0;
  while (i < candidates.length && files.length < limit) {
    checkAborted(signal);
    // Hash only as many candidates as needed (bounded chunks).
    const chunk = candidates.slice(i, i + Math.max(8, limit - files.length));
    i += chunk.length;
    const obs = await ctx.project.observe(chunk, scanned, signal);
    for (const p of chunk) {
      const o = obs.get(p)!;
      if (o.state === 'eligible') {
        if (files.length < limit) files.push({ path: p, size_bytes: o.size, current_hash: o.hash, language: inferLanguage(p), state: 'unindexed' });
      } else if (o.state === 'unavailable') unreadable++;
    }
  }
  if (unreadable > 0) warnings.push(`${unreadable} file(s) could not be read and were skipped.`);
  const last = files[files.length - 1];
  const more = last !== undefined && candidates.some((p) => compareUtf8(p, last.path) > 0);
  return {
    files,
    next_cursor: more ? encodeCursor('unindexed', prefix, generation, last.path) : null,
    scan_mode: scan.mode,
    warnings: finalizeWarnings(warnings)
  };
}

export async function listStaleFiles(ctx: ServiceContext, req: ListRequest | undefined, signal?: AbortSignal): Promise<Page<StaleFileSummary>> {
  const { prefix, limit, cursor } = listArgs(req);
  ctx.project.fresh();
  const generation = ctx.repo.getGeneration();
  let after = cursor ? decodeCursor(cursor, 'stale', prefix, generation) : null;
  const { mode } = await ctx.project.ctx();
  const files: StaleFileSummary[] = [];
  const warnings: string[] = [];
  let more = false;
  let unreadable = 0;
  const batchSize = 100;
  outer: for (;;) {
    checkAborted(signal);
    const rows = ctx.repo.rowsAfter(prefix, after, batchSize);
    if (rows.length === 0) break;
    const obs = await ctx.project.observe(rows.map((r) => r.path), undefined, signal);
    for (const row of rows) {
      const o = obs.get(row.path)!;
      if (o.state === 'eligible' && o.hash !== row.content_hash) {
        if (files.length >= limit) {
          more = true;
          break outer;
        }
        files.push({
          path: row.path,
          size_bytes: o.size,
          current_hash: o.hash,
          language: row.language ?? inferLanguage(row.path),
          state: 'stale',
          content_hash: row.content_hash,
          description: row.description,
          updated_at: row.updated_at
        });
      } else if (o.state === 'unavailable') unreadable++;
    }
    if (rows.length < batchSize) break;
    after = rows[rows.length - 1]!.path;
  }
  if (unreadable > 0) warnings.push(`${unreadable} indexed file(s) could not be read and were skipped.`);
  const last = files[files.length - 1];
  return {
    files,
    next_cursor: more && last ? encodeCursor('stale', prefix, generation, last.path) : null,
    scan_mode: mode,
    warnings: finalizeWarnings(warnings)
  };
}
