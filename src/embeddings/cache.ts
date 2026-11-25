/** Per-user model cache location (spec §8.2). Never inside the project. */
import os from 'node:os';
import path from 'node:path';
import { SemanticIndexError } from '../errors.js';
import { isContained } from '../project/paths.js';

const APP = 'semantic-code-index';

export function defaultCacheDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  const home = os.homedir();
  if (platform === 'win32') {
    const base = env.LOCALAPPDATA && path.win32.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.win32.join(home, 'AppData', 'Local');
    return path.win32.join(base, APP, 'Cache', 'models');
  }
  if (platform === 'darwin') return path.posix.join(home, 'Library', 'Caches', APP, 'models');
  const xdg = env.XDG_CACHE_HOME && path.posix.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.posix.join(home, '.cache');
  return path.posix.join(xdg, APP, 'models');
}

/** Resolve the cache directory from SEMANTIC_INDEX_CACHE_DIR or the OS default; reject paths inside the project. */
export function resolveCacheDir(projectRoot: string | null, env: NodeJS.ProcessEnv = process.env): { dir: string; configured: boolean } {
  const override = env.SEMANTIC_INDEX_CACHE_DIR;
  let dir: string;
  let configured = false;
  if (override !== undefined && override !== '') {
    if (!path.isAbsolute(override)) {
      throw new SemanticIndexError('CONFIG_INVALID', 'SEMANTIC_INDEX_CACHE_DIR must be an absolute path.');
    }
    dir = path.resolve(override);
    configured = true;
  } else {
    dir = defaultCacheDir();
  }
  if (projectRoot && isContained(projectRoot, dir)) {
    throw new SemanticIndexError('CONFIG_INVALID', 'The model cache must be outside the project directory; set SEMANTIC_INDEX_CACHE_DIR to a location outside the project.');
  }
  return { dir, configured };
}

export function isOfflineMode(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.SEMANTIC_INDEX_OFFLINE;
  return v === '1' || v === 'true';
}
