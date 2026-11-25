/** Shell-free Git CLI helpers (spec §6.1). Filenames are never interpolated into a shell. */
import { execFile } from 'node:child_process';

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly kind: 'not-installed' | 'not-repo' | 'failed',
    readonly stderr = ''
  ) {
    super(message);
  }
}

const GIT_ENV = {
  GIT_LITERAL_PATHSPECS: '1',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_TERMINAL_PROMPT: '0',
  LC_ALL: 'C',
  LANGUAGE: 'C'
};

export function runGit(cwd: string, args: string[]): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, env: { ...process.env, ...GIT_ENV }, maxBuffer: 512 * 1024 * 1024, windowsHide: true, shell: false },
      (err, stdout, stderr) => {
        if (err) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === 'ENOENT') return reject(new GitError('git is not installed', 'not-installed'));
          if (/not a git repository/i.test(stderr)) return reject(new GitError('not a git repository', 'not-repo', stderr));
          return reject(new GitError('git command failed', 'failed', stderr));
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

/** Returns true when `root` is inside a Git work tree; false when Git is unavailable or not a repository. */
export async function isGitWorkTree(root: string): Promise<boolean> {
  try {
    const { stdout } = await runGit(root, ['rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch (err) {
    if (err instanceof GitError && (err.kind === 'not-installed' || err.kind === 'not-repo')) return false;
    throw err;
  }
}

/** NUL-separated `git ls-files` listing scoped to the cwd (the project root). */
export async function gitListFiles(root: string, pathspecs: string[] = []): Promise<string[]> {
  const args = ['-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard', '-z'];
  if (pathspecs.length > 0) args.push('--', ...pathspecs);
  const { stdout } = await runGit(root, args);
  const out = new Set<string>();
  for (const entry of stdout.split('\0')) {
    if (entry === '' || entry.endsWith('/')) continue; // trailing slash: untracked nested repository
    out.add(entry);
  }
  return [...out];
}

/** Tracked files only (`git ls-files --cached -z`), used to warn about committed generated files. */
export async function gitListTracked(root: string, pathspecs: string[]): Promise<string[]> {
  const { stdout } = await runGit(root, ['ls-files', '--cached', '-z', '--', ...pathspecs]);
  return stdout.split('\0').filter((e) => e !== '');
}
