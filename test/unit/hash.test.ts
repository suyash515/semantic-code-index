import { describe, expect, it } from 'vitest';
import { chmodSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inspectContent, sha256Hex } from '../../src/project/hash.js';
import { tempDir } from '../helpers/fixtures.js';

describe('inspectContent', () => {
  const dir = tempDir();
  const f = (name: string, data: string | Buffer) => {
    const p = path.join(dir, name);
    writeFileSync(p, data);
    return p;
  };

  it('hashes exact bytes (line endings and non-ASCII matter)', async () => {
    const lf = await inspectContent(f('lf.txt', 'a\nb\n'), 1024);
    const crlf = await inspectContent(f('crlf.txt', 'a\r\nb\r\n'), 1024);
    const uni = await inspectContent(f('u.txt', 'café'), 1024);
    const uni2 = await inspectContent(f('u2.txt', 'cafe\u0301'), 1024);
    expect(lf).toEqual({ kind: 'ok', hash: createHash('sha256').update('a\nb\n').digest('hex'), size: 4 });
    expect(crlf.kind === 'ok' && lf.kind === 'ok' && crlf.hash !== lf.hash).toBe(true);
    expect(uni.kind === 'ok' && uni2.kind === 'ok' && uni.hash !== uni2.hash).toBe(true);
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
  it('accepts empty and extensionless text', async () => {
    expect((await inspectContent(f('empty', ''), 10)).kind).toBe('ok');
    expect((await inspectContent(f('Makefile', 'all:\n\techo hi\n'), 1024)).kind).toBe('ok');
  });
  it('rejects binary, invalid UTF-8, oversized', async () => {
    expect(await inspectContent(f('nul.txt', Buffer.from([0x61, 0x00, 0x62])), 1024)).toEqual({ kind: 'ineligible', reason: 'binary' });
    expect(await inspectContent(f('bad.txt', Buffer.from([0xc3, 0x28])), 1024)).toEqual({ kind: 'ineligible', reason: 'invalid-utf8' });
    expect(await inspectContent(f('big.txt', 'x'.repeat(11)), 10)).toEqual({ kind: 'ineligible', reason: 'too-large' });
    expect((await inspectContent(f('exact.txt', 'x'.repeat(10)), 10)).kind).toBe('ok');
  });
  it('reports missing and unreadable files', async () => {
    expect(await inspectContent(path.join(dir, 'nope'), 10)).toEqual({ kind: 'missing' });
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const p = f('locked.txt', 'x');
      chmodSync(p, 0o000);
      expect((await inspectContent(p, 10)).kind).toBe('unavailable');
      chmodSync(p, 0o644);
    }
  });
});
