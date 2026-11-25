/** SQLite connection: native loading, sqlite-vec from its installed package only, pragmas (spec §7.2). */
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { chmod, lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { SemanticIndexError } from '../errors.js';
import { DB_FILE_NAME, INDEX_DIR_NAME, LIMITS } from '../config/defaults.js';

export type Db = Database.Database;

export function indexPaths(root: string): { dir: string; file: string } {
  const dir = path.join(root, INDEX_DIR_NAME);
  return { dir, file: path.join(dir, DB_FILE_NAME) };
}

async function lstatOrNull(p: string) {
  try {
    return await lstat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new SemanticIndexError('IO_ERROR', 'Cannot inspect the index directory.', { cause: err });
  }
}

/** Ensure the package-owned directory exists (never a symlink) with restrictive permissions. */
export async function ensureIndexDir(root: string): Promise<boolean> {
  const { dir } = indexPaths(root);
  const st = await lstatOrNull(dir);
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new SemanticIndexError('DB_ERROR', `${INDEX_DIR_NAME} must be a real directory (symlinks are rejected).`);
    }
    return false;
  }
  try {
    await mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw new SemanticIndexError('IO_ERROR', `Cannot create ${INDEX_DIR_NAME}.`, { cause: err });
    }
    return false;
  }
  return true;
}

/**
 * Open the index database. With `create: false`, a missing index yields NOT_INITIALIZED
 * so nothing is created silently in the wrong directory.
 */
export async function openDatabase(root: string, { create }: { create: boolean }): Promise<Db> {
  const { dir, file } = indexPaths(root);
  const dirSt = await lstatOrNull(dir);
  if (!dirSt) {
    if (!create) throw notInitialized();
    await ensureIndexDir(root);
  } else if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
    throw new SemanticIndexError('DB_ERROR', `${INDEX_DIR_NAME} must be a real directory (symlinks are rejected).`);
  }
  const fileSt = await lstatOrNull(file);
  if (fileSt && (fileSt.isSymbolicLink() || !fileSt.isFile())) {
    throw new SemanticIndexError('DB_ERROR', 'The index database must be a regular file (symlinks are rejected).');
  }
  if (!fileSt && !create) throw notInitialized();

  let db: Db;
  try {
    db = new Database(file, { fileMustExist: !create, timeout: LIMITS.busyTimeoutMs });
  } catch (err) {
    throw new SemanticIndexError('DB_ERROR', 'Cannot open the index database.', { cause: err, retryable: false });
  }
  try {
    if (!fileSt && process.platform !== 'win32') await chmod(file, 0o600).catch(() => undefined);
    sqliteVec.load(db);
    db.pragma(`busy_timeout = ${LIMITS.busyTimeoutMs}`);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
  } catch (err) {
    db.close();
    const code = (err as { code?: string }).code;
    if (code === 'SQLITE_BUSY') throw new SemanticIndexError('DB_BUSY', 'The index database is busy; retry shortly.', { cause: err });
    if (code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT') {
      throw new SemanticIndexError('DB_ERROR', 'The index database is corrupt or not a SQLite database. It was not modified; remove .semantic-index/ and run init to rebuild.', { cause: err, retryable: false });
    }
    throw new SemanticIndexError('DB_ERROR', 'Cannot configure the index database.', { cause: err, retryable: false });
  }
  return db;
}

function notInitialized(): SemanticIndexError {
  return new SemanticIndexError('NOT_INITIALIZED', 'No semantic index found in this project root. Run `semantic-code-index init` from the project root (or pass --root).');
}
