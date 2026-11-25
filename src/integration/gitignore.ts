import { GITIGNORE_RULE } from '../config/defaults.js';
import { detectEol, readProjectTextFile, writeProjectTextFile } from './text-files.js';

/** Pure merge: returns the new text, or null if the rule is already present. */
export function mergeGitignore(existing: string | null): string | null {
  if (existing === null) return `${GITIGNORE_RULE}\n`;
  const lines = existing.split(/\r?\n/).map((l) => l.trim());
  if (lines.includes(GITIGNORE_RULE)) return null;
  const eol = detectEol(existing);
  const sep = existing.length === 0 || existing.endsWith('\n') ? '' : eol;
  return `${existing}${sep}${GITIGNORE_RULE}${eol}`;
}

/** Idempotently add `/.semantic-index/` to the root .gitignore. Returns true if changed. */
export async function ensureGitignore(root: string): Promise<boolean> {
  const existing = await readProjectTextFile(root, '.gitignore');
  const next = mergeGitignore(existing);
  if (next === null) return false;
  await writeProjectTextFile(root, '.gitignore', next);
  return true;
}
