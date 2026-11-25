/**
 * Public request/response contracts (spec §10, §12). snake_case is used in the
 * public JSON contract and reused by the library to avoid translation bugs.
 */
import type { ErrorPayload } from './errors.js';

export type Sha256 = string;
export type ScanMode = 'git' | 'filesystem';

export interface IndexFileInput {
  path: string;
  description: string;
  expected_hash: Sha256;
}

export type IndexFileResult =
  | { path: string; status: 'created' | 'updated' | 'unchanged'; content_hash: Sha256 }
  | { path: string; status: 'failed'; error: ErrorPayload };

export interface IndexFilesRequest {
  files: IndexFileInput[];
}

export interface IndexFilesResult {
  total: number;
  created: number;
  updated: number;
  unchanged: number;
  failed: number;
  results: IndexFileResult[];
}

export interface FileSummary {
  path: string;
  size_bytes: number;
  current_hash: Sha256;
  language: string | null;
  state: 'unindexed' | 'indexed' | 'stale';
}

export interface StaleFileSummary extends FileSummary {
  state: 'stale';
  content_hash: Sha256;
  description: string;
  updated_at: string;
}

export interface ListRequest {
  path_prefix?: string;
  cursor?: string;
  limit?: number;
}

export interface Page<T> {
  files: T[];
  next_cursor: string | null;
  scan_mode: ScanMode;
  warnings: string[];
}

export interface SearchRequest {
  query: string;
  limit?: number;
  min_score?: number;
  path_prefix?: string;
  include_stale?: boolean;
}

export interface SearchResultItem {
  path: string;
  description: string;
  score: number;
  state: 'indexed' | 'stale';
  content_hash: Sha256;
  current_hash: Sha256;
  language: string | null;
  updated_at: string;
}

export interface SearchSkipped {
  stale: number;
  missing: number;
  ineligible: number;
  unavailable: number;
}

export interface SearchResult {
  query: string;
  results: SearchResultItem[];
  skipped: SearchSkipped;
  embedding_model: string;
  warnings: string[];
}

export type ObservationState = 'unindexed' | 'indexed' | 'stale' | 'missing' | 'ineligible' | 'unavailable';

export interface FileRecord {
  path: string;
  description: string;
  content_hash: Sha256;
  observed_hash: Sha256 | null;
  size_bytes: number;
  language: string | null;
  indexed_at: string;
  updated_at: string;
  state: 'indexed' | 'stale';
}

export interface GetFileRequest {
  path: string;
}

export interface GetFileResult {
  path: string;
  state: ObservationState;
  current_hash: Sha256 | null;
  current_size_bytes: number | null;
  record: FileRecord | null;
}

export interface RemoveFileRequest {
  path: string;
}

export interface RemoveFileResult {
  path: string;
  removed: boolean;
}

export interface StatusRequest {
  path_prefix?: string;
}

export interface IndexStatus {
  eligible: number;
  fresh: number;
  stale: number;
  unindexed: number;
  missing: number;
  ineligible: number;
  unavailable: number;
  coverage: number | null;
  complete: boolean;
  scan_mode: ScanMode;
  embedding_model: string;
  model_compatible: boolean;
  schema_version: number;
  warnings: string[];
}

export interface ReconcileRequest {
  path_prefix?: string;
  dry_run?: boolean;
}

export interface SampleList {
  paths: string[];
  omitted_count: number;
}

export interface ReconcileResult {
  dry_run: boolean;
  complete: boolean;
  scan_mode: ScanMode;
  unindexed: number;
  marked_stale: number;
  restored_fresh: number;
  removed_missing: number;
  removed_ineligible: number;
  unchanged: number;
  unavailable: number;
  conflicts: number;
  samples: {
    unindexed: SampleList;
    marked_stale: SampleList;
    restored_fresh: SampleList;
    removed_missing: SampleList;
    removed_ineligible: SampleList;
    unavailable: SampleList;
    conflicts: SampleList;
  };
  warnings: string[];
}

export interface ReembedResult {
  reembedded: number;
  embedding_model: string;
  index_generation: number;
}

export interface ResetRequest {
  confirm: boolean;
}

export interface ResetResult {
  removed: number;
}

export interface DownloadModelResult {
  embedding_model: string;
  revision: string;
  dtype: string;
  dimensions: number;
  cache_dir_configured: boolean;
}

export interface InitOptions {
  root?: string;
  claude?: boolean;
  instructions?: boolean;
  /** Install Claude Code agent skills under .claude/skills/ (spec §15.3). */
  skills?: boolean;
}

export interface InitStepResult {
  step: 'config' | 'database' | 'gitignore' | 'claude' | 'instructions' | 'skills';
  status: 'created' | 'updated' | 'unchanged' | 'failed';
  file: string;
  error?: ErrorPayload;
}

export interface InitResult {
  steps: InitStepResult[];
  warnings: string[];
  ok: boolean;
}
