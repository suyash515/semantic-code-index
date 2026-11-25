/**
 * Public library entry. Importing this module has no side effects: it does not create a
 * database, start a process, load the model or scan the filesystem.
 */
export { openSemanticIndex, downloadModelAssets, SemanticIndex } from './service/semantic-index.js';
export type { OpenOptions, CallOptions } from './service/semantic-index.js';
export { initializeProject } from './config/init.js';
export { SemanticIndexError, ERROR_CODES } from './errors.js';
export type { ErrorCode, ErrorPayload } from './errors.js';
export type { Logger } from './logger.js';
export type { EmbeddingProvider, EmbeddingProfile } from './embeddings/provider.js';
export { DEFAULT_EMBEDDING_PROFILE, LIMITS } from './config/defaults.js';
export type * from './types.js';
