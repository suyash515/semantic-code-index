/** Bounded content inspection: size limit, binary/UTF-8 validation and exact-byte SHA-256 (spec §6.2). */
import { createHash } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export const SHA256_RE = /^[0-9a-f]{64}$/;

export type ContentInspection =
  | { kind: 'ok'; hash: string; size: number }
  | { kind: 'ineligible'; reason: 'too-large' | 'binary' | 'invalid-utf8' | 'not-file' }
  | { kind: 'missing' }
  | { kind: 'unavailable'; code: string };

const NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Read at most maxBytes+1 bytes of a regular file (never following a final symlink),
 * reject oversize/binary/invalid UTF-8, and hash the exact bytes read.
 * Bytes are not retained after this call returns.
 */
export async function inspectContent(absPath: string, maxBytes: number): Promise<ContentInspection> {
  let handle;
  try {
    handle = await open(absPath, constants.O_RDONLY | NOFOLLOW);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    if (code === 'ELOOP') return { kind: 'ineligible', reason: 'not-file' };
    return { kind: 'unavailable', code };
  }
  try {
    const st: Stats = await handle.stat();
    if (!st.isFile()) return { kind: 'ineligible', reason: 'not-file' };
    if (st.size > maxBytes) return { kind: 'ineligible', reason: 'too-large' };
    // Read up to maxBytes+1 to detect files that grew during the read.
    const buf = Buffer.allocUnsafe(Math.min(maxBytes + 1, Math.max(st.size + 1, 1)));
    let total = 0;
    for (;;) {
      if (total === buf.length) {
        if (total > maxBytes) return { kind: 'ineligible', reason: 'too-large' };
        // File grew beyond its stat size but still under the limit: probe one more byte.
        const probe = Buffer.allocUnsafe(1);
        const { bytesRead } = await handle.read(probe, 0, 1, total);
        if (bytesRead === 0) break;
        return { kind: 'unavailable', code: 'EAGAIN' };
      }
      const { bytesRead } = await handle.read(buf, total, buf.length - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    if (total > maxBytes) return { kind: 'ineligible', reason: 'too-large' };
    const bytes = buf.subarray(0, total);
    if (bytes.includes(0)) return { kind: 'ineligible', reason: 'binary' };
    try {
      utf8.decode(bytes);
    } catch {
      return { kind: 'ineligible', reason: 'invalid-utf8' };
    }
    return { kind: 'ok', hash: sha256Hex(bytes), size: total };
  } catch (err) {
    return { kind: 'unavailable', code: (err as NodeJS.ErrnoException).code ?? 'UNKNOWN' };
  } finally {
    await handle.close().catch(() => undefined);
  }
}
