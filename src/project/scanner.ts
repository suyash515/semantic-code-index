/**
 * Project file discovery and per-path observation (spec §6.1, §9.1).
 * Observations are computed from the filesystem; persisted DB state is never trusted.
 */
import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { ResolvedConfig } from '../config/defaults.js';
import { SemanticIndexError } from '../errors.js';
import type { ScanMode } from '../types.js';
import { mapLimit } from '../util/concurrency.js';
import { LIMITS } from '../config/defaults.js';
import { PathPolicy, isHardExcludedDir } from './eligibility.js';
import { GitError, gitListFiles, isGitWorkTree } from './git.js';
import { inspectContent } from './hash.js';
import { inspectDirectory, inspectPath, isWithinPrefix, normalizeRelativePath } from './paths.js';
import { readProjectTextFile } from '../integration/text-files.js';

export type Observation =
  | { state: 'eligible'; hash: string; size: number }
  | { state: 'missing' }
  | { state: 'ineligible'; reason: string }
  | { state: 'unavailable'; reason: string };

export interface ScanResult {
  mode: ScanMode;
  /** Candidate paths passing path-level policy, sorted by UTF-8 bytes; content not yet checked. */
  paths: string[];
  complete: boolean;
  warnings: string[];
}

/** Compare by UTF-8 bytes, matching SQLite BINARY collation. */
export function compareUtf8(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

const EXPLICIT_GIT_CHUNK = 100;

export class Project {
  private policyPromise: Promise<{ mode: ScanMode; policy: PathPolicy }> | null = null;

  constructor(
    readonly root: string,
    readonly config: ResolvedConfig
  ) {}

  /** Detect scan mode and build the path policy (re-evaluated per operation; cheap). */
  private async context(): Promise<{ mode: ScanMode; policy: PathPolicy }> {
    let git: boolean;
    try {
      git = await isGitWorkTree(this.root);
    } catch (err) {
      throw new SemanticIndexError('SCAN_FAILED', 'Git reported an unexpected error while detecting the repository.', {
        cause: err,
        retryable: true
      });
    }
    if (git) return { mode: 'git', policy: new PathPolicy(this.config.scan) };
    const gitignore = await readProjectTextFile(this.root, '.gitignore').catch(() => null);
    return { mode: 'filesystem', policy: new PathPolicy(this.config.scan, gitignore) };
  }

  /** One context per top-level operation; call `fresh()` to start a new operation. */
  async ctx(): Promise<{ mode: ScanMode; policy: PathPolicy }> {
    this.policyPromise ??= this.context();
    try {
      return await this.policyPromise;
    } catch (err) {
      this.policyPromise = null;
      throw err;
    }
  }

  fresh(): this {
    this.policyPromise = null;
    return this;
  }

  /** Enumerate candidate paths in scope. Throws SCAN_FAILED on Git failure (never broadens traversal). */
  async scan(prefix: string | null, signal?: AbortSignal): Promise<ScanResult> {
    const { mode, policy } = await this.ctx();
    if (prefix !== null) {
      const dir = await inspectDirectory(this.root, prefix.slice(0, -1));
      if (dir === 'missing' || dir === 'invalid') return { mode, paths: [], complete: true, warnings: [] };
      if (dir === 'error') throw new SemanticIndexError('SCAN_FAILED', 'The requested scope cannot be read.', { retryable: true });
    }
    if (mode === 'git') {
      let listed: string[];
      try {
        listed = await gitListFiles(this.root, prefix ? [prefix.slice(0, -1)] : []);
      } catch (err) {
        const stderr = err instanceof GitError ? err.stderr.split('\n')[0]?.slice(0, 200) : undefined;
        throw new SemanticIndexError('SCAN_FAILED', 'git ls-files failed; the scan was aborted without falling back.', {
          cause: err,
          retryable: true,
          details: stderr ? { git: stderr } : undefined
        });
      }
      const paths = listed.filter((p) => isWithinPrefix(p, prefix) && isSafeRelative(p) && policy.allowsFile(p));
      paths.sort(compareUtf8);
      return { mode, paths, complete: true, warnings: [] };
    }
    return this.walk(policy, prefix, signal);
  }

  private async walk(policy: PathPolicy, prefix: string | null, signal?: AbortSignal): Promise<ScanResult> {
    const out: string[] = [];
    const warnings: string[] = [];
    let complete = true;
    const stack: string[] = [prefix ? prefix.slice(0, -1) : ''];
    while (stack.length > 0) {
      if (signal?.aborted) throw new SemanticIndexError('SCAN_FAILED', 'Scan cancelled.', { retryable: true });
      const relDir = stack.pop()!;
      const absDir = relDir === '' ? this.root : path.join(this.root, ...relDir.split('/'));
      const dirs: string[] = [];
      try {
        const dir = await opendir(absDir);
        const entries: { name: string; kind: 'dir' | 'file' | 'other' }[] = [];
        for await (const ent of dir) {
          entries.push({ name: ent.name, kind: ent.isDirectory() ? 'dir' : ent.isFile() ? 'file' : 'other' });
        }
        // A nested repository (other than the root itself) is not traversed.
        if (relDir !== '' && entries.some((e) => e.name === '.git')) continue;
        for (const e of entries) {
          const rel = relDir === '' ? e.name : `${relDir}/${e.name}`;
          if (e.kind === 'dir') {
            if (!isHardExcludedDir(e.name) && policy.allowsDirectory(rel)) dirs.push(rel);
          } else if (e.kind === 'file') {
            if (isSafeRelative(rel) && policy.allowsFile(rel)) out.push(rel);
          }
          // symlinks, sockets, devices, FIFOs: never followed or indexed
        }
      } catch (err) {
        complete = false;
        if (warnings.length < LIMITS.warningsMax) {
          warnings.push(`Directory ${relDir || '.'} could not be read (${(err as NodeJS.ErrnoException).code ?? 'error'}).`);
        }
        continue;
      }
      dirs.sort(compareUtf8).reverse();
      stack.push(...dirs);
    }
    out.sort(compareUtf8);
    return { mode: 'filesystem', paths: out, complete, warnings };
  }

  /**
   * Observe paths against current filesystem bytes and scan policy.
   * When `enumerated` is given (paths from a scan of the same scope), membership defines
   * ignore-rule eligibility; otherwise ignore rules are checked explicitly per path.
   */
  async observe(paths: readonly string[], enumerated?: ReadonlySet<string>, signal?: AbortSignal): Promise<Map<string, Observation>> {
    const { mode, policy } = await this.ctx();
    const result = new Map<string, Observation>();
    const pending: { p: string; abs: string }[] = [];

    await mapLimit(
      paths,
      LIMITS.fileConcurrency,
      async (p) => {
        if (!isSafeRelative(p)) return void result.set(p, { state: 'ineligible', reason: 'invalid-path' });
        const insp = await inspectPath(this.root, p);
        switch (insp.kind) {
          case 'missing':
            return void result.set(p, { state: 'missing' });
          case 'symlink':
            return void result.set(p, { state: 'ineligible', reason: 'symlink' });
          case 'not-file':
            return void result.set(p, { state: 'ineligible', reason: 'not-regular-file' });
          case 'case-mismatch':
            return void result.set(p, { state: 'missing' });
          case 'error':
            return void result.set(p, { state: 'unavailable', reason: insp.code });
          case 'file':
            break;
        }
        if (!policy.allowsFile(p)) return void result.set(p, { state: 'ineligible', reason: 'excluded' });
        if (enumerated) {
          if (!enumerated.has(p)) return void result.set(p, { state: 'ineligible', reason: 'ignored' });
        } else if (await this.insideNestedRepo(p)) {
          return void result.set(p, { state: 'ineligible', reason: 'nested-repository' });
        }
        pending.push({ p, abs: insp.abs });
      },
      signal
    );

    // Explicit ignore-rule check in Git mode for paths not covered by an enumeration.
    let gitAllowed: Set<string> | null = null;
    if (!enumerated && mode === 'git' && pending.length > 0) {
      gitAllowed = new Set();
      const sorted = pending.map((x) => x.p);
      for (let i = 0; i < sorted.length; i += EXPLICIT_GIT_CHUNK) {
        let listed: string[];
        try {
          listed = await gitListFiles(this.root, sorted.slice(i, i + EXPLICIT_GIT_CHUNK));
        } catch (err) {
          throw new SemanticIndexError('SCAN_FAILED', 'git ls-files failed while checking ignore rules.', { cause: err, retryable: true });
        }
        for (const l of listed) gitAllowed.add(l);
      }
    }

    await mapLimit(
      pending,
      LIMITS.fileConcurrency,
      async ({ p, abs }) => {
        if (gitAllowed && !gitAllowed.has(p)) return void result.set(p, { state: 'ineligible', reason: 'ignored' });
        const c = await inspectContent(abs, this.config.scan.maxFileBytes);
        if (c.kind === 'ok') result.set(p, { state: 'eligible', hash: c.hash, size: c.size });
        else if (c.kind === 'missing') result.set(p, { state: 'missing' });
        else if (c.kind === 'ineligible') result.set(p, { state: 'ineligible', reason: c.reason });
        else result.set(p, { state: 'unavailable', reason: c.code });
      },
      signal
    );
    return result;
  }

  async observeOne(p: string, signal?: AbortSignal): Promise<Observation> {
    return (await this.observe([p], undefined, signal)).get(p)!;
  }

  /** True when any ancestor directory below the root contains a `.git` entry (nested repo / submodule). */
  private async insideNestedRepo(relPath: string): Promise<boolean> {
    const parts = relPath.split('/');
    let current = this.root;
    for (let i = 0; i < parts.length - 1; i++) {
      current = path.join(current, parts[i]!);
      try {
        await lstat(path.join(current, '.git'));
        return true;
      } catch {
        // absent: keep walking
      }
    }
    return false;
  }
}

/** Paths reported by Git/readdir must already be canonical relative paths. */
function isSafeRelative(p: string): boolean {
  try {
    return normalizeRelativePath(p) === p;
  } catch {
    return false;
  }
}
