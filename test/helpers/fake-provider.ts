import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from '../../src/embeddings/provider.js';
import { DEFAULT_EMBEDDING_PROFILE, type EmbeddingProfile } from '../../src/config/defaults.js';
import { validateAndNormalize } from '../../src/storage/vector-codec.js';

/**
 * Deterministic fake embedding provider for tests (injected through the library only).
 * Vectors come from an explicit text→vector map when provided, else from hashed bag-of-words.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  profile: EmbeddingProfile = { ...DEFAULT_EMBEDDING_PROFILE };
  readonly maxTokens = 256;
  readonly vectors = new Map<string, Float32Array>();
  embedCalls: string[][] = [];
  failNext: Error | null = null;
  /** Called before embedding returns (to simulate files changing during inference). */
  onEmbed: ((texts: readonly string[]) => void | Promise<void>) | null = null;
  closed = false;

  async countTokens(texts: readonly string[]): Promise<number[]> {
    return texts.map((t) => t.split(/\s+/).filter(Boolean).length + 2);
  }

  async embed(texts: readonly string[]): Promise<Float32Array[]> {
    this.embedCalls.push([...texts]);
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = null;
      throw e;
    }
    await this.onEmbed?.(texts);
    return texts.map((t) => this.vectors.get(t) ?? bagOfWords(t, this.profile.dimensions));
  }

  async download(): Promise<void> {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

export function bagOfWords(text: string, dims = 384): Float32Array {
  const v = new Float32Array(dims);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    const h = createHash('sha256').update(w).digest();
    v[h.readUInt16LE(0) % dims]! += 1;
  }
  v[dims - 1]! += 0.01; // never zero
  return validateAndNormalize(v, dims);
}
