/**
 * All SQL lives here. Prepared statements with bound parameters only; short write
 * transactions with compare-and-swap against previously read row versions (spec §7.2).
 */
import { SemanticIndexError } from '../errors.js';
import type Database from 'better-sqlite3';
import type { Db } from './connection.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Stmt = Database.Statement<any[], unknown>;

export interface FileRow {
  id: number;
  path: string;
  description: string;
  content_hash: string;
  observed_hash: string | null;
  size_bytes: number;
  language: string | null;
  state: 'indexed' | 'stale';
  indexed_at: string;
  updated_at: string;
}

/** Compare-and-swap token: the row as previously read, or null when no row existed. */
export type RowVersion = Pick<FileRow, 'id' | 'description' | 'content_hash' | 'observed_hash' | 'state' | 'updated_at'> | null;

export function versionOf(row: FileRow | null | undefined): RowVersion {
  if (!row) return null;
  const { id, description, content_hash, observed_hash, state, updated_at } = row;
  return { id, description, content_hash, observed_hash, state, updated_at };
}

export function sameVersion(row: FileRow | null | undefined, version: RowVersion): boolean {
  if (!row || !version) return !row && !version;
  return (
    row.id === version.id &&
    row.description === version.description &&
    row.content_hash === version.content_hash &&
    row.observed_hash === version.observed_hash &&
    row.state === version.state &&
    row.updated_at === version.updated_at
  );
}

export interface SearchCandidate {
  path: string;
  description: string;
  content_hash: string;
  state: 'indexed' | 'stale';
  language: string | null;
  indexed_at: string;
  updated_at: string;
  distance: number;
}

export interface IndexWrite {
  path: string;
  expected: RowVersion;
  description: string;
  content_hash: string;
  size_bytes: number;
  language: string | null;
  /** New vector bytes, or null to keep the existing row's vector (reaffirmed description). */
  embedding: Buffer | null;
}

export type IndexWriteOutcome = 'created' | 'updated' | 'unchanged' | 'conflict';

export type ReconcileAction =
  | { kind: 'mark_stale'; path: string; expected: RowVersion; observed_hash: string }
  | { kind: 'restore'; path: string; expected: RowVersion }
  | { kind: 'delete'; path: string; expected: RowVersion };

const ROW_COLUMNS = 'id, path, description, content_hash, observed_hash, size_bytes, language, state, indexed_at, updated_at';
const PREFIX_FILTER = '(@prefix IS NULL OR substr(path, 1, length(@prefix)) = @prefix)';

export class Repository {
  constructor(private readonly db: Db) {}

  private stmtCache = new Map<string, Stmt>();
  private stmt(sql: string): Stmt {
    let s = this.stmtCache.get(sql);
    if (!s) {
      s = this.db.prepare(sql) as Stmt;
      this.stmtCache.set(sql, s);
    }
    return s;
  }

  getMetadata(key: string): string | undefined {
    return (this.stmt('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }

  getGeneration(): number {
    return Number(this.getMetadata('index_generation') ?? '0');
  }

  getProfileJson(): string {
    return this.getMetadata('embedding_profile') ?? '';
  }

  private bumpGeneration(): void {
    this.stmt("UPDATE metadata SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'index_generation'").run();
  }

  private assertProfile(profileJson: string): void {
    if (this.getProfileJson() !== profileJson) {
      throw new SemanticIndexError('MODEL_MISMATCH', 'The index was built with a different embedding profile. Run `semantic-code-index reembed` or `reset --yes`.');
    }
  }

  getRow(path: string): FileRow | null {
    return (this.stmt(`SELECT ${ROW_COLUMNS} FROM files WHERE path = ?`).get(path) as FileRow | undefined) ?? null;
  }

  getEmbedding(path: string): Buffer | null {
    return (this.stmt('SELECT embedding FROM files WHERE path = ?').get(path) as { embedding: Buffer } | undefined)?.embedding ?? null;
  }

  countInPrefix(prefix: string | null): number {
    return (this.stmt(`SELECT count(*) AS n FROM files WHERE ${PREFIX_FILTER}`).get({ prefix }) as { n: number }).n;
  }

  totalRows(): number {
    return (this.stmt('SELECT count(*) AS n FROM files').get() as { n: number }).n;
  }

  /** Rows in scope ordered by path (BINARY), without vectors. */
  rowsInPrefix(prefix: string | null): FileRow[] {
    return this.stmt(`SELECT ${ROW_COLUMNS} FROM files WHERE ${PREFIX_FILTER} ORDER BY path`).all({ prefix }) as FileRow[];
  }

  /** Keyset page of rows in scope with path > after, ordered by path. */
  rowsAfter(prefix: string | null, after: string | null, limit: number): FileRow[] {
    return this.stmt(
      `SELECT ${ROW_COLUMNS} FROM files WHERE ${PREFIX_FILTER} AND (@after IS NULL OR path > @after) ORDER BY path LIMIT @limit`
    ).all({ prefix, after, limit }) as FileRow[];
  }

  pathsInPrefix(prefix: string | null): Set<string> {
    const rows = this.stmt(`SELECT path FROM files WHERE ${PREFIX_FILTER}`).all({ prefix }) as { path: string }[];
    return new Set(rows.map((r) => r.path));
  }

  /**
   * Exact cosine ranking in SQL with the path scope applied before ordering.
   * Keyset continuation on (distance, path). Returns the generation read in the same snapshot.
   */
  searchBatch(
    query: Buffer,
    prefix: string | null,
    after: { distance: number; path: string } | null,
    limit: number
  ): { generation: number; rows: SearchCandidate[] } {
    return this.db
      .transaction(() => {
        const generation = this.getGeneration();
        const rows = this.stmt(
          `SELECT path, description, content_hash, state, language, indexed_at, updated_at, distance FROM (
             SELECT path, description, content_hash, state, language, indexed_at, updated_at,
                    vec_distance_cosine(embedding, @query) AS distance
             FROM files WHERE ${PREFIX_FILTER}
           )
           WHERE (@after_distance IS NULL OR distance > @after_distance OR (distance = @after_distance AND path > @after_path))
           ORDER BY distance ASC, path COLLATE BINARY ASC
           LIMIT @limit`
        ).all({
          query,
          prefix,
          after_distance: after?.distance ?? null,
          after_path: after?.path ?? null,
          limit
        }) as SearchCandidate[];
        return { generation, rows };
      })
      .deferred();
  }

  /** Iterate (id, path, description) for re-embedding, keyset by id. */
  descriptionsAfter(afterId: number, limit: number): { id: number; path: string; description: string }[] {
    return this.stmt('SELECT id, path, description FROM files WHERE id > ? ORDER BY id LIMIT ?').all(afterId, limit) as {
      id: number;
      path: string;
      description: string;
    }[];
  }

  /** Apply index writes atomically per row inside one short IMMEDIATE transaction with CAS. */
  applyIndexWrites(writes: readonly IndexWrite[], profileJson: string, now: string): IndexWriteOutcome[] {
    return this.db
      .transaction(() => {
        this.assertProfile(profileJson);
        let changed = false;
        const outcomes = writes.map((w): IndexWriteOutcome => {
          const current = this.getRow(w.path);
          const intendedMatches =
            current !== null &&
            current.description === w.description &&
            current.content_hash === w.content_hash &&
            current.state === 'indexed' &&
            current.observed_hash === w.content_hash;
          if (!sameVersion(current, w.expected)) return intendedMatches ? 'unchanged' : 'conflict';
          if (current === null) {
            if (!w.embedding) return 'conflict';
            this.stmt(
              `INSERT INTO files (path, description, content_hash, observed_hash, embedding, size_bytes, language, state, indexed_at, updated_at)
               VALUES (@path, @description, @hash, @hash, @embedding, @size, @language, 'indexed', @now, @now)`
            ).run({ path: w.path, description: w.description, hash: w.content_hash, embedding: w.embedding, size: w.size_bytes, language: w.language, now });
            changed = true;
            return 'created';
          }
          if (intendedMatches) return 'unchanged';
          const sameContent = current.description === w.description && current.content_hash === w.content_hash;
          if (w.embedding) {
            this.stmt(
              `UPDATE files SET description = @description, content_hash = @hash, observed_hash = @hash, embedding = @embedding,
               size_bytes = @size, language = @language, state = 'indexed', updated_at = @now WHERE id = @id`
            ).run({ id: current.id, description: w.description, hash: w.content_hash, embedding: w.embedding, size: w.size_bytes, language: w.language, now });
          } else {
            if (current.description !== w.description) return 'conflict';
            this.stmt(
              `UPDATE files SET content_hash = @hash, observed_hash = @hash, size_bytes = @size, language = @language,
               state = 'indexed', updated_at = @now WHERE id = @id`
            ).run({ id: current.id, hash: w.content_hash, size: w.size_bytes, language: w.language, now });
          }
          changed = true;
          // Restoring fresh state for an identical description+hash is still reported as unchanged.
          return sameContent ? 'unchanged' : 'updated';
        });
        if (changed) this.bumpGeneration();
        return outcomes;
      })
      .immediate();
  }

  /** Delete a record (never a source file). Returns true if a row was removed. */
  deleteRow(path: string): boolean {
    return this.db
      .transaction(() => {
        const info = this.stmt('DELETE FROM files WHERE path = ?').run(path);
        if (info.changes > 0) this.bumpGeneration();
        return info.changes > 0;
      })
      .immediate();
  }

  /** Apply reconcile actions with per-row CAS. Returns per-action success (false = conflict). */
  applyReconcile(actions: readonly ReconcileAction[], now: string): boolean[] {
    return this.db
      .transaction(() => {
        let changed = false;
        const results = actions.map((a) => {
          const current = this.getRow(a.path);
          if (!sameVersion(current, a.expected) || !current) return false;
          if (a.kind === 'delete') {
            this.stmt('DELETE FROM files WHERE id = ?').run(current.id);
          } else if (a.kind === 'mark_stale') {
            this.stmt("UPDATE files SET state = 'stale', observed_hash = ?, updated_at = ? WHERE id = ?").run(a.observed_hash, now, current.id);
          } else {
            this.stmt("UPDATE files SET state = 'indexed', observed_hash = content_hash, updated_at = ? WHERE id = ?").run(now, current.id);
          }
          changed = true;
          return true;
        });
        if (changed) this.bumpGeneration();
        return results;
      })
      .immediate();
  }

  /** Transactional logical reset: remove all rows, keep schema, set the current profile. */
  reset(profileJson: string): number {
    return this.db
      .transaction(() => {
        const removed = this.stmt('DELETE FROM files').run().changes;
        this.stmt("UPDATE metadata SET value = ? WHERE key = 'embedding_profile'").run(profileJson);
        this.bumpGeneration();
        return removed;
      })
      .immediate();
  }

  /**
   * Atomically replace all vectors and the profile, only if the generation is unchanged
   * and the staged set covers exactly the current rows (all-or-nothing re-embedding).
   */
  applyReembed(expectedGeneration: number, vectors: ReadonlyMap<number, Buffer>, profileJson: string): number {
    return this.db
      .transaction(() => {
        if (this.getGeneration() !== expectedGeneration || this.totalRows() !== vectors.size) {
          throw new SemanticIndexError('INDEX_CHANGED', 'The index changed while re-embedding; nothing was modified. Retry.');
        }
        const update = this.stmt('UPDATE files SET embedding = ? WHERE id = ?');
        for (const [id, vec] of vectors) {
          if (update.run(vec, id).changes !== 1) {
            throw new SemanticIndexError('INDEX_CHANGED', 'The index changed while re-embedding; nothing was modified. Retry.');
          }
        }
        this.stmt("UPDATE metadata SET value = ? WHERE key = 'embedding_profile'").run(profileJson);
        this.bumpGeneration();
        return this.getGeneration();
      })
      .immediate();
  }
}
