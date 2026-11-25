import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { SemanticIndexError } from '../errors.js';
import { CONFIG_FILE_NAME, DEFAULT_EMBEDDING_PROFILE, defaultConfig, type ResolvedConfig } from './defaults.js';
import { configFileSchema } from './schema.js';

/** Parse and validate config text; throws CONFIG_INVALID with a readable message. */
export function parseConfig(text: string): ResolvedConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SemanticIndexError('CONFIG_INVALID', `${CONFIG_FILE_NAME} is not valid JSON.`);
  }
  if (raw && typeof raw === 'object' && 'configVersion' in raw && (raw as { configVersion: unknown }).configVersion !== 1) {
    throw new SemanticIndexError('CONFIG_INVALID', `Unsupported configVersion in ${CONFIG_FILE_NAME}; only 1 is supported.`);
  }
  const parsed = configFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 10)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
    throw new SemanticIndexError('CONFIG_INVALID', `Invalid ${CONFIG_FILE_NAME}: ${issues.join('; ')}`, {
      details: { issues }
    });
  }
  const file = parsed.data;
  const config = defaultConfig();

  if (file.embedding) {
    const e = file.embedding;
    const d = DEFAULT_EMBEDDING_PROFILE;
    const same =
      e.model === d.model &&
      e.revision === d.revision &&
      e.dtype === d.dtype &&
      e.dimensions === d.dimensions &&
      e.pooling === d.pooling &&
      e.normalize === d.normalize;
    if (!same) {
      throw new SemanticIndexError(
        'CONFIG_INVALID',
        `Unsupported embedding profile in ${CONFIG_FILE_NAME}. v0.1 supports only ${d.model}@${d.revision} (${d.dtype}, ${d.dimensions} dimensions, mean pooling, normalized).`,
        { details: { supported_model: d.model, supported_revision: d.revision } }
      );
    }
  }
  if (file.scan) {
    config.scan = {
      maxFileBytes: file.scan.maxFileBytes ?? config.scan.maxFileBytes,
      include: file.scan.include ?? [],
      exclude: file.scan.exclude ?? [],
      includeHidden: file.scan.includeHidden ?? false
    };
  }
  if (file.search) {
    config.search = {
      defaultLimit: file.search.defaultLimit ?? config.search.defaultLimit,
      maxLimit: file.search.maxLimit ?? config.search.maxLimit,
      includeStaleByDefault: file.search.includeStaleByDefault ?? false
    };
  }
  if (config.search.defaultLimit > config.search.maxLimit) {
    throw new SemanticIndexError('CONFIG_INVALID', 'search.defaultLimit must not exceed search.maxLimit.');
  }
  return config;
}

/** Load `.semantic-index.json` from the root; a missing file yields defaults. */
export async function loadConfig(root: string): Promise<ResolvedConfig> {
  const file = path.join(root, CONFIG_FILE_NAME);
  let text: string;
  try {
    const st = await lstat(file);
    if (!st.isFile()) throw new SemanticIndexError('CONFIG_INVALID', `${CONFIG_FILE_NAME} must be a regular file (symlinks are rejected).`);
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return defaultConfig();
    if (err instanceof SemanticIndexError) throw err;
    throw new SemanticIndexError('CONFIG_INVALID', `Cannot read ${CONFIG_FILE_NAME}.`, { cause: err });
  }
  return parseConfig(text);
}

/** Serialized default configuration written by `init`. */
export function defaultConfigText(): string {
  return `${JSON.stringify(defaultConfig(), null, 2)}\n`;
}
