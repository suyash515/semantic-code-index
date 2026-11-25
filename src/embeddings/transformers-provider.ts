/**
 * Local CPU embedding with Transformers.js + ONNX Runtime (spec §8).
 *
 * The high-level `pipeline()` helper of @huggingface/transformers 4.3.2 resolves its file
 * list from `config.json` / `tokenizer_config.json` at the floating `main` revision, ignoring
 * the pinned revision and `local_files_only`. To keep the model revision immutable and
 * offline mode network-free, this provider loads the tokenizer and model directly with the
 * pinned revision, performs mean pooling and L2 normalization itself, and installs a scoped
 * fetch shim that (a) serves already-cached files of the pinned revision locally, (b) rewrites
 * any request for this model to the pinned revision, and (c) refuses every other request,
 * and all requests in offline mode.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { SemanticIndexError } from '../errors.js';
import { DEFAULT_EMBEDDING_PROFILE, LIMITS, type EmbeddingProfile } from '../config/defaults.js';
import { silentLogger, type Logger } from '../logger.js';
import { SerialQueue } from '../util/concurrency.js';
import { validateAndNormalize } from '../storage/vector-codec.js';
import { tokenLimitError, type EmbeddingProvider } from './provider.js';

type TransformersModule = typeof import('@huggingface/transformers');

interface LoadedModel {
  tokenizer: (texts: string | string[], options: Record<string, unknown>) => Record<string, { data: ArrayLike<number | bigint>; dims: number[] }>;
  model: ((inputs: Record<string, unknown>) => Promise<Record<string, { data: Float32Array; dims: number[] }>>) & { dispose?: () => Promise<unknown> };
}

export interface TransformersProviderOptions {
  cacheDir: string;
  offline?: boolean;
  logger?: Logger;
}

const HF_HOST = 'https://huggingface.co/';

/** Process-wide fetch policy consulted by the shim (Transformers.js `env` is global). */
let fetchPolicy: { cacheDir: string; offline: boolean; profile: EmbeddingProfile } | null = null;
let shimInstalled = false;

function cachedFilePath(cacheDir: string, profile: EmbeddingProfile, file: string): string | null {
  const safe = file.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
  if (!safe) return null;
  return path.join(cacheDir, ...profile.model.split('/'), profile.revision, ...file.split('/'));
}

function installFetchShim(tf: TransformersModule): void {
  if (shimInstalled) return;
  shimInstalled = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  tf.env.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const policy = fetchPolicy;
    if (!policy) throw new Error('Model downloads are not enabled.');
    const prefix = `${HF_HOST}${policy.profile.model}/resolve/`;
    if (!url.startsWith(prefix)) throw new Error('Blocked network request outside the pinned model repository.');
    const rest = url.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash <= 0) throw new Error('Blocked malformed model request.');
    const file = decodeURIComponent(rest.slice(slash + 1).split('?')[0]!);
    const local = cachedFilePath(policy.cacheDir, policy.profile, file);
    if (local && existsSync(local)) {
      const body = await readFile(local);
      return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
    }
    if (policy.offline) throw new Error('Offline mode: model asset is not cached.');
    const pinned = `${prefix}${encodeURIComponent(policy.profile.revision)}/${rest.slice(slash + 1)}`;
    return realFetch(pinned, init);
  }) as typeof fetch;
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly profile: EmbeddingProfile = DEFAULT_EMBEDDING_PROFILE;
  readonly maxTokens = LIMITS.maxModelTokens;
  private loading: Promise<LoadedModel> | null = null;
  private readonly queue = new SerialQueue();
  private readonly logger: Logger;
  private closed = false;

  constructor(private readonly options: TransformersProviderOptions) {
    this.logger = options.logger ?? silentLogger;
  }

  private async load(allowDownload: boolean): Promise<LoadedModel> {
    if (this.closed) throw new SemanticIndexError('INTERNAL_ERROR', 'Embedding provider is closed.');
    // Cache one initialization promise per process; clear it on failure so a later call can retry.
    this.loading ??= this.doLoad(allowDownload).catch((err) => {
      this.loading = null;
      throw err;
    });
    return this.loading;
  }

  private async doLoad(allowDownload: boolean): Promise<LoadedModel> {
    const offline = Boolean(this.options.offline) || !allowDownload;
    const { cacheDir } = this.options;
    let tf: TransformersModule;
    try {
      tf = await import('@huggingface/transformers');
    } catch (err) {
      throw new SemanticIndexError('MODEL_NOT_AVAILABLE', 'The embedding runtime (@huggingface/transformers / onnxruntime-node) could not be loaded on this platform.', { cause: err, retryable: false });
    }
    tf.env.logLevel = tf.LogLevel.NONE;
    tf.env.allowLocalModels = false;
    tf.env.allowRemoteModels = true;
    tf.env.useFSCache = true;
    tf.env.cacheDir = cacheDir;
    const onnxEnv = tf.env.backends.onnx as { logLevel?: string };
    onnxEnv.logLevel = 'error';
    fetchPolicy = { cacheDir, offline, profile: this.profile };
    installFetchShim(tf);
    if (!offline) await mkdir(cacheDir, { recursive: true, mode: 0o700 }).catch(() => undefined);

    // Offline mode is enforced by the fetch shim (cached files only, never the network);
    // Transformers.js rejects local_files_only while local model paths are disabled.
    const common = { revision: this.profile.revision, cache_dir: cacheDir };
    try {
      this.logger.info(`Loading embedding model ${this.profile.model}@${this.profile.revision.slice(0, 12)} (${this.profile.dtype}).`);
      const tokenizer = await tf.AutoTokenizer.from_pretrained(this.profile.model, common);
      const model = await tf.AutoModel.from_pretrained(this.profile.model, {
        ...common,
        dtype: this.profile.dtype as 'q8',
        device: 'cpu',
        session_options: { logSeverityLevel: 3 }
      });
      return { tokenizer: tokenizer as unknown as LoadedModel['tokenizer'], model: model as unknown as LoadedModel['model'] };
    } catch (err) {
      const hint = offline
        ? 'Model assets are not available in the local cache. Run `semantic-code-index model download` while online (without SEMANTIC_INDEX_OFFLINE=1).'
        : 'Model assets could not be downloaded or loaded. Check network access and retry, or run `semantic-code-index model download`.';
      throw new SemanticIndexError('MODEL_NOT_AVAILABLE', hint, { cause: err, retryable: !offline });
    }
  }

  async countTokens(texts: readonly string[]): Promise<number[]> {
    const { tokenizer } = await this.load(!this.options.offline);
    return texts.map((t) => {
      const enc = tokenizer(t, { add_special_tokens: true, padding: false, truncation: false });
      const dims = enc.input_ids!.dims;
      return dims[dims.length - 1]!;
    });
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const loaded = await this.load(!this.options.offline);
    const counts = await this.countTokens(texts);
    counts.forEach((c) => {
      if (c > this.maxTokens) throw tokenLimitError('description', c, this.maxTokens);
    });
    // Scheduling unit is a sub-batch of 16, but each text is run without padding: with q8
    // dynamic quantization, padded batches change vectors measurably (cosine ~0.993), which
    // would make document vectors inconsistent with single-text query vectors.
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += LIMITS.inferenceSubBatch) {
      const batch = texts.slice(i, i + LIMITS.inferenceSubBatch);
      const vectors = await this.queue.run(async () => {
        const res: Float32Array[] = [];
        for (const text of batch) res.push(...(await this.infer(loaded, [text])));
        return res;
      });
      out.push(...vectors);
    }
    return out;
  }

  private async infer({ tokenizer, model }: LoadedModel, batch: readonly string[]): Promise<Float32Array[]> {
    let hidden: { data: Float32Array; dims: number[] };
    let mask: ArrayLike<number | bigint>;
    try {
      const inputs = tokenizer([...batch], { add_special_tokens: true, padding: batch.length > 1, truncation: false });
      mask = inputs.attention_mask!.data;
      const output = await model(inputs);
      hidden = output.last_hidden_state!;
    } catch (err) {
      throw new SemanticIndexError('EMBEDDING_FAILED', 'Local model inference failed.', { cause: err, retryable: true });
    }
    const [n, seq, dim] = hidden.dims as [number, number, number];
    if (n !== batch.length || dim !== this.profile.dimensions) {
      throw new SemanticIndexError('EMBEDDING_FAILED', 'Model returned an unexpected output shape.');
    }
    const vectors: Float32Array[] = [];
    for (let b = 0; b < n; b++) {
      const sum = new Float64Array(dim);
      let count = 0;
      for (let t = 0; t < seq; t++) {
        if (Number(mask[b * seq + t]) !== 1) continue;
        count++;
        const base = (b * seq + t) * dim;
        for (let d = 0; d < dim; d++) sum[d]! += hidden.data[base + d]!;
      }
      if (count === 0) throw new SemanticIndexError('EMBEDDING_FAILED', 'Model input produced no tokens.');
      for (let d = 0; d < dim; d++) sum[d] = sum[d]! / count;
      vectors.push(validateAndNormalize(sum, this.profile.dimensions));
    }
    return vectors;
  }

  async download(): Promise<void> {
    if (this.options.offline) {
      // Offline: only verify that cached assets load and run.
      const v = await this.embed(['semantic code index smoke test']);
      if (v.length !== 1) throw new SemanticIndexError('EMBEDDING_FAILED', 'Smoke inference failed.');
      return;
    }
    await this.load(true);
    const [v] = await this.embed(['semantic code index smoke test']);
    if (!v || v.length !== this.profile.dimensions) throw new SemanticIndexError('EMBEDDING_FAILED', 'Smoke inference failed.');
    const weights = cachedFilePath(this.options.cacheDir, this.profile, 'onnx/model_quantized.onnx');
    if (!weights || !(await stat(weights).catch(() => null))) {
      throw new SemanticIndexError('MODEL_NOT_AVAILABLE', 'Model weights were not persisted to the cache directory.');
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const loading = this.loading;
    this.loading = null;
    if (!loading) return;
    try {
      const { model } = await loading;
      await model.dispose?.();
    } catch {
      // initialization failed or already disposed
    }
  }
}
