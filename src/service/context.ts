/** Shared state for service operations. All business logic lives under service/. */
import type { ResolvedConfig } from '../config/defaults.js';
import { canonicalProfileJson } from '../config/defaults.js';
import { SemanticIndexError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Project } from '../project/scanner.js';
import type { Repository } from '../storage/repository.js';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import type { EmbeddingProfile } from '../config/defaults.js';

export interface ServiceContext {
  root: string;
  config: ResolvedConfig;
  repo: Repository;
  project: Project;
  logger: Logger;
  /** Profile the active provider produces (known without loading the model). */
  expectedProfile: EmbeddingProfile;
  /** Lazily creates the embedding provider (model is loaded only on first embed). */
  provider(): EmbeddingProvider;
}

export function expectedProfileJson(ctx: ServiceContext): string {
  return canonicalProfileJson(ctx.expectedProfile);
}

export function isModelCompatible(ctx: ServiceContext): boolean {
  return ctx.repo.getProfileJson() === expectedProfileJson(ctx);
}

/** Indexing and search require the stored profile to match the active provider. */
export function assertModelCompatible(ctx: ServiceContext): void {
  if (!isModelCompatible(ctx)) {
    throw new SemanticIndexError(
      'MODEL_MISMATCH',
      'The index was built with a different embedding profile than the active model. Run `semantic-code-index reembed` (keeps descriptions) or `semantic-code-index reset --yes`.',
      { details: { expected_model: ctx.expectedProfile.model, expected_revision: ctx.expectedProfile.revision } }
    );
  }
}

export function cancelledError(): SemanticIndexError {
  return new SemanticIndexError('INTERNAL_ERROR', 'Operation cancelled.', { retryable: true });
}

export function checkAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw cancelledError();
}

/** Bounded list of strings with an omitted count. */
export class BoundedList {
  readonly items: string[] = [];
  omitted = 0;
  constructor(private readonly max: number) {}
  push(s: string): void {
    if (this.items.length < this.max) this.items.push(s);
    else this.omitted++;
  }
}

/** Bounded warnings: appends an omitted-count notice when truncated. */
export function finalizeWarnings(warnings: string[], max = 50): string[] {
  if (warnings.length <= max) return warnings;
  return [...warnings.slice(0, max - 1), `${warnings.length - (max - 1)} more warning(s) omitted.`];
}
