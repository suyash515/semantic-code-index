/**
 * The core service. CLI, MCP and library are thin adapters over this class.
 */
import { SemanticIndexError, asSemanticIndexError } from '../errors.js';
import { DEFAULT_EMBEDDING_PROFILE } from '../config/defaults.js';
import { loadConfig } from '../config/load.js';
import { silentLogger, type Logger } from '../logger.js';
import { resolveRoot } from '../project/paths.js';
import { Project } from '../project/scanner.js';
import { openDatabase, type Db } from '../storage/connection.js';
import { verifySchema } from '../storage/schema.js';
import { Repository } from '../storage/repository.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { TransformersEmbeddingProvider } from '../embeddings/transformers-provider.js';
import { isOfflineMode, resolveCacheDir } from '../embeddings/cache.js';
import type {
  DownloadModelResult,
  FileSummary,
  GetFileRequest,
  GetFileResult,
  IndexFileInput,
  IndexFileResult,
  IndexFilesRequest,
  IndexFilesResult,
  IndexStatus,
  ListRequest,
  Page,
  ReconcileRequest,
  ReconcileResult,
  ReembedResult,
  RemoveFileRequest,
  RemoveFileResult,
  ResetRequest,
  ResetResult,
  SearchRequest,
  SearchResult,
  StaleFileSummary,
  StatusRequest
} from '../types.js';
import type { ServiceContext } from './context.js';
import { indexFiles } from './indexing.js';
import { searchFiles } from './search.js';
import { getFile, removeFile } from './files.js';
import { getIndexStatus, listStaleFiles, listUnindexedFiles } from './status.js';
import { reconcileIndex } from './reconcile.js';
import { downloadModel, reembed, reset } from './maintenance.js';

export interface OpenOptions {
  /** Project root; defaults to process.cwd(). Resolved once to a real directory. */
  root?: string;
  /** Inject an embedding provider (tests). Defaults to the local Transformers.js provider. */
  embeddingProvider?: EmbeddingProvider;
  /** Library logging is silent by default. */
  logger?: Logger;
}

export interface CallOptions {
  /** Cancellation: stops scheduling new work; already committed items are not rolled back. */
  signal?: AbortSignal;
}

function createDefaultProvider(root: string | null, logger: Logger): { provider: EmbeddingProvider; configured: boolean } {
  const { dir, configured } = resolveCacheDir(root);
  return { provider: new TransformersEmbeddingProvider({ cacheDir: dir, offline: isOfflineMode(), logger }), configured };
}

export class SemanticIndex {
  private closed = false;
  private ownedProvider: EmbeddingProvider | null = null;
  private cacheConfigured = false;
  private readonly ctx: ServiceContext;

  /** @internal Use openSemanticIndex(). */
  constructor(
    readonly root: string,
    private readonly db: Db,
    ctx: Omit<ServiceContext, 'provider'>,
    private readonly injected: EmbeddingProvider | undefined
  ) {
    this.ctx = { ...ctx, provider: () => this.provider() };
  }

  private provider(): EmbeddingProvider {
    if (this.injected) return this.injected;
    if (!this.ownedProvider) {
      const { provider, configured } = createDefaultProvider(this.root, this.ctx.logger);
      this.ownedProvider = provider;
      this.cacheConfigured = configured;
    }
    return this.ownedProvider;
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) throw new SemanticIndexError('INTERNAL_ERROR', 'This SemanticIndex instance is closed.', { retryable: false });
    try {
      return await fn();
    } catch (err) {
      throw asSemanticIndexError(err);
    }
  }

  indexFile(input: IndexFileInput, options: CallOptions = {}): Promise<IndexFileResult> {
    return this.run(async () => (await indexFiles(this.ctx, [input], options.signal)).results[0]!);
  }

  indexFiles(request: IndexFilesRequest, options: CallOptions = {}): Promise<IndexFilesResult> {
    return this.run(() => {
      if (!request || typeof request !== 'object') throw new SemanticIndexError('INVALID_INPUT', 'Request must be an object with `files`.');
      return indexFiles(this.ctx, request.files, options.signal);
    });
  }

  searchFiles(request: SearchRequest, options: CallOptions = {}): Promise<SearchResult> {
    return this.run(() => searchFiles(this.ctx, request, options.signal));
  }

  getFile(request: GetFileRequest, options: CallOptions = {}): Promise<GetFileResult> {
    return this.run(() => getFile(this.ctx, request, options.signal));
  }

  removeFile(request: RemoveFileRequest): Promise<RemoveFileResult> {
    return this.run(() => removeFile(this.ctx, request));
  }

  listUnindexedFiles(request: ListRequest = {}, options: CallOptions = {}): Promise<Page<FileSummary>> {
    return this.run(() => listUnindexedFiles(this.ctx, request, options.signal));
  }

  listStaleFiles(request: ListRequest = {}, options: CallOptions = {}): Promise<Page<StaleFileSummary>> {
    return this.run(() => listStaleFiles(this.ctx, request, options.signal));
  }

  getIndexStatus(request: StatusRequest = {}, options: CallOptions = {}): Promise<IndexStatus> {
    return this.run(() => getIndexStatus(this.ctx, request, options.signal));
  }

  reconcileIndex(request: ReconcileRequest = {}, options: CallOptions = {}): Promise<ReconcileResult> {
    return this.run(() => reconcileIndex(this.ctx, request, options.signal));
  }

  downloadModel(): Promise<DownloadModelResult> {
    return this.run(() => downloadModel(this.ctx, this.cacheConfiguredFor()));
  }

  reembed(options: CallOptions = {}): Promise<ReembedResult> {
    return this.run(() => reembed(this.ctx, options.signal));
  }

  /** Remove all records. Requires `{ confirm: true }`. */
  reset(request: ResetRequest): Promise<ResetResult> {
    return this.run(() => reset(this.ctx, request));
  }

  private cacheConfiguredFor(): boolean {
    this.provider();
    return this.cacheConfigured;
  }

  /** Release the database and model. Safe to call repeatedly. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      await this.ownedProvider?.close();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** Open an initialized project. Never creates an index; returns NOT_INITIALIZED instead. */
export async function openSemanticIndex(options: OpenOptions = {}): Promise<SemanticIndex> {
  try {
    const root = await resolveRoot(options.root);
    const config = await loadConfig(root);
    const db = await openDatabase(root, { create: false });
    try {
      verifySchema(db);
    } catch (err) {
      db.close();
      throw err;
    }
    const logger = options.logger ?? silentLogger;
    const expectedProfile = options.embeddingProvider?.profile ?? DEFAULT_EMBEDDING_PROFILE;
    return new SemanticIndex(
      root,
      db,
      { root, config, repo: new Repository(db), project: new Project(root, config), logger, expectedProfile },
      options.embeddingProvider
    );
  } catch (err) {
    throw asSemanticIndexError(err);
  }
}

/** Download and smoke-test the model without opening a project index. */
export async function downloadModelAssets(options: { root?: string; logger?: Logger } = {}): Promise<DownloadModelResult> {
  try {
    const root = options.root === undefined ? null : await resolveRoot(options.root);
    const { provider, configured } = createDefaultProvider(root ?? process.cwd(), options.logger ?? silentLogger);
    try {
      await provider.download();
    } finally {
      await provider.close();
    }
    const p = provider.profile;
    return { embedding_model: p.model, revision: p.revision, dtype: p.dtype, dimensions: p.dimensions, cache_dir_configured: configured };
  } catch (err) {
    throw asSemanticIndexError(err);
  }
}
