/** Opaque, versioned pagination cursors bound to list type, scope and index generation (spec §9.5). */
import { SemanticIndexError } from '../errors.js';

export type ListType = 'unindexed' | 'stale';

interface CursorPayload {
  v: 1;
  t: ListType;
  p: string | null;
  g: number;
  k: string;
}

export function encodeCursor(type: ListType, prefix: string | null, generation: number, lastPath: string): string {
  const payload: CursorPayload = { v: 1, t: type, p: prefix, g: generation, k: lastPath };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

/** Decode and validate; INVALID_CURSOR for malformed/incompatible, INDEX_CHANGED for stale generation. */
export function decodeCursor(cursor: string, type: ListType, prefix: string | null, generation: number): string {
  const invalid = () => new SemanticIndexError('INVALID_CURSOR', 'The cursor is malformed or belongs to a different listing; restart without a cursor.');
  if (typeof cursor !== 'string' || cursor.length === 0 || cursor.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!payload || typeof payload !== 'object') throw invalid();
  const c = payload as Partial<CursorPayload>;
  if (c.v !== 1 || (c.t !== 'unindexed' && c.t !== 'stale') || typeof c.k !== 'string' || c.k.length === 0) throw invalid();
  if (!(c.p === null || typeof c.p === 'string') || typeof c.g !== 'number' || !Number.isInteger(c.g) || c.g < 0) throw invalid();
  if (c.t !== type || c.p !== prefix) throw invalid();
  if (c.g !== generation) {
    throw new SemanticIndexError('INDEX_CHANGED', 'The index changed since this cursor was issued; restart the listing without a cursor.');
  }
  return c.k;
}
