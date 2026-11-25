import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { validateTextBounds, codePointLength, tokenLimitError } from '../../src/embeddings/provider.js';
import { resolveCacheDir, defaultCacheDir, isOfflineMode } from '../../src/embeddings/cache.js';

describe('text validation', () => {
  it('trims and enforces code point bounds', () => {
    expect(validateTextBounds('  hello  ', 'description')).toBe('hello');
    expect(() => validateTextBounds('   ', 'description')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => validateTextBounds('', 'query')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(() => validateTextBounds(5, 'query')).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
    expect(validateTextBounds('x'.repeat(1200), 'description').length).toBe(1200);
    expect(() => validateTextBounds('x'.repeat(1201), 'description')).toThrowError(expect.objectContaining({ code: 'TEXT_TOO_LONG' }));
    expect(validateTextBounds('x'.repeat(1000), 'query').length).toBe(1000);
    expect(() => validateTextBounds('x'.repeat(1001), 'query')).toThrowError(expect.objectContaining({ code: 'TEXT_TOO_LONG' }));
    // code points, not UTF-16 units: 1200 emoji are allowed
    expect(codePointLength('😀'.repeat(1200))).toBe(1200);
    expect(() => validateTextBounds('😀'.repeat(1200), 'description')).not.toThrow();
  });
  it('reports token counts in TEXT_TOO_LONG', () => {
    const e = tokenLimitError('query', 300, 256);
    expect(e.code).toBe('TEXT_TOO_LONG');
    expect(e.toPayload().details).toEqual({ token_count: 300, max_tokens: 256 });
  });
});

describe('model cache dir', () => {
  it('uses per-user OS cache defaults', () => {
    expect(defaultCacheDir('linux', { XDG_CACHE_HOME: '/x/cache' })).toBe('/x/cache/semantic-code-index/models');
    expect(defaultCacheDir('darwin', {})).toMatch(/Library\/Caches\/semantic-code-index\/models$/);
    expect(defaultCacheDir('win32', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })).toBe('C:\\Users\\u\\AppData\\Local\\semantic-code-index\\Cache\\models');
  });
  it('honours absolute override; rejects relative and in-project locations', () => {
    expect(resolveCacheDir('/proj', { SEMANTIC_INDEX_CACHE_DIR: '/var/cache/m' })).toEqual({ dir: path.resolve('/var/cache/m'), configured: true });
    expect(() => resolveCacheDir('/proj', { SEMANTIC_INDEX_CACHE_DIR: 'rel/dir' })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() => resolveCacheDir('/proj', { SEMANTIC_INDEX_CACHE_DIR: '/proj/.cache' })).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(resolveCacheDir('/proj', {}).configured).toBe(false);
  });
  it('detects offline mode', () => {
    expect(isOfflineMode({ SEMANTIC_INDEX_OFFLINE: '1' })).toBe(true);
    expect(isOfflineMode({})).toBe(false);
  });
});
