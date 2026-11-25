/** Bundled defaults and fixed operational limits (spec §5, §17.1). */

export interface EmbeddingProfile {
  model: string;
  revision: string;
  dtype: string;
  dimensions: number;
  pooling: 'mean';
  normalize: true;
  inputVersion: 1;
}

/**
 * The only supported embedding profile for v0.1.
 * `revision` is the immutable Hugging Face commit of Xenova/all-MiniLM-L6-v2 verified
 * with @huggingface/transformers 4.3.2; dtype q8 loads `onnx/model_quantized.onnx`.
 */
export const DEFAULT_EMBEDDING_PROFILE: Readonly<EmbeddingProfile> = Object.freeze({
  model: 'Xenova/all-MiniLM-L6-v2',
  revision: '751bff37182d3f1213fa05d7196b954e230abad9',
  dtype: 'q8',
  dimensions: 384,
  pooling: 'mean',
  normalize: true,
  inputVersion: 1
});

export const LIMITS = Object.freeze({
  indexBatchMax: 50,
  inferenceSubBatch: 16,
  listPageDefault: 100,
  listPageMax: 200,
  searchDefaultLimit: 10,
  searchMaxLimit: 50,
  maxFileBytesDefault: 1024 * 1024,
  maxFileBytesMax: 16 * 1024 * 1024,
  fileConcurrency: 8,
  descriptionMaxCodePoints: 1200,
  queryMaxCodePoints: 1000,
  maxModelTokens: 256,
  sampleMax: 50,
  warningsMax: 50,
  cliBatchInputMaxBytes: 1024 * 1024,
  busyTimeoutMs: 5000
});

export const INDEX_DIR_NAME = '.semantic-index';
export const DB_FILE_NAME = 'index.db';
export const CONFIG_FILE_NAME = '.semantic-index.json';
export const SCHEMA_VERSION = 1;
export const GITIGNORE_RULE = '/.semantic-index/';
export const SERVER_NAME = 'semantic-code-index';

export interface ScanConfig {
  maxFileBytes: number;
  include: string[];
  exclude: string[];
  includeHidden: boolean;
}

export interface SearchConfig {
  defaultLimit: number;
  maxLimit: number;
  includeStaleByDefault: boolean;
}

export interface ResolvedConfig {
  configVersion: 1;
  embedding: EmbeddingProfileConfig;
  scan: ScanConfig;
  search: SearchConfig;
}

/** The `embedding` block as written to `.semantic-index.json` (no inputVersion). */
export interface EmbeddingProfileConfig {
  model: string;
  revision: string;
  dtype: string;
  dimensions: number;
  pooling: 'mean';
  normalize: boolean;
}

export function defaultConfig(): ResolvedConfig {
  const { model, revision, dtype, dimensions, pooling, normalize } = DEFAULT_EMBEDDING_PROFILE;
  return {
    configVersion: 1,
    embedding: { model, revision, dtype, dimensions, pooling, normalize },
    scan: { maxFileBytes: LIMITS.maxFileBytesDefault, include: [], exclude: [], includeHidden: false },
    search: { defaultLimit: LIMITS.searchDefaultLimit, maxLimit: LIMITS.searchMaxLimit, includeStaleByDefault: false }
  };
}

/** Canonical JSON (sorted keys) of a profile, used for the persisted compatibility contract. */
export function canonicalProfileJson(profile: EmbeddingProfile): string {
  const ordered: Record<string, unknown> = {};
  for (const key of Object.keys(profile).sort()) ordered[key] = profile[key as keyof EmbeddingProfile];
  return JSON.stringify(ordered);
}
