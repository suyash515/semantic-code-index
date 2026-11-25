import { z } from 'zod';
import { LIMITS } from './defaults.js';

const pattern = z
  .string()
  .min(1, 'pattern must be nonempty')
  .max(512)
  .refine((p) => !p.startsWith('!'), 'negated patterns are not supported in v0.1')
  .refine((p) => !/[\u0000-\u001f]/.test(p), 'pattern contains control characters')
  .refine((p) => !p.includes('\\'), 'use forward slashes in patterns')
  .refine((p) => !p.split('/').includes('..'), "patterns must not contain '..'");

export const embeddingConfigSchema = z
  .object({
    model: z.string(),
    revision: z.string(),
    dtype: z.string(),
    dimensions: z.number().int(),
    pooling: z.literal('mean'),
    normalize: z.boolean()
  })
  .strict();

export const scanConfigSchema = z
  .object({
    maxFileBytes: z.number().int().positive().max(LIMITS.maxFileBytesMax).optional(),
    include: z.array(pattern).max(1000).optional(),
    exclude: z.array(pattern).max(1000).optional(),
    includeHidden: z.boolean().optional()
  })
  .strict();

export const searchConfigSchema = z
  .object({
    defaultLimit: z.number().int().min(1).max(LIMITS.searchMaxLimit).optional(),
    maxLimit: z.number().int().min(1).max(LIMITS.searchMaxLimit).optional(),
    includeStaleByDefault: z.boolean().optional()
  })
  .strict();

export const configFileSchema = z
  .object({
    configVersion: z.literal(1),
    embedding: embeddingConfigSchema.optional(),
    scan: scanConfigSchema.optional(),
    search: searchConfigSchema.optional()
  })
  .strict();

export type ConfigFile = z.infer<typeof configFileSchema>;
