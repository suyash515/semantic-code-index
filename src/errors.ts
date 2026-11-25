/**
 * Stable error codes and the typed operational error class (spec §12.2).
 */

export const ERROR_CODES = [
  'INVALID_INPUT',
  'INVALID_PATH',
  'INVALID_CURSOR',
  'NOT_INITIALIZED',
  'CONFIG_INVALID',
  'NOT_FOUND',
  'FILE_NOT_ELIGIBLE',
  'FILE_CHANGED',
  'SCAN_FAILED',
  'TEXT_TOO_LONG',
  'MODEL_NOT_AVAILABLE',
  'EMBEDDING_FAILED',
  'MODEL_MISMATCH',
  'SCHEMA_UNSUPPORTED',
  'DB_BUSY',
  'DB_ERROR',
  'INDEX_CHANGED',
  'IO_ERROR',
  'INTERNAL_ERROR'
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorPayload {
  code: ErrorCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

const RETRYABLE_BY_DEFAULT: ReadonlySet<ErrorCode> = new Set<ErrorCode>([
  'FILE_CHANGED',
  'DB_BUSY',
  'INDEX_CHANGED',
  'IO_ERROR'
]);

/** Operational error thrown by every public API. */
export class SemanticIndexError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { retryable?: boolean; details?: Record<string, unknown>; cause?: unknown } = {}
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SemanticIndexError';
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_BY_DEFAULT.has(code);
    this.details = options.details;
  }

  toPayload(): ErrorPayload {
    const payload: ErrorPayload = { code: this.code, message: this.message, retryable: this.retryable };
    if (this.details && Object.keys(this.details).length > 0) payload.details = sanitizeDetails(this.details);
    return payload;
  }
}

export function isSemanticIndexError(err: unknown): err is SemanticIndexError {
  return err instanceof SemanticIndexError;
}

const MAX_DETAIL_KEYS = 20;
const MAX_DETAIL_STRING = 500;

/** Bound and sanitize details so payloads never carry stacks, absolute paths or large blobs. */
function sanitizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(details).slice(0, MAX_DETAIL_KEYS)) {
    if (typeof value === 'string') out[key] = redactAbsolutePaths(value).slice(0, MAX_DETAIL_STRING);
    else if (typeof value === 'number' || typeof value === 'boolean' || value === null) out[key] = value;
    else if (Array.isArray(value)) {
      out[key] = value
        .slice(0, 50)
        .filter((v) => ['string', 'number', 'boolean'].includes(typeof v))
        .map((v) => (typeof v === 'string' ? redactAbsolutePaths(v).slice(0, MAX_DETAIL_STRING) : v));
    }
  }
  return out;
}

/** Replace anything that looks like an absolute filesystem path with a placeholder. */
export function redactAbsolutePaths(text: string): string {
  return text
    .replace(/(^|[\s'"`(=:])(\/(?:[^\s'"`)]+\/?)+)/g, '$1<path>')
    .replace(/(^|[\s'"`(=:])([A-Za-z]:[\\/][^\s'"`)]*)/g, '$1<path>')
    .replace(/(^|[\s'"`(=:])(\\\\[^\s'"`)]+)/g, '$1<path>');
}

/**
 * Convert any thrown value into a stable, sanitized error payload.
 * Unknown errors become INTERNAL_ERROR without exposing stack traces.
 */
export function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof SemanticIndexError) return err.toPayload();
  const mapped = mapNativeError(err);
  if (mapped) return mapped.toPayload();
  return { code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: false };
}

/** Map SQLite/Node errors to operational errors; returns undefined if unknown. */
export function mapNativeError(err: unknown): SemanticIndexError | undefined {
  if (err instanceof SemanticIndexError) return err;
  if (!(err instanceof Error)) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string') {
    if (code === 'SQLITE_BUSY' || code.startsWith('SQLITE_BUSY_') || code === 'SQLITE_LOCKED') {
      return new SemanticIndexError('DB_BUSY', 'The index database is busy; retry shortly.', { cause: err });
    }
    if (code.startsWith('SQLITE_')) {
      return new SemanticIndexError('DB_ERROR', `Database error (${code}).`, { cause: err, retryable: false });
    }
    if (['EACCES', 'EPERM', 'EIO', 'EMFILE', 'ENFILE', 'EBUSY'].includes(code)) {
      return new SemanticIndexError('IO_ERROR', `Filesystem error (${code}).`, { cause: err });
    }
  }
  return undefined;
}

/** Wrap an unknown error as a SemanticIndexError (never loses an existing one). */
export function asSemanticIndexError(err: unknown): SemanticIndexError {
  return (
    mapNativeError(err) ??
    new SemanticIndexError('INTERNAL_ERROR', 'An internal error occurred.', { cause: err, retryable: false })
  );
}
