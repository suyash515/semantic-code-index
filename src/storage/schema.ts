/** Schema v1 creation and verification (spec §7.1). No legacy migrations in v0.1. */
import { SemanticIndexError } from '../errors.js';
import { SCHEMA_VERSION } from '../config/defaults.js';
import type { Db } from './connection.js';

const DDL = `
CREATE TABLE metadata (
    key TEXT PRIMARY KEY NOT NULL,
    value TEXT NOT NULL
);

CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    path TEXT NOT NULL UNIQUE COLLATE BINARY,
    description TEXT NOT NULL CHECK (length(description) > 0),
    content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
    observed_hash TEXT CHECK (observed_hash IS NULL OR length(observed_hash) = 64),
    embedding BLOB NOT NULL CHECK (typeof(embedding) = 'blob' AND length(embedding) = 1536),
    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
    language TEXT,
    state TEXT NOT NULL CHECK (state IN ('indexed', 'stale')),
    indexed_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX files_state_idx ON files(state);
`;

export const REQUIRED_METADATA = ['embedding_profile', 'created_at', 'schema_version', 'index_generation'] as const;

function userVersion(db: Db): number {
  return db.pragma('user_version', { simple: true }) as number;
}

function tableCount(db: Db): number {
  return (db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }).n;
}

/**
 * Create schema v1 in an IMMEDIATE transaction (serialized against concurrent initializers).
 * Returns true if the schema was created, false if a compatible schema already existed.
 */
export function initializeSchema(db: Db, profileJson: string): boolean {
  return db
    .transaction(() => {
      const version = userVersion(db);
      if (version === 0) {
        if (tableCount(db) > 0) {
          throw new SemanticIndexError('SCHEMA_UNSUPPORTED', 'The index database contains unknown tables; it was not modified.');
        }
        db.exec(DDL);
        const insert = db.prepare('INSERT INTO metadata (key, value) VALUES (?, ?)');
        insert.run('schema_version', String(SCHEMA_VERSION));
        insert.run('created_at', new Date().toISOString());
        insert.run('embedding_profile', profileJson);
        insert.run('index_generation', '0');
        db.pragma(`user_version = ${SCHEMA_VERSION}`);
        return true;
      }
      verifySchemaInTx(db);
      return false;
    })
    .immediate();
}

/** Verify the opened database matches schema v1; never resets or migrates. */
export function verifySchema(db: Db): void {
  db.transaction(() => verifySchemaInTx(db)).deferred();
}

function verifySchemaInTx(db: Db): void {
  const version = userVersion(db);
  if (version === 0) {
    if (tableCount(db) === 0) {
      throw new SemanticIndexError('NOT_INITIALIZED', 'The index database is empty. Run `semantic-code-index init`.');
    }
    throw new SemanticIndexError('SCHEMA_UNSUPPORTED', 'The index database has no recognized schema version.');
  }
  if (version > SCHEMA_VERSION) {
    throw new SemanticIndexError('SCHEMA_UNSUPPORTED', `Index schema version ${version} is newer than supported (${SCHEMA_VERSION}). Upgrade semantic-code-index.`);
  }
  if (version !== SCHEMA_VERSION) {
    throw new SemanticIndexError('SCHEMA_UNSUPPORTED', `Index schema version ${version} is not supported.`);
  }
  let rows: { key: string; value: string }[];
  try {
    rows = db.prepare('SELECT key, value FROM metadata').all() as { key: string; value: string }[];
    db.prepare('SELECT id, path, description, content_hash, observed_hash, embedding, size_bytes, language, state, indexed_at, updated_at FROM files LIMIT 0').all();
  } catch (err) {
    throw new SemanticIndexError('DB_ERROR', 'The index database schema is damaged; it was not modified.', { cause: err, retryable: false });
  }
  const meta = new Map(rows.map((r) => [r.key, r.value]));
  for (const key of REQUIRED_METADATA) {
    if (!meta.has(key)) throw new SemanticIndexError('DB_ERROR', `Index metadata is missing "${key}"; it was not modified.`, { retryable: false });
  }
  if (meta.get('schema_version') !== String(version)) {
    throw new SemanticIndexError('DB_ERROR', 'PRAGMA user_version and metadata schema_version disagree; the index was not modified.', { retryable: false });
  }
  if (!/^\d+$/.test(meta.get('index_generation')!)) {
    throw new SemanticIndexError('DB_ERROR', 'Index generation metadata is corrupt; the index was not modified.', { retryable: false });
  }
}
