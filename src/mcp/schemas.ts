/** Zod contracts for the MCP tools (spec §12). Strict objects; snake_case public JSON. */
import { z } from 'zod';
import { ERROR_CODES } from '../errors.js';
import { LIMITS } from '../config/defaults.js';

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hexadecimal characters');
const relPath = z.string().min(1).max(4096).describe('Project-relative path using "/" separators');
const prefix = z.string().max(4096).describe('Optional project-relative directory scope; matches whole path components');

export const errorPayloadSchema = z.strictObject({
  code: z.enum(ERROR_CODES),
  message: z.string(),
  retryable: z.boolean(),
  details: z.record(z.string(), z.unknown()).optional()
});

export const indexFileInputSchema = z.strictObject({
  path: relPath,
  description: z.string().min(1).max(8192).describe('30–100 word description written after reading the file (max 1,200 characters / 256 model tokens)'),
  expected_hash: sha256.describe('current_hash from list_unindexed_files / list_stale_files / get_file')
});

export const indexFileResultSchema = z.strictObject({
  path: z.string(),
  status: z.enum(['created', 'updated', 'unchanged', 'failed']),
  content_hash: sha256.optional(),
  error: errorPayloadSchema.optional()
});

export const indexFilesInputSchema = z.strictObject({
  files: z.array(indexFileInputSchema).min(1).max(LIMITS.indexBatchMax)
});

export const indexFilesResultSchema = z.strictObject({
  total: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  failed: z.number().int(),
  results: z.array(indexFileResultSchema)
});

export const searchInputSchema = z.strictObject({
  query: z.string().min(1).max(8192).describe('Natural-language description of the responsibility you are looking for (max 1,000 characters)'),
  limit: z.number().int().min(1).max(LIMITS.searchMaxLimit).optional(),
  min_score: z.number().min(-1).max(1).optional().describe('Cosine-similarity threshold, not a confidence'),
  path_prefix: prefix.optional(),
  include_stale: z.boolean().optional()
});

const searchItemSchema = z.strictObject({
  path: z.string(),
  description: z.string(),
  score: z.number(),
  state: z.enum(['indexed', 'stale']),
  content_hash: sha256,
  current_hash: sha256,
  language: z.string().nullable(),
  updated_at: z.string()
});

export const searchResultSchema = z.strictObject({
  query: z.string(),
  results: z.array(searchItemSchema),
  skipped: z.strictObject({ stale: z.number().int(), missing: z.number().int(), ineligible: z.number().int(), unavailable: z.number().int() }),
  embedding_model: z.string(),
  warnings: z.array(z.string())
});

export const pathInputSchema = z.strictObject({ path: relPath });

const recordSchema = z.strictObject({
  path: z.string(),
  description: z.string(),
  content_hash: sha256,
  observed_hash: sha256.nullable(),
  size_bytes: z.number().int(),
  language: z.string().nullable(),
  indexed_at: z.string(),
  updated_at: z.string(),
  state: z.enum(['indexed', 'stale'])
});

export const getFileResultSchema = z.strictObject({
  path: z.string(),
  state: z.enum(['unindexed', 'indexed', 'stale', 'missing', 'ineligible', 'unavailable']),
  current_hash: sha256.nullable(),
  current_size_bytes: z.number().int().nullable(),
  record: recordSchema.nullable()
});

export const removeFileResultSchema = z.strictObject({ path: z.string(), removed: z.boolean() });

export const listInputSchema = z.strictObject({
  path_prefix: prefix.optional(),
  cursor: z.string().max(8192).optional().describe('Opaque next_cursor from a previous page'),
  limit: z.number().int().min(1).max(LIMITS.listPageMax).optional()
});

const fileSummaryShape = {
  path: z.string(),
  size_bytes: z.number().int(),
  current_hash: sha256,
  language: z.string().nullable()
};

export const unindexedPageSchema = z.strictObject({
  files: z.array(z.strictObject({ ...fileSummaryShape, state: z.literal('unindexed') })),
  next_cursor: z.string().nullable(),
  scan_mode: z.enum(['git', 'filesystem']),
  warnings: z.array(z.string())
});

export const stalePageSchema = z.strictObject({
  files: z.array(
    z.strictObject({ ...fileSummaryShape, state: z.literal('stale'), content_hash: sha256, description: z.string(), updated_at: z.string() })
  ),
  next_cursor: z.string().nullable(),
  scan_mode: z.enum(['git', 'filesystem']),
  warnings: z.array(z.string())
});

export const statusInputSchema = z.strictObject({ path_prefix: prefix.optional() });

export const statusResultSchema = z.strictObject({
  eligible: z.number().int(),
  fresh: z.number().int(),
  stale: z.number().int(),
  unindexed: z.number().int(),
  missing: z.number().int(),
  ineligible: z.number().int(),
  unavailable: z.number().int(),
  coverage: z.number().nullable(),
  complete: z.boolean(),
  scan_mode: z.enum(['git', 'filesystem']),
  embedding_model: z.string(),
  model_compatible: z.boolean(),
  schema_version: z.number().int(),
  warnings: z.array(z.string())
});

export const reconcileInputSchema = z.strictObject({ path_prefix: prefix.optional(), dry_run: z.boolean().optional() });

const sampleSchema = z.strictObject({ paths: z.array(z.string()), omitted_count: z.number().int() });

export const reconcileResultSchema = z.strictObject({
  dry_run: z.boolean(),
  complete: z.boolean(),
  scan_mode: z.enum(['git', 'filesystem']),
  unindexed: z.number().int(),
  marked_stale: z.number().int(),
  restored_fresh: z.number().int(),
  removed_missing: z.number().int(),
  removed_ineligible: z.number().int(),
  unchanged: z.number().int(),
  unavailable: z.number().int(),
  conflicts: z.number().int(),
  samples: z.strictObject({
    unindexed: sampleSchema,
    marked_stale: sampleSchema,
    restored_fresh: sampleSchema,
    removed_missing: sampleSchema,
    removed_ineligible: sampleSchema,
    unavailable: sampleSchema,
    conflicts: sampleSchema
  }),
  warnings: z.array(z.string())
});
