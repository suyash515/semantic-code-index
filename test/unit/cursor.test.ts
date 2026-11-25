import { describe, expect, it } from 'vitest';
import { encodeCursor, decodeCursor } from '../../src/service/cursor.js';

describe('cursor', () => {
  it('round-trips and is opaque', () => {
    const c = encodeCursor('unindexed', 'src/', 3, 'src/a.ts');
    expect(c).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeCursor(c, 'unindexed', 'src/', 3)).toBe('src/a.ts');
  });
  it('rejects wrong type or scope, malformed input; reports generation change', () => {
    const c = encodeCursor('unindexed', 'src/', 3, 'src/a.ts');
    expect(() => decodeCursor(c, 'stale', 'src/', 3)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => decodeCursor(c, 'unindexed', null, 3)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    expect(() => decodeCursor(c, 'unindexed', 'src/', 4)).toThrowError(expect.objectContaining({ code: 'INDEX_CHANGED', retryable: true }));
    for (const bad of ['', '!!!', 'abc', Buffer.from('{"v":2}').toString('base64url'), Buffer.from('[]').toString('base64url'), 'x'.repeat(9000)]) {
      expect(() => decodeCursor(bad, 'unindexed', 'src/', 3)).toThrowError(expect.objectContaining({ code: 'INVALID_CURSOR' }));
    }
  });
});
