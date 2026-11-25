import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConfig, loadConfig, defaultConfigText } from '../../src/config/load.js';
import { DEFAULT_EMBEDDING_PROFILE, canonicalProfileJson, defaultConfig } from '../../src/config/defaults.js';
import { SemanticIndexError } from '../../src/errors.js';

function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SemanticIndexError);
    expect((err as SemanticIndexError).code).toBe(code);
    return;
  }
  throw new Error('expected throw');
}

describe('config', () => {
  it('default config round-trips and has a concrete immutable revision', () => {
    const cfg = parseConfig(defaultConfigText());
    expect(cfg).toEqual(defaultConfig());
    expect(cfg.embedding.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(defaultConfigText()).not.toContain('main');
  });

  it('accepts minimal config', () => {
    const cfg = parseConfig('{"configVersion":1}');
    expect(cfg.scan.maxFileBytes).toBe(1048576);
    expect(cfg.search.defaultLimit).toBe(10);
    expect(cfg.search.includeStaleByDefault).toBe(false);
  });

  it('rejects unknown keys, invalid ranges and unsupported versions', () => {
    expectCode(() => parseConfig('{"configVersion":1,"extra":1}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"scan":{"bogus":true}}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":2}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"scan":{"maxFileBytes":0}}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"scan":{"maxFileBytes":16777217}}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"search":{"maxLimit":51}}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"search":{"defaultLimit":20,"maxLimit":10}}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('not json'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"scan":{"include":["!src"]}}'), 'CONFIG_INVALID');
    expectCode(() => parseConfig('{"configVersion":1,"scan":{"exclude":["../x"]}}'), 'CONFIG_INVALID');
    expect(parseConfig('{"configVersion":1,"scan":{"maxFileBytes":16777216}}').scan.maxFileBytes).toBe(16777216);
  });

  it('rejects unsupported embedding profiles', () => {
    const cfg = defaultConfig();
    cfg.embedding.model = 'other/model';
    expectCode(() => parseConfig(JSON.stringify(cfg)), 'CONFIG_INVALID');
    const cfg2 = defaultConfig();
    cfg2.embedding.revision = 'main';
    expectCode(() => parseConfig(JSON.stringify(cfg2)), 'CONFIG_INVALID');
    const cfg3 = defaultConfig();
    cfg3.embedding.dimensions = 768;
    expectCode(() => parseConfig(JSON.stringify(cfg3)), 'CONFIG_INVALID');
  });

  it('loadConfig returns defaults when missing and rejects symlinked config', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sci-cfg-'));
    expect(await loadConfig(dir)).toEqual(defaultConfig());
    writeFileSync(path.join(dir, 'real.json'), '{"configVersion":1}');
    symlinkSync(path.join(dir, 'real.json'), path.join(dir, '.semantic-index.json'));
    await expect(loadConfig(dir)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('canonical profile JSON has sorted keys', () => {
    const json = canonicalProfileJson(DEFAULT_EMBEDDING_PROFILE);
    expect(Object.keys(JSON.parse(json))).toEqual(['dimensions', 'dtype', 'inputVersion', 'model', 'normalize', 'pooling', 'revision']);
  });
});
