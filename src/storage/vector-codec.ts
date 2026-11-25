/** Explicit little-endian Float32 serialization with validation (spec §7.1, §8.1). */
import { SemanticIndexError } from '../errors.js';

export const NORM_TOLERANCE = 1e-3;

export function vectorNorm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

/** Validate dimensions and finiteness; return an L2-normalized copy. Rejects zero norm. */
export function validateAndNormalize(v: ArrayLike<number>, dimensions: number): Float32Array {
  if (v.length !== dimensions) {
    throw new SemanticIndexError('EMBEDDING_FAILED', `Embedding has ${v.length} dimensions; expected ${dimensions}.`);
  }
  for (let i = 0; i < v.length; i++) {
    if (!Number.isFinite(v[i]!)) throw new SemanticIndexError('EMBEDDING_FAILED', 'Embedding contains non-finite values.');
  }
  const norm = vectorNorm(v);
  if (!(norm > 1e-12)) throw new SemanticIndexError('EMBEDDING_FAILED', 'Embedding has zero norm.');
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) out[i] = v[i]! / norm;
  return out;
}

/** Serialize a validated, normalized vector to little-endian float32 bytes. */
export function encodeVector(v: Float32Array, dimensions: number): Buffer {
  if (v.length !== dimensions) throw new SemanticIndexError('EMBEDDING_FAILED', 'Vector has wrong dimensions.');
  const norm = vectorNorm(v);
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > NORM_TOLERANCE) {
    throw new SemanticIndexError('EMBEDDING_FAILED', 'Vector is not normalized.');
  }
  const buf = Buffer.alloc(dimensions * 4);
  for (let i = 0; i < dimensions; i++) buf.writeFloatLE(v[i]!, i * 4);
  return buf;
}

export function decodeVector(buf: Uint8Array, dimensions: number): Float32Array {
  if (buf.byteLength !== dimensions * 4) throw new SemanticIndexError('DB_ERROR', 'Stored embedding has an invalid length.');
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const out = new Float32Array(dimensions);
  for (let i = 0; i < dimensions; i++) out[i] = view.getFloat32(i * 4, true);
  return out;
}

/** Cosine distance → similarity; clamps only floating-point rounding; rejects nonfinite distances. */
export function distanceToScore(distance: unknown): number {
  if (typeof distance !== 'number' || !Number.isFinite(distance)) {
    throw new SemanticIndexError('DB_ERROR', 'Nonfinite cosine distance encountered.');
  }
  const score = 1 - distance;
  return Math.max(-1, Math.min(1, score));
}
