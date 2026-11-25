import { lstat, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { SemanticIndexError } from '../errors.js';

/** Read a UTF-8 project file that must be a regular file (not a symlink). Returns null if absent. */
export async function readProjectTextFile(root: string, name: string): Promise<string | null> {
  const file = path.join(root, name);
  try {
    const st = await lstat(file);
    if (!st.isFile()) {
      throw new SemanticIndexError('CONFIG_INVALID', `${name} is not a regular file (symlinks are not modified).`);
    }
    return await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    if (err instanceof SemanticIndexError) throw err;
    throw new SemanticIndexError('IO_ERROR', `Cannot read ${name}.`, { cause: err });
  }
}

/** Atomically replace a project text file (temp file + rename in the same directory). */
export async function writeProjectTextFile(root: string, name: string, content: string): Promise<void> {
  const file = path.join(root, name);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', flag: 'wx' });
    await rename(tmp, file);
  } catch (err) {
    throw new SemanticIndexError('IO_ERROR', `Cannot write ${name}.`, { cause: err });
  }
}

export function detectEol(text: string): '\n' | '\r\n' {
  return text.includes('\r\n') ? '\r\n' : '\n';
}
