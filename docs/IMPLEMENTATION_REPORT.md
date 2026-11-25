# Implementation report: semantic-code-index v0.1.0

This report covers the package built from `semantic-code-index-specification.md`, following the phase order in §19. The package has **not** been published to npm or pushed to any remote.

## 1. Test results (actual)

Environment: Linux 6.2.0 x64, AMD Ryzen 5 5600U (12 threads), 31 GiB RAM.

| Check | Node 22.16.0 | Node 24.14.0 |
|---|---|---|
| `npm run lint` | pass | – |
| `npm run typecheck` | pass | – |
| `npm run build` | pass | – |
| `npm test`: unit + integration (real SQLite, fake embeddings) | **168 / 168 passed** (16 files) | **168 / 168 passed** |
| `npm run test:model`: real model | **7 / 7 passed** | **7 / 7 passed** |
| `npm run test:e2e`: built CLI and MCP server, real model | **11 / 11 passed** | **11 / 11 passed** |
| `node scripts/pack-smoke.mjs`: `npm pack`, tarball install into a fresh project, CLI / library / MCP | **26 / 26 checks passed** | **26 / 26 checks passed** |

All figures above were re-run on both Node versions after the Claude Code skills change (spec §15.3).

Phase-by-phase, each phase's tests were run before starting the next one:

1. Scaffold and config: 17 tests.
2. Discovery: 80 tests.
3. Storage: 100 tests, including a two-process write test.
4. Embeddings: 6 real-model tests.
5. Indexing and search: 124 tests.
6. Maintenance: 142 tests.
7. CLI and MCP: 145 tests plus 10 e2e tests.
8. Release validation: the results in the table above.

Highlights of the coverage:

- **Path security.** Absolute, UNC, drive and `..` paths, control characters, POSIX backslashes, symlinks in any component, symlinked index directories and DB files, and path-aware containment.
- **Eligibility.** Hard exclusions can't be overridden. Include/exclude patterns, hidden files, binary and invalid-UTF-8 files, oversized files and unreadable files are all handled.
- **Git scanning.** Tracked, untracked, ignored, tracked-then-ignored, nested root, nested repository/submodule, and whitespace or Unicode filenames. Filesystem fallback mode is covered too.
- **Hash races.** A file that changes before submission, during embedding (modified or deleted) or before the write is rejected, and the old row is kept.
- **Batches.** Ordering, mixed outcomes, duplicate normalized paths and provider-wide failure.
- **Ranking.** Exact cosine scores (1, 0.7071, 0, −1), tie-break by path, the `api/` vs `api-old/` prefix boundary, `min_score`, limit, and keyset paging past 110 stale candidates.
- **Skip-and-fill.** Missing, stale, ineligible and unavailable top candidates are skipped and lower-ranked valid files fill the limit. `include_stale` works, and a restored file counts as fresh before reconcile.
- **Read-only guarantee.** Search, status, list, get and dry-run reconcile were compared against a byte-for-byte snapshot of the rows and the generation before and after.
- **Reconcile.** Dry run; stale, restore, missing and ineligible; renames; prefix scope; transient I/O errors; incomplete scan; Git failure leads to `SCAN_FAILED` with no changes; bounded samples.
- **Pagination.** Cursor generation, type and scope binding.
- **Reset and reembed.** Reset needs confirmation. Reembed is all-or-nothing, also under concurrent change, and recovers from `MODEL_MISMATCH`.
- **Persistence and isolation.** Reopen after restart; separate worktrees; branch switch and switch-back.
- **Concurrency.** Concurrent `init`, `DB_BUSY`, and two processes writing through the library with an `integrity_check`.
- **Agent integration.** `init --skills` create / unchanged / CRLF-tolerant / customized-file-preserved / upgrade-from-earlier-template / symlinked `.claude` and skill file refused; `CLAUDE.md` migration from the old long block. A contract test checks that every tool, parameter, result field and error code named in the skills, the `CLAUDE.md` block and the MCP server instructions exists in the registered MCP schemas, and that `allowed-tools` pre-approves only read-only tools; a deliberately misspelled parameter and error code make it fail.
- **MCP.** Tools/list with schemas and annotations, every tool called, stable error payloads, SDK rejection of schema-invalid input, stdout carrying only JSON-RPC, exit on stdin EOF and SIGTERM, and `NOT_INITIALIZED` reported on stderr.
- **CLI.** Exit codes 0/1/2, `--json`, the stdin batch and its 1 MiB limit, `--root` from another working directory, offline mode, and a missing cache returning `MODEL_NOT_AVAILABLE`.
- **Real model.** Only the pinned revision folder is cached. Output is 384-dim, finite and normalized, and vectors are bit-identical across calls and batch composition. The 256-token limit is exact (254 words gives 256 tokens and is accepted; 255 words gives 257 and is rejected), and nothing is truncated above 128 tokens. Offline mode works with `fetch` and sockets blocked (0 network attempts), and an empty offline cache returns `MODEL_NOT_AVAILABLE`.
- **Retrieval quality** (`test/fixtures/retrieval/fixture.json`: 30 files across payments, auth, inventory, logging and more; 16 labeled queries): **recall@5 = 1.000 (16/16)**, with every labeled file ranked first.

**Not tested:**

- **Claude Code itself.** The skills were checked against the Claude Code skills documentation (frontmatter fields, `allowed-tools` format, `disable-model-invocation`), but whether Claude actually triggers `semantic-search` / `semantic-sync` on its own has not been observed in a live session. Starting the server through Claude Code and calling it from there was not tested, because doing so changes the user-level Claude configuration. The exact registered command (`npx --no-install semantic-code-index mcp` from `.mcp.json`) was exercised by the pack smoke test with raw MCP JSON-RPC, and by the official MCP client in the e2e suite. To reproduce manually:

  ```bash
  npm i -D ./semantic-code-index-0.1.0.tgz && npx semantic-code-index init --claude --instructions --skills && npx semantic-code-index model download
  claude mcp list            # approve the project server when prompted
  # inside Claude Code: /mcp  → semantic-code-index connected, 9 tools
  # /semantic-index → indexes the project; ask for a feature → semantic-search should trigger;
  # after an edit → semantic-sync should refresh the changed file
  npx @modelcontextprotocol/inspector npx --no-install semantic-code-index mcp
  ```
- **macOS, Windows and Linux arm64.** Not run, because only one Linux machine was available. `.github/workflows/ci.yml` defines the 3 OS × Node 22/24 matrix. It has not run, since nothing was pushed.

## 2. Dependency versions (pinned exactly; lockfile included)

| Package | Version | License |
|---|---|---|
| better-sqlite3 | 13.2.0 | MIT |
| sqlite-vec | 0.1.9 | MIT OR Apache-2.0 |
| @huggingface/transformers | 4.3.2 (onnxruntime-node 1.30.0) | Apache-2.0 (ORT: MIT) |
| @modelcontextprotocol/server | 2.4.0 (MCP TS SDK v2; v1 `@modelcontextprotocol/sdk` not used) | Apache-2.0 |
| zod | 4.6.7 | MIT |
| commander | 15.1.0 | MIT |
| ignore | 7.0.17 | MIT |
| dev: typescript 6.0.3, vitest 5.1.2, eslint 10.15.0, typescript-eslint 8.74.0, @modelcontextprotocol/client 2.4.0, @types/node 22.20.7, @types/better-sqlite3 9.6.0 | | |

Model: `Xenova/all-MiniLM-L6-v2` at commit `751bff37182d3f1213fa05d7196b954e230abad9`, `onnx/model_quantized.onnx` (q8), licensed Apache-2.0. I verified this revision against the Hugging Face API. Its tokenizer is `BertTokenizer` with `model_max_length` 512, and the package enforces the 256-token limit itself.

## 3. Platform support

- **Verified:** Linux x64 on Node 22.16 and Node 24.14. All three native dependencies are N-API based, and a fresh tarball install worked on both Node versions.
- **Unverified:** macOS arm64/x64, Windows x64 and Linux arm64. Prebuilt binaries exist for all native dependencies, but the CI matrix has not run. One known Windows gap is that the test suite creates symlinks, which needs Developer Mode or admin rights; product code has guarded paths for Windows. Don't claim these platforms are supported until CI passes.
- **Unsupported:** architectures without a `sqlite-vec` prebuilt, such as linux-ia32 and FreeBSD.

## 4. Benchmark (summary; full table in `docs/BENCHMARK.md`)

| Files | Exact SQL ranking (warm median) | Total warm search (embed + rank + verify) | Full reconcile | DB + WAL on disk |
|---|---|---|---|---|
| 1,000 | 0.7 ms | 19 ms | 89 ms | 2.0 MiB |
| 10,000 | 12.6 ms (target was < 500 ms) | 47 ms | 0.60 s | 20.1 MiB |
| 50,000 | 65.5 ms | 107 ms | 3.2 s | 100.3 MiB |

Loading the model from a warm disk cache and producing the first embedding took 273 ms. A warm single-query embedding takes 2.8 ms (median). The benchmark uses synthetic vectors and descriptions over tiny generated files; reproduce it with `npm run build && node scripts/bench.mjs 1000,10000,50000`.

## 5. Deviations from the specification, and why

1. **`engines.node` is `>=22.12.0`, not `>=22`.** `commander@15` requires Node ≥ 22.12. Any current Node 22 LTS satisfies this.
2. **TypeScript 6.0.3 rather than 7.x.** `typescript-eslint@8.74` supports TypeScript `<6.1`, and TS 7 (the native port) can't be linted yet.
3. **Transformers.js `pipeline()` is not used.** In 4.3.2, `pipeline()` and `AutoTokenizer` resolve file metadata (`config.json`, `tokenizer_config.json`) from the **floating `main` revision**, and they ignore both the pinned revision and `local_files_only`. I observed this directly: the request URLs pointed at `resolve/main/`, and offline loading failed. To meet the "immutable revision" and "offline with no network" MUST requirements, the provider:
   - loads `AutoTokenizer` and `AutoModel` with the pinned revision;
   - does mean pooling and L2 normalization itself;
   - installs a scoped `env.fetch` shim. The shim serves cached files of the pinned revision locally, rewrites any request for this model to the pinned commit, refuses every other URL, and refuses all requests in offline mode.

   Offline mode is enforced by this shim rather than by `local_files_only`, because Transformers.js rejects `local_files_only` when local model paths are disabled.
4. **Inference runs one text at a time, unpadded, inside sub-batches of 16.** With q8 dynamic quantization, a description embedded in a padded batch came out at cosine ≈ 0.993 against the same text embedded alone. That would make document vectors, which are batched, inconsistent with query vectors, which are always single. The 16-item sub-batch is kept as the scheduling unit with inference concurrency 1. In exchange, vectors are bit-identical regardless of batch composition.
5. **The `EmbeddingProvider` interface (§8.3) has two extra members, `maxTokens` and `countTokens(texts)`.** The 256-token limit has to be checked, and the exact count reported, before embedding and without truncation. `embed()` also re-checks it defensively.
6. **Cancellation uses the error code `INTERNAL_ERROR`.** It is marked `retryable: true` with the message "Operation cancelled.", because the `ErrorCode` union is fixed and has no `CANCELLED` code. Cancellation is checked before inference and before each write transaction, so a cancelled batch never commits partially (§17.1).
7. **Schema-invalid MCP arguments are rejected by the SDK.** Unknown keys, out-of-range limits and malformed hashes are validated by `@modelcontextprotocol/server` against the published strict Zod schemas before the handler runs. The SDK returns them as `isError: true` with its own text message, not our `{error: {code: "INVALID_INPUT"}}` payload. Every error raised by the service layer uses the stable payload.
8. **There is no separate OS lock file for reset and reembed.** §7.2 allows an "equivalent tested mechanism". Both run in one `BEGIN IMMEDIATE` transaction, and reembed also does a generation compare-and-swap. SQLite's own file locking serializes them with every writer, so there is no stale-lock recovery problem. This is tested with concurrent writers and a mid-reembed mutation.
9. **The row version for compare-and-swap is the tuple `(id, description, content_hash, observed_hash, state, updated_at)`.** Schema v1 has no version column, and I didn't change the mandated schema.
10. **Error codes where the spec doesn't name one:**
    - Indexing a file that doesn't exist at the first check returns `NOT_FOUND`. A file deleted between the first check and the write returns `FILE_CHANGED`. Ineligible files return `FILE_NOT_ELIGIBLE`, and unreadable files return `IO_ERROR`.
    - Reconcile returns `SCAN_FAILED` for an incomplete filesystem scan in **dry-run** mode as well, so that detection logic is identical.
    - Status sets `complete: false` when the scan was partial or any path couldn't be read.
11. **The hard-exclusion list is a superset of §6.2.** It adds other VCS directories (`.hg`, `.svn`, `.bzr`, `.jj`, `.sl`, `CVS`, `_darcs`), more key and keystore extensions (`.p12`, `.pfx`, `.jks`, `.kdbx`, `.gpg`, `.asc`), `.git-credentials`, `.htpasswd`, `.docker/config.json`, `.aws/config`, `*.pub` SSH keys, and media, font and model-weight formats.
12. **`model download` doesn't need an initialized project.** It touches only the per-user cache.
13. **Listing pages are best-effort.**
    - `list_unindexed_files` hashes candidates in chunks of at least 8, so it can hash up to 7 files beyond the page.
    - `next_cursor` is returned whenever any candidate path remains, which can lead to a final empty page if every remaining candidate turns out ineligible. §9.5 treats listings as best-effort.
14. **Search stops at the `min_score` threshold.** Rows are ordered by ascending distance and the threshold is applied to the unrounded score, so the result is the same as filtering every row, but the remaining candidates aren't verified.
15. **Agent integration was amended after the original implementation.** At the owner's request, §2.2, §4, §4.3, §13, §15, §16, §18, §19 and §20 now add `init --skills` (three Claude Code skills, §15.3) and replace the long `CLAUDE.md` block with a short pointer block. Hooks, MCP prompts, skills served over MCP and Codex integration are deferred to the roadmap. Skill templates are embedded as TypeScript constants rather than a `templates/` directory, so they can't be missing from the tarball.
16. **The MIT license is a proposal, as §16 states.** Final license and npm name availability (`semantic-code-index`) still need owner approval.

No MUST requirement was knowingly left unmet, and no SHOULD requirement was deferred.

## 6. Layout

`src/` follows the structure suggested in §16:

- `service/` holds all business logic.
- `cli.ts` is the executable entry and `cli-program.ts` its command definitions. These, `mcp/` and `index.ts` are thin adapters.
- `project/paths.ts` is the single path resolver.
- `storage/repository.ts` holds all SQL.
- `embeddings/` contains the provider.
- `integration/` merges `.gitignore`, `.mcp.json` and `CLAUDE.md`, and installs the Claude Code skills (`claude-skills.ts`).
- `util/concurrency.ts` provides bounded mapping and the inference queue.

Tests live in `test/{unit,integration,e2e,model}`, with shared helpers in `test/helpers`. Two child-process suites run the TypeScript sources directly through `--experimental-transform-types` and a small resolve hook. The fake embedding provider lives only in `test/helpers` and is never reachable from the CLI or MCP server.
