# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project state

This repository contains only the specification so far: `semantic-code-index-specification.md`. It is the source of truth for the work. Treat its MUST requirements as acceptance criteria. Read the relevant section before you implement or change any behavior. SHOULD requirements may be deferred only if the reason is documented.

The goal is an npm package (`semantic-code-index`, a provisional name). It works as a local stdio MCP server, a CLI, and a programmatic library. All three share one core. Coding agents submit natural-language descriptions of files. The package embeds those descriptions locally, stores them in SQLite, and searches them semantically.

Implement in the phase order from spec §19: scaffold/config → discovery → storage → embeddings → core indexing/search → maintenance → CLI/MCP → release validation. Run tests at the end of each phase.

Never publish to npm or push to a remote without explicit authorization. At delivery, report the actual test results, dependency versions, platform support and any deviations.

## Stack (spec §3.2)

- TypeScript, ESM, strict mode, Node.js 22+ (test on 22 and 24).
- `better-sqlite3` plus `sqlite-vec`, using the scalar `vec_distance_cosine` over an ordinary BLOB column. Do **not** use a `vec0` virtual table or ANN.
- `@huggingface/transformers` running ONNX on CPU locally with the model `Xenova/all-MiniLM-L6-v2` (384 dimensions, q8, mean pooling, normalized, pinned to an immutable revision).
- The MCP **v2** TypeScript SDK (`@modelcontextprotocol/server`) with `zod`. Never mix v1 and v2 imports.
- `commander` for the CLI. Use the Git CLI (`git ls-files -z`, shell-free) for scanning, and `ignore` for the non-Git fallback.
- Vitest or the Node test runner.

## Commands

These are the planned scripts (spec §16). They don't exist until phase 1 creates `package.json`:

```bash
npm run build
npm run lint
npm run typecheck
npm test                 # unit + integration, using fake embeddings
# separate explicit scripts for integration / e2e / real-model tests
```

Release validation includes `npm pack` and installing the tarball into a fresh fixture project.

## Architecture

The planned layout is in spec §16. These boundaries are mandatory:

- **`service/`** is the only home for business logic. The CLI (`cli.ts`), the MCP server (`mcp/`) and the library entry (`index.ts`) are thin adapters. Never duplicate SQL, path validation, search or embedding logic in an adapter.
- **`project/paths.ts`** is the one shared path resolver. Every file operation goes through it, including explicit index calls, so an agent can't bypass the scan policy. It rejects absolute, UNC and drive paths, `..`, symlinks in any component, and backslashes on POSIX. Containment checks are path-aware, never string-prefix tests.
- **`storage/`** has a single `files` table. Each row holds the description plus a 1,536-byte little-endian Float32 embedding BLOB. The `metadata` table holds `embedding_profile`, `schema_version` and `index_generation`. `PRAGMA user_version = 1`. The schema is in spec §7.1.
- **`embeddings/`** implements the `EmbeddingProvider` interface (§8.3). A fake provider is allowed only through library dependency injection in tests. The CLI and MCP must never select it.

### Key invariants that span modules

- **Hash-guarded indexing (§9.3).** Every index request carries an `expected_hash` (SHA-256 of the file bytes). The file is hashed before embedding and again just before the write. A mismatch returns `FILE_CHANGED` and keeps the old row.
- **Freshness comes from disk, not the DB.** Search, status, list and get compare current file bytes with the stored `content_hash`. Never prefilter on `state = 'indexed'`. Read operations must never mutate rows or bump `index_generation`.
- **Search (§10.2).** Apply path-prefix filtering in SQL before ranking. Prefixes match whole path components. Iterate candidates in bounded batches, verifying each, and skip missing, ineligible, unavailable or stale candidates until `limit` valid results are found. `score = 1 - distance`, with ties broken by ascending path.
- **Reconcile (§9.4).** Never delete records when a scan is incomplete or failed, or on transient I/O errors. Changed files are marked stale but keep their description and vector. Renames become remove + unindexed.
- **Concurrency.** Never hold a SQLite transaction across model inference or a full scan. Use compare-and-swap on the prior row version or the generation, and return the retryable errors `DB_BUSY` and `INDEX_CHANGED`. Use WAL, `busy_timeout` of 5s and `synchronous=NORMAL`.
- **Embedding profile is a compatibility contract.** On a mismatch, indexing and search return `MODEL_MISMATCH` until an explicit `reembed` (all-or-nothing) or `reset --yes`. Never migrate or reset implicitly.
- **MCP stdout carries only protocol messages.** All logs go to stderr. Public JSON uses snake_case. Responses never include vectors, file contents or absolute paths. `reset` is CLI-only.
- **Text limits.** Descriptions are 1–1,200 code points and queries 1–1,000, both capped at 256 model tokens. Reject overlong text with `TEXT_TOO_LONG`. Never truncate.
- **Git safety.** `init` adds `/.semantic-index/` to `.gitignore` idempotently. The package never runs `git add`, `commit`, `rm` or `push`. The model cache lives outside the project, in the per-user OS cache directory or `SEMANTIC_INDEX_CACHE_DIR`.

### Fixed limits

| Limit | Value |
|---|---|
| Index batch | 50 |
| Inference sub-batch | 16 |
| List page | default 100, max 200 |
| Search results | default 10, max 50 |
| `maxFileBytes` | default 1 MiB, max 16 MiB |
| Concurrent file reads | about 8 |
| Concurrent inference | 1 |

### Error codes and exit codes

Error codes come from the fixed `ErrorCode` union in spec §12.2. CLI exit codes: 0 = success, 1 = operational failure (including any failed item in a batch), 2 = invalid arguments.

## Out of scope for v0.1 (§2.2)

LLM-generated descriptions, code chunking, AST or function-level indexing, keyword or hybrid search, file watchers, HTTP transport, telemetry, and raw vectors in public APIs.
