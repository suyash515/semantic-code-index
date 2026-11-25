/**
 * Path-level scan policy (spec §6.1, §6.2): hard exclusions, hidden files,
 * custom include/exclude and (filesystem mode) root .gitignore.
 */
import ignore, { type Ignore } from 'ignore';
import type { ScanConfig } from '../config/defaults.js';
import { CONFIG_FILE_NAME, INDEX_DIR_NAME } from '../config/defaults.js';

/** Directory components that are always excluded (v0.1 hard exclusions). */
export const HARD_EXCLUDED_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.hg',
  '.svn',
  '.bzr',
  '_darcs',
  'CVS',
  '.jj',
  '.sl',
  INDEX_DIR_NAME,
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.cache',
  'vendor',
  '__pycache__',
  '.venv'
]);

/** Exact file names that are always excluded (credentials, private keys, package metadata). */
const HARD_EXCLUDED_NAMES: ReadonlySet<string> = new Set([
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '_netrc',
  '.git-credentials',
  '.htpasswd',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  CONFIG_FILE_NAME,
  '.DS_Store',
  'Thumbs.db'
]);

/** Extensions for secrets and binary/archive/media/database formats (lowercase, without dot). */
const HARD_EXCLUDED_EXTENSIONS: ReadonlySet<string> = new Set([
  // keys / certificates / keystores
  'pem', 'key', 'p12', 'pfx', 'jks', 'keystore', 'kdbx', 'gpg', 'asc',
  // images
  'png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'icns', 'webp', 'tif', 'tiff', 'psd', 'avif', 'heic',
  // archives / packages
  'zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', '7z', 'rar', 'jar', 'war', 'ear', 'whl', 'nupkg', 'deb', 'rpm', 'dmg', 'iso', 'apk', 'ipa',
  // databases
  'db', 'sqlite', 'sqlite3', 'db3', 'mdb', 'accdb', 'db-wal', 'db-shm', 'db-journal', 'sqlite-wal', 'sqlite-shm',
  // binaries / objects / bytecode
  'exe', 'dll', 'so', 'dylib', 'a', 'lib', 'o', 'obj', 'class', 'pyc', 'pyo', 'wasm', 'bin', 'node',
  // documents / media / fonts / models
  'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'mp3', 'mp4', 'wav', 'ogg', 'flac', 'avi', 'mov', 'mkv', 'webm',
  'ttf', 'otf', 'woff', 'woff2', 'eot', 'onnx', 'pt', 'safetensors', 'npy', 'npz', 'parquet'
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** True when a path is hard-excluded. Cannot be overridden by any configuration. */
export function isHardExcluded(relPath: string): boolean {
  const parts = relPath.split('/');
  const name = parts[parts.length - 1]!;
  for (let i = 0; i < parts.length - 1; i++) if (HARD_EXCLUDED_DIRS.has(parts[i]!)) return true;
  if (name === '.git' || name === INDEX_DIR_NAME) return true;
  if (HARD_EXCLUDED_NAMES.has(name)) return true;
  if (name.startsWith('.env.')) return true;
  if (/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/.test(name)) return true;
  if (parts.length >= 2 && parts[parts.length - 2] === '.aws' && (name === 'credentials' || name === 'config')) return true;
  if (parts.length >= 2 && parts[parts.length - 2] === '.docker' && name === 'config.json') return true;
  if (HARD_EXCLUDED_EXTENSIONS.has(extensionOf(name))) return true;
  return false;
}

export function isHardExcludedDir(name: string): boolean {
  return HARD_EXCLUDED_DIRS.has(name);
}

function isHidden(relPath: string): boolean {
  return relPath.split('/').some((seg) => seg.startsWith('.'));
}

/** Path-level policy evaluated without touching file contents. */
export class PathPolicy {
  private readonly include: Ignore | null;
  private readonly exclude: Ignore;
  private readonly rootGitignore: Ignore | null;

  constructor(
    readonly scan: ScanConfig,
    rootGitignoreText: string | null = null
  ) {
    this.include = scan.include.length > 0 ? ignore().add(scan.include) : null;
    this.exclude = ignore().add(scan.exclude);
    this.rootGitignore = rootGitignoreText === null ? null : ignore().add(rootGitignoreText);
  }

  /** Whether a file path passes hard exclusions, hidden rules and custom patterns (and root .gitignore when set). */
  allowsFile(relPath: string): boolean {
    if (isHardExcluded(relPath)) return false;
    if (!this.scan.includeHidden && isHidden(relPath)) return false;
    if (this.exclude.ignores(relPath)) return false;
    if (this.rootGitignore && this.rootGitignore.ignores(relPath)) return false;
    if (this.include && !this.include.ignores(relPath)) return false;
    return true;
  }

  /** Whether a directory may contain eligible files (used for early pruning). */
  allowsDirectory(relDir: string): boolean {
    const parts = relDir.split('/');
    if (parts.some((p) => HARD_EXCLUDED_DIRS.has(p))) return false;
    if (!this.scan.includeHidden && parts.some((p) => p.startsWith('.'))) return false;
    if (this.exclude.ignores(`${relDir}/`)) return false;
    if (this.rootGitignore && this.rootGitignore.ignores(`${relDir}/`)) return false;
    return true;
  }
}
