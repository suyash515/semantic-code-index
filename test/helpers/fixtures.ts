import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tempDir(prefix = 'sci-'): string {
  return realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

export function makeProject(files: Record<string, string | Buffer> = {}, { git = false } = {}): string {
  const root = tempDir('sci-proj-');
  if (git) gitInit(root);
  writeFiles(root, files);
  return root;
}

export function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' }
  });
}

export function gitInit(root: string): void {
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'commit.gpgsign', 'false');
}

export function cleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
