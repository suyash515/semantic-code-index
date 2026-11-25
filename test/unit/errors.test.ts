import { describe, expect, it } from 'vitest';
import { SemanticIndexError, toErrorPayload, redactAbsolutePaths, mapNativeError } from '../../src/errors.js';

describe('errors', () => {
  it('produces stable payloads with default retryability', () => {
    expect(new SemanticIndexError('FILE_CHANGED', 'x').toPayload()).toEqual({ code: 'FILE_CHANGED', message: 'x', retryable: true });
    expect(new SemanticIndexError('INVALID_PATH', 'x').toPayload()).toEqual({ code: 'INVALID_PATH', message: 'x', retryable: false });
  });

  it('sanitizes unknown errors without leaking stacks or paths', () => {
    const p = toErrorPayload(new Error('boom at /home/user/secret/file.ts'));
    expect(p).toEqual({ code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: false });
    expect(JSON.stringify(p)).not.toContain('/home');
  });

  it('redacts absolute paths in details', () => {
    const e = new SemanticIndexError('IO_ERROR', 'x', { details: { reason: 'cannot open /home/u/x.ts or C:\\Users\\x' , n: 1, obj: { a: 1 } } });
    const p = e.toPayload();
    expect(p.details?.reason).toBe('cannot open <path> or <path>');
    expect(p.details?.n).toBe(1);
    expect(p.details).not.toHaveProperty('obj');
    expect(redactAbsolutePaths('src/a.ts is relative')).toBe('src/a.ts is relative');
  });

  it('maps sqlite busy and IO errors', () => {
    const busy = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
    expect(mapNativeError(busy)?.code).toBe('DB_BUSY');
    expect(mapNativeError(busy)?.retryable).toBe(true);
    expect(mapNativeError(Object.assign(new Error('x'), { code: 'SQLITE_CORRUPT' }))?.code).toBe('DB_ERROR');
    expect(mapNativeError(Object.assign(new Error('x'), { code: 'EACCES' }))?.code).toBe('IO_ERROR');
  });
});
