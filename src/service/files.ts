/** get_file / remove_file (spec §12.4). Read operations never mutate the index. */
import { SemanticIndexError } from '../errors.js';
import { normalizeRelativePath } from '../project/paths.js';
import type { FileRow } from '../storage/repository.js';
import type { FileRecord, GetFileResult, RemoveFileResult } from '../types.js';
import type { ServiceContext } from './context.js';

export function toRecord(row: FileRow): FileRecord {
  return {
    path: row.path,
    description: row.description,
    content_hash: row.content_hash,
    observed_hash: row.observed_hash,
    size_bytes: row.size_bytes,
    language: row.language,
    indexed_at: row.indexed_at,
    updated_at: row.updated_at,
    state: row.state
  };
}

function pathArg(req: unknown): string {
  if (!req || typeof req !== 'object' || Array.isArray(req)) throw new SemanticIndexError('INVALID_INPUT', 'Request must be an object with a `path`.');
  const keys = Object.keys(req);
  if (keys.some((k) => k !== 'path')) throw new SemanticIndexError('INVALID_INPUT', 'Only `path` is accepted.');
  return normalizeRelativePath((req as { path?: unknown }).path);
}

export async function getFile(ctx: ServiceContext, req: unknown, signal?: AbortSignal): Promise<GetFileResult> {
  const path = pathArg(req);
  ctx.project.fresh();
  const row = ctx.repo.getRow(path);
  const obs = await ctx.project.observeOne(path, signal);
  const record = row ? toRecord(row) : null;
  switch (obs.state) {
    case 'eligible':
      return {
        path,
        state: row ? (obs.hash === row.content_hash ? 'indexed' : 'stale') : 'unindexed',
        current_hash: obs.hash,
        current_size_bytes: obs.size,
        record
      };
    case 'missing':
      if (!row) throw new SemanticIndexError('NOT_FOUND', 'File does not exist and has no index record.');
      return { path, state: 'missing', current_hash: null, current_size_bytes: null, record };
    case 'ineligible':
      if (!row) throw new SemanticIndexError('FILE_NOT_ELIGIBLE', `File is not eligible for indexing (${obs.reason}).`, { details: { reason: obs.reason } });
      return { path, state: 'ineligible', current_hash: null, current_size_bytes: null, record };
    case 'unavailable':
      if (!row) throw new SemanticIndexError('IO_ERROR', 'File could not be read.', { details: { reason: obs.reason } });
      return { path, state: 'unavailable', current_hash: null, current_size_bytes: null, record };
  }
}

/** Delete only the index row (never the source). Idempotent; lexical validation only. */
export async function removeFile(ctx: ServiceContext, req: unknown): Promise<RemoveFileResult> {
  const path = pathArg(req);
  return { path, removed: ctx.repo.deleteRow(path) };
}
