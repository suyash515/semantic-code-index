import { describe, expect, it } from 'vitest';
import { encodeVector, decodeVector, validateAndNormalize, distanceToScore } from '../../src/storage/vector-codec.js';

describe('vector codec', () => {
  it('round-trips little-endian float32 at 1536 bytes', () => {
    const v = validateAndNormalize(Array.from({ length: 384 }, (_, i) => i + 1), 384);
    const buf = encodeVector(v, 384);
    expect(buf.length).toBe(1536);
    expect(buf.readFloatLE(0)).toBeCloseTo(v[0]!, 7);
    expect(Array.from(decodeVector(buf, 384))).toEqual(Array.from(v));
  });
  it('rejects wrong dimensions, nonfinite, zero norm, unnormalized', () => {
    expect(() => validateAndNormalize([1, 2], 384)).toThrow(/dimensions/);
    expect(() => validateAndNormalize([NaN, 1, 1], 3)).toThrow(/non-finite/);
    expect(() => validateAndNormalize([Infinity, 1, 1], 3)).toThrow(/non-finite/);
    expect(() => validateAndNormalize([0, 0, 0], 3)).toThrow(/zero norm/);
    expect(() => encodeVector(new Float32Array([2, 0, 0]), 3)).toThrow(/normalized/);
    expect(() => decodeVector(Buffer.alloc(10), 384)).toThrow();
  });
  it('converts distance to score with clamping, rejecting nonfinite', () => {
    expect(distanceToScore(0)).toBe(1);
    expect(distanceToScore(0.25)).toBe(0.75);
    expect(distanceToScore(-1e-9)).toBe(1);
    expect(distanceToScore(2.0000001)).toBe(-1);
    expect(() => distanceToScore(NaN)).toThrow();
    expect(() => distanceToScore(null)).toThrow();
  });
});
