/** Embedding provider contract (spec §8.3) plus text validation shared by indexing and search. */
import { SemanticIndexError } from '../errors.js';
import { LIMITS, canonicalProfileJson, type EmbeddingProfile } from '../config/defaults.js';

export type { EmbeddingProfile };

export interface EmbeddingProvider {
  readonly profile: EmbeddingProfile;
  /** Maximum model input tokens including special tokens (256 for the default profile). */
  readonly maxTokens: number;
  /** Token counts (including special tokens) without truncation. */
  countTokens(texts: readonly string[]): Promise<number[]>;
  /** Normalized embeddings in input order. Never truncates input. */
  embed(texts: readonly string[]): Promise<Float32Array[]>;
  /** Download/cache assets and run a smoke inference. */
  download(): Promise<void>;
  close(): Promise<void>;
}

export function profileJson(provider: EmbeddingProvider): string {
  return canonicalProfileJson(provider.profile);
}

export type TextKind = 'description' | 'query';

/** Count Unicode code points. */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Trim and validate code-point bounds (no model needed). Throws INVALID_INPUT / TEXT_TOO_LONG. */
export function validateTextBounds(text: unknown, kind: TextKind): string {
  if (typeof text !== 'string') throw new SemanticIndexError('INVALID_INPUT', `${kind} must be a string.`);
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new SemanticIndexError('INVALID_INPUT', `${kind} must not be empty or whitespace.`);
  const max = kind === 'description' ? LIMITS.descriptionMaxCodePoints : LIMITS.queryMaxCodePoints;
  const len = codePointLength(trimmed);
  if (len > max) {
    throw new SemanticIndexError('TEXT_TOO_LONG', `${kind} has ${len} characters; the maximum is ${max}. Shorten it; text is never truncated.`, {
      details: { code_points: len, max_code_points: max }
    });
  }
  return trimmed;
}

/** Build the TEXT_TOO_LONG error for token-limit violations. */
export function tokenLimitError(kind: TextKind, count: number, max: number): SemanticIndexError {
  return new SemanticIndexError('TEXT_TOO_LONG', `${kind} has ${count} model tokens; the maximum is ${max} (including special tokens). Shorten it; text is never truncated.`, {
    details: { token_count: count, max_tokens: max }
  });
}
