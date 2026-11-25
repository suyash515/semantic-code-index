# semantic-code-index

A local, per-project **semantic file index for AI coding agents**. The agent reads a file and writes a short natural-language description. This package embeds the description **locally** (Transformers.js + ONNX on CPU), stores it in **SQLite** next to the file's path and SHA-256, and later returns the most relevant files for a natural-language query, re-verified against the current file bytes.

It ships as three thin adapters over one core:

- a **stdio MCP server** for Claude Code and other MCP clients,
- a **CLI** (`semantic-code-index`),
- a typed **Node.js library**.

No API key, no database server, no telemetry. The only network access is the one-time download of the pinned model.

> The index is a navigation aid, not a source of truth. Agents must still read the actual files before changing anything.

---

## Contents

- [Requirements and platform support](#requirements-and-platform-support)
- [Installation and setup](#installation-and-setup)
- [How it works](#how-it-works)
- [MCP server (Claude Code)](#mcp-server-claude-code)
- [Claude Code skills and CLAUDE.md](#claude-code-skills-and-claudemd)
- [CLI reference](#cli-reference)
- [Programmatic API](#programmatic-api)
- [Configuration](#configuration)
- [The embedding model, cache and offline use](#the-embedding-model-cache-and-offline-use)
- [Git policy, worktrees and branches](#git-policy-worktrees-and-branches)
- [File eligibility and path rules](#file-eligibility-and-path-rules)
- [Failure recovery](#failure-recovery)
- [Privacy and security](#privacy-and-security)
- [Limits and limitations](#limits-and-limitations)
- [Development](#development)
- [Licenses](#licenses)

---

## Requirements and platform support

- **Node.js ≥ 22.12** (ESM). Tested on Node.js 22.16 and 24.
- Git CLI (optional; used for Git-aware scanning when the root is inside a work tree).

Native dependencies: `better-sqlite3` (N-API, prebuilt binaries for common platforms; otherwise needs a C++ toolchain and Python for `node-gyp`), `sqlite-vec` (prebuilt loadable extension for linux-x64, linux-arm64, darwin-x64, darwin-arm64 and windows-x64 only), and `onnxruntime-node` through `@huggingface/transformers`.

| Platform | Status |
|---|---|
| Linux x64, Node 22 / 24 | **Verified**: full test suite, real-model tests, packed-tarball install, MCP smoke test |
| macOS (arm64/x64), Windows x64, Linux arm64 | **Not verified yet.** Prebuilt binaries exist for every native dependency; a CI matrix is provided in `.github/workflows/ci.yml`. Treat these as unsupported until it passes. |
| Other architectures (e.g. linux-ia32, FreeBSD) | Unsupported: `sqlite-vec` ships no prebuilt extension |

## Installation and setup

Run these from the **project root**. The root defaults to the current working directory and is never guessed from a parent directory.

```bash
npm install --save-dev semantic-code-index
npx semantic-code-index init --claude --instructions --skills   # config, DB, .gitignore, .mcp.json, CLAUDE.md, .claude/skills
npx semantic-code-index model download                  # one-time: caches the model outside the project
npx semantic-code-index status
```

`init` is explicit and idempotent. It:

- creates `.semantic-index.json` with the defaults, if missing (an existing file is validated, never overwritten);
- creates `.semantic-index/index.db` (schema v1, WAL mode, directory mode 0700 / file 0600 where supported);
- adds `/.semantic-index/` to the root `.gitignore`, preserving existing content and line endings;
- with `--claude`, merges the MCP registration into `.mcp.json`, keeping other servers;
- with `--instructions`, merges a short marked agent-instructions block into `CLAUDE.md`, keeping everything outside the markers;
- with `--skills`, installs three Claude Code skills under `.claude/skills/` (see [Claude Code skills and CLAUDE.md](#claude-code-skills-and-claudemd)).

If one step can't be completed safely (malformed JSON, a conflicting `semantic-code-index` entry, duplicate markers, a skill file you have edited), only that step fails, with a message saying why. The other steps still run, and you can rerun `init` once you've fixed the problem. `init` never downloads the model, and it never runs `git add`, `commit`, `rm` or `push`.

Every other command returns `NOT_INITIALIZED` until `init` has run, so an index is never created silently in the wrong directory.

## How it works

1. **Discover.** `list_unindexed_files` returns eligible files with their size, language and current SHA-256 `current_hash`.
2. **Describe.** The agent reads each file and writes a 30–100 word description of its purpose, responsibilities, business rules and integrations.
3. **Index.** `index_files` (up to 50 per call) takes `{path, description, expected_hash}`. The package hashes the file before embedding and again immediately before the write. If the bytes changed, the item fails with `FILE_CHANGED` and any previous record is kept.
4. **Search.** `search_files` embeds the query, ranks every in-scope record by exact cosine similarity in SQLite (`sqlite-vec` `vec_distance_cosine`), then re-hashes candidates in rank order. Missing, ineligible, unreadable and (by default) stale files are skipped, and lower-ranked valid files fill the requested limit.
5. **Maintain.** `list_stale_files` shows files whose content changed since they were described. `reconcile_index` marks changed files stale, restores reverted ones and removes records of deleted or newly ignored files. If a file changed but its description is still accurate, resubmit the same description with the new hash: the stored vector is reused.

Freshness is always computed from **current file bytes**, never from the stored state. Search, status, listing and `get_file` never modify the database.

## MCP server (Claude Code)

`init --claude` writes this portable, project-scoped entry to `.mcp.json`:

```json
{
  "mcpServers": {
    "semantic-code-index": {
      "type": "stdio",
      "command": "npx",
      "args": ["--no-install", "semantic-code-index", "mcp"]
    }
  }
}
```

`--no-install` makes the launch fail if the package isn't installed locally, rather than downloading it implicitly. Alternatively, register it manually:

```bash
claude mcp add --scope project semantic-code-index -- npx --no-install semantic-code-index mcp
claude mcp list
```

Claude Code asks you to approve project-scoped servers. Then use `/mcp` inside Claude Code to confirm that the server and its tools are connected. To inspect the tools outside Claude Code, run `npx @modelcontextprotocol/inspector npx --no-install semantic-code-index mcp`.

- **Working directory.** The server indexes the directory it is launched from. If your client starts servers elsewhere, add `"--root", "<project dir>"` to `args`. Note that this makes `.mcp.json` machine-specific, so keep such an entry out of the shared file.
- **Windows.** If your client can't run `npx` directly, use `"command": "npx.cmd"` or `"command": "cmd", "args": ["/c", "npx", "--no-install", "semantic-code-index", "mcp"]`.
- **Other stdio clients** (Codex and others) work with the equivalent command `npx --no-install semantic-code-index mcp`.

### Tools

| Tool | Input | Mutates index |
|---|---|---|
| `get_index_status` | `{path_prefix?}` | no |
| `list_unindexed_files` | `{path_prefix?, cursor?, limit? (1–200, default 100)}` | no |
| `list_stale_files` | same | no |
| `get_file` | `{path}` | no |
| `index_file` | `{path, description, expected_hash}` | yes |
| `index_files` | `{files: [...]}` (1–50) | yes |
| `search_files` | `{query, limit? (1–50, default 10), min_score?, path_prefix?, include_stale?}` | no |
| `remove_file` | `{path}` (removes the record only, never the file) | yes |
| `reconcile_index` | `{path_prefix?, dry_run?}` | yes, unless `dry_run` |

Every tool returns structured content, with an identical JSON text copy for compatibility. Read-only, destructive and idempotent annotations are published. Operational failures return `isError: true` and `{ "error": { "code", "message", "retryable", "details?" } }`. A batch with mixed outcomes is a normal result with per-item `failed` entries. Arguments that fail the strict input schema are rejected by the MCP SDK itself, with an `isError` text message.

The server writes only protocol messages to stdout and logs to stderr (`--verbose` for more). It closes the database on stdin EOF, SIGINT or SIGTERM. Reset, arbitrary SQL, file access and shell commands are **not** exposed over MCP.

## Claude Code skills and CLAUDE.md

`CLAUDE.md` is loaded into every Claude Code session, so `init --instructions` writes only a short pointer block (about 10 lines). The detailed workflows live in three [skills](https://code.claude.com/docs/en/skills), which Claude loads only when they are used:

| Skill | Started by | What it does |
|---|---|---|
| `semantic-search` | Claude, or you (`/semantic-search …`) | Splits a task into concepts, runs focused `search_files` queries, reads the results; falls back to grep and normal exploration when results are weak |
| `semantic-index` | You only (`/semantic-index [directory]`) | Builds or completes the index: unindexed files, then stale files, in batches, then reports coverage. Claude never starts this on its own (`disable-model-invocation: true`) |
| `semantic-sync` | Claude, or you (`/semantic-sync`) | After a task, refreshes entries only for the files that task created, changed, renamed or deleted |

Each skill pre-approves only read-only tools (`search_files`, `get_file`, `get_index_status`, `list_unindexed_files`, `list_stale_files`). Tools that change the index (`index_files`, `remove_file`, `reconcile_index`) still follow your normal Claude Code permission settings. The MCP server also sends brief usage instructions of its own, so clients without skills still get the essentials.

**Customizing.** The skill files are yours to commit and edit. `init --skills` creates missing skills, leaves current ones alone (LF/CRLF differences are ignored), and upgrades unedited copies of earlier package versions. It never overwrites a skill you have edited: that skill's step fails with a message and the rest of `init` still runs. To go back to the packaged version, delete the file and rerun `init --skills`. If you've customized skills permanently, run `init` without `--skills`.

Hooks are not generated in v0.1. Skills are followed at Claude's discretion, so `semantic-sync` is not guaranteed to run after every change; `get_index_status` and `list_stale_files` show what is behind.

### Example prompts

With the skills installed, `/semantic-index` covers initial indexing and `/semantic-sync` covers maintenance after a task. Without them, prompts like these work:

- *Initial indexing:* "Use the semantic-code-index MCP tools to index this project. Start by checking index status. Discover unindexed files in batches, read each file, write a concise description of what it does, and save the description using the file's current hash. Process stale files as well. Do not modify application source files. Report final coverage and skipped files."
- *Task:* "Add retry handling for failed payments. Use the semantic index to find relevant files, inspect the actual code and dependencies, implement and test the change, then update index descriptions and hashes for modified files."
- *After a branch switch:* "Reconcile the semantic index, then review and re-index stale or new files relevant to the current branch. Do not change application source code during index maintenance."

## CLI reference

Global options: `--root <dir>`, `--json` (valid JSON on stdout, including errors as `{"error": {...}}`), `--verbose` (diagnostics on stderr), `--help`, `--version`.

| Command | Description |
|---|---|
| `init [--claude] [--instructions] [--skills]` | Initialize the project (see above) |
| `model download` | Download/cache the pinned model and run a smoke inference |
| `mcp` | Run the stdio MCP server |
| `status [--prefix DIR]` | Coverage: eligible = fresh + stale + unindexed; plus missing / ineligible / unavailable records |
| `list-unindexed [--prefix DIR] [--limit N] [--cursor T]` | Files without a description, with `current_hash` |
| `list-stale [--prefix DIR] [--limit N] [--cursor T]` | Indexed files whose content changed |
| `get <path>` | Current hash and stored record |
| `index <path> --description TEXT --expected-hash HASH` | Index one file |
| `index-batch --input FILE\|-` | `{"files":[...]}` from a file or stdin (≤ 1 MiB, ≤ 50 entries, same schema as MCP) |
| `search <query> [--limit N] [--min-score S] [--prefix DIR] [--include-stale]` | Semantic search |
| `remove <path>` | Remove an index record (never the file) |
| `reconcile [--prefix DIR] [--dry-run]` | Mark stale / restore / remove missing and ineligible records |
| `reembed` | Rebuild all vectors from stored descriptions (all-or-nothing) |
| `reset --yes` | Remove all records (without `--yes`: interactive confirmation on a TTY only) |

**Exit codes:** `0` means success. `1` means an operational failure, **including any failed item in a batch**: successful items in that batch were still committed, so a nonzero exit can mean partial success. `2` means invalid arguments or input.

```bash
npx semantic-code-index list-unindexed --limit 20 --json
npx semantic-code-index search "invoice payment validation" --limit 5
npx semantic-code-index reconcile --dry-run --json
echo '{"files":[{"path":"src/a.ts","description":"…","expected_hash":"…"}]}' | npx semantic-code-index index-batch --input -
```

## Programmatic API

```ts
import { openSemanticIndex, initializeProject, SemanticIndexError } from 'semantic-code-index';

await initializeProject({ root: process.cwd() }); // explicit; open never initializes
const index = await openSemanticIndex({ root: process.cwd() });
try {
  const file = await index.getFile({ path: 'src/payment.ts' });
  if (file.current_hash) {
    await index.indexFile({
      path: 'src/payment.ts',
      description: 'Validates customer payments and updates invoice status.',
      expected_hash: file.current_hash
    });
  }
  const matches = await index.searchFiles({ query: 'Where are customer payments validated?', limit: 5 });
  console.log(matches.results);
} catch (err) {
  if (err instanceof SemanticIndexError) console.error(err.code, err.retryable, err.message);
  throw err;
} finally {
  await index.close();
}
```

Importing the package has no side effects: it creates no database, starts no process, loads no model and scans nothing.

- `openSemanticIndex({ root?, embeddingProvider?, logger? })` returns a `SemanticIndex` for an initialized project.
- Methods: `indexFile`, `indexFiles`, `searchFiles`, `getFile`, `removeFile`, `listUnindexedFiles`, `listStaleFiles`, `getIndexStatus`, `reconcileIndex`, `downloadModel`, `reembed`, `reset({ confirm: true })` and `close`. All are async and accept `{ signal }` for cancellation where it applies. `close()` can safely be called more than once, and calls after close are rejected.
- Also exported: `initializeProject`, `downloadModelAssets`, every request/result type (snake_case fields, identical to the MCP contract), `SemanticIndexError`, `ERROR_CODES`, `DEFAULT_EMBEDDING_PROFILE` and `LIMITS`.
- Logging is silent by default. Inject a `{ debug, info, warn, error }` logger to see it.
- `embeddingProvider` exists for dependency injection in tests. The CLI and MCP server always use the real local model.

### Error codes

`INVALID_INPUT`, `INVALID_PATH`, `INVALID_CURSOR`, `NOT_INITIALIZED`, `CONFIG_INVALID`, `NOT_FOUND`, `FILE_NOT_ELIGIBLE`, `FILE_CHANGED`, `SCAN_FAILED`, `TEXT_TOO_LONG`, `MODEL_NOT_AVAILABLE`, `EMBEDDING_FAILED`, `MODEL_MISMATCH`, `SCHEMA_UNSUPPORTED`, `DB_BUSY`, `DB_ERROR`, `INDEX_CHANGED`, `IO_ERROR`, `INTERNAL_ERROR`. Codes with `retryable: true` (`FILE_CHANGED`, `DB_BUSY`, `INDEX_CHANGED` and transient I/O) are safe to retry after re-reading the relevant state. Error payloads never contain stack traces, absolute paths or file contents.

## Configuration

`.semantic-index.json` (optional, safe to commit, strictly validated: unknown keys and out-of-range values are rejected with `CONFIG_INVALID`):

```json
{
  "configVersion": 1,
  "embedding": {
    "model": "Xenova/all-MiniLM-L6-v2",
    "revision": "751bff37182d3f1213fa05d7196b954e230abad9",
    "dtype": "q8",
    "dimensions": 384,
    "pooling": "mean",
    "normalize": true
  },
  "scan": { "maxFileBytes": 1048576, "include": [], "exclude": [], "includeHidden": false },
  "search": { "defaultLimit": 10, "maxLimit": 50, "includeStaleByDefault": false }
}
```

- `embedding`: the only supported profile in v0.1. Any change is rejected.
- `scan.include`: optional allowlist of root-relative gitignore-style patterns. When nonempty, a file must match one. Negation (`!`) is not allowed.
- `scan.exclude`: extra gitignore-style exclusions. These can't override hard exclusions or Git ignore rules, and negation is not allowed.
- `scan.maxFileBytes`: 1 to 16 MiB. It is checked before a file is read.
- `scan.includeHidden`: whether ordinary dotfiles and dot-directories are scanned. Hard exclusions apply regardless.
- `search.maxLimit` is at most 50.

Environment variables (the only two): `SEMANTIC_INDEX_CACHE_DIR` (absolute model-cache path, outside the project) and `SEMANTIC_INDEX_OFFLINE=1` (never touch the network). The database path is fixed at `.semantic-index/index.db`.

## The embedding model, cache and offline use

- **Model:** `Xenova/all-MiniLM-L6-v2` at immutable revision `751bff37182d3f1213fa05d7196b954e230abad9`, q8 artifact `onnx/model_quantized.onnx`, 384 dimensions, mean pooling and L2 normalization. It runs on CPU through `@huggingface/transformers` 4.3.2 / `onnxruntime-node` 1.30. The license is Apache-2.0; the weights are downloaded from Hugging Face and **not** shipped in the npm package.
- **Embedding input (v1):** the trimmed description alone for documents, and the trimmed query alone for search. The same tokenizer and pipeline are used for both, with no prefixes and no paths.
- **Limits:** descriptions must be 1–1,200 code points and queries 1–1,000. Both must also fit within **256 model tokens, special tokens included**. Longer text is rejected with `TEXT_TOO_LONG` and the actual token count; it is **never truncated**.
- **Determinism:** each text is inferred on its own, without padding, so a vector doesn't depend on batch composition. Repeated runs on the same machine produce identical vectors. Across CPUs and ONNX Runtime builds, expect cosine ≥ 0.999.
- **Cache location** (per OS user, outside the project): `$XDG_CACHE_HOME/semantic-code-index/models` (default `~/.cache/...`) on Linux, `~/Library/Caches/semantic-code-index/models` on macOS, and `%LOCALAPPDATA%\semantic-code-index\Cache\models` on Windows. Override it with `SEMANTIC_INDEX_CACHE_DIR`. A cache inside the project is rejected. Files are written to a temporary name and then renamed, so a partial download is never mistaken for a complete one, and concurrent first-time downloads are safe.
- **First use:** `model download` fetches the assets and runs a smoke inference. Without it, the first indexing or search call downloads automatically, unless offline mode is set. Status, listing, reconcile and remove never need the model or the network.
- **Offline:** with `SEMANTIC_INDEX_OFFLINE=1`, every network request is refused and only cached files are used. If assets are missing you get `MODEL_NOT_AVAILABLE`, with instructions to run `model download` while online. There is never a fallback to a different model or dtype.

## Git policy, worktrees and branches

- The whole `.semantic-index/` directory (database, WAL/SHM sidecars and temporary files) is Git-ignored by `init`, and must never be committed. If these files are already tracked, `init` warns you. Untrack them yourself with `git rm -r --cached .semantic-index` and commit the change.
- You may commit `.semantic-index.json`, `.mcp.json`, `CLAUDE.md` and `.claude/skills/`. As generated by default, none of them contain absolute paths or secrets.
- Each checkout or **worktree** has its own index. Fresh clones must be indexed again; there is no sync or export in v0.1.
- **Switching branches** is safe. Files that differ show up as stale (or missing), and switching back makes them fresh again, even before you run `reconcile`. Run `reconcile_index` to update the persisted states and drop records of deleted files.
- **Renames** become one removed record plus one unindexed file. Descriptions are never copied across paths automatically.

## File eligibility and path rules

**Scanning.** Inside a Git work tree, files come from `git ls-files --cached --others --exclude-standard -z`, scoped to the root and run without a shell. Tracked files stay eligible even if they match an ignore rule, as in Git. Nested repositories and submodules are not entered. If Git errors, you get `SCAN_FAILED` and there is no fallback traversal. Outside Git, a filesystem walker is used: it never follows links, applies only the **root** `.gitignore` (nested `.gitignore` files and global excludes are not applied in this mode), and reports `scan_mode: "filesystem"`.

**Always excluded:**
- VCS metadata (`.git`, `.hg`, `.svn`, …), `.semantic-index`, `node_modules`, `dist`, `build`, `coverage`, `.next`, `.cache`, `vendor`, `__pycache__` and `.venv` (as directory components, anywhere in the path);
- `.env` and `.env.*`, `*.pem`, `*.key` and other key or keystore files, `id_rsa`, `id_ed25519` and related key files, `.npmrc`, `.pypirc`, `.netrc` and `.aws/credentials`;
- images, archives, databases, binaries, fonts and media;
- `.semantic-index.json`;
- symlinks and junctions, sockets, devices and FIFOs, files larger than `maxFileBytes`, and any file containing a NUL byte or invalid UTF-8.

No exclusion list catches every secret. **Never assume an eligible file is free of sensitive data.**

**Paths.** Paths must be project-relative and use `/`. Absolute, UNC and drive-prefixed paths, `..`, NUL or control characters, and (on POSIX) backslashes are rejected. A symlink in **any** path component is rejected, and the resolved real path must stay inside the root (checked on path components, not string prefixes). Explicit indexing calls go through the same eligibility and ignore checks as scanning. Filename case is preserved. On case-insensitive filesystems (macOS, Windows), a path must use the actual on-disk spelling.

These checks guard against mistakes and ordinary malicious input. They are not a sandbox against a hostile process swapping filesystem entries concurrently, so use the package only in trusted workspaces.

## Failure recovery

| Situation | What to do |
|---|---|
| `NOT_INITIALIZED` | Run `init` from the project root, or pass `--root` |
| `FILE_CHANGED` | Call `get_file` for the new hash, reread the file and resubmit |
| `INDEX_CHANGED` (pagination or concurrent write) | Restart the listing without a cursor, or retry the item |
| `DB_BUSY` | Another process holds the write lock longer than the 5 s busy timeout. Retry. SQLite calls are synchronous and may block up to that timeout |
| `MODEL_NOT_AVAILABLE` | Run `model download` while online (and check `SEMANTIC_INDEX_CACHE_DIR` and `SEMANTIC_INDEX_OFFLINE`) |
| `MODEL_MISMATCH` | The stored vectors come from another profile. Run `reembed`, which keeps descriptions and is all-or-nothing, or `reset --yes` |
| `SCAN_FAILED` during reconcile | Nothing was changed. Fix the Git error or unreadable directories and retry |
| `SCHEMA_UNSUPPORTED` / `DB_ERROR` | The database is never reset automatically. Upgrade the package, or stop all processes, delete `.semantic-index/` and run `init` again |
| Start over | `reset --yes` (keeps configuration and model cache), or delete `.semantic-index/` once all processes have stopped and run `init` |

Concurrency: several agents or processes may share one checkout. Writes are short SQLite transactions with compare-and-swap against the row version read earlier, so you get `INDEX_CHANGED` or `DB_BUSY` instead of a silently lost update. No transaction is held across model inference or a scan. `reset` and `reembed` each run in a single IMMEDIATE transaction, and `reembed` additionally checks the index generation. SQLite's own file locking serializes them against every writer, so there is no separate lock file that could go stale.

## Privacy and security

- Inference and storage are local, and descriptions, queries, code and vectors are never sent anywhere by this package. The only package-initiated network traffic is the model download from `huggingface.co`, restricted to the pinned repository and revision.
- **Your MCP client is a different matter.** It may send descriptions, search results or source files to its own AI provider, and this package can't control that.
- Descriptions and vectors are stored as **plaintext SQLite**. Git-ignoring them is not encryption or access control. Don't index secrets or regulated data without appropriate controls.
- Diagnostic logs never include descriptions, queries, hashes or source paths by default.
- Descriptions are treated purely as data. They are never evaluated, used to build commands, or followed as instructions.

## Limits and limitations

| Limit | Value |
|---|---|
| Index batch | 50 entries |
| Inference | one text at a time, scheduled in sub-batches of 16; concurrency 1 per process |
| List page | default 100, max 200 |
| Search results | default 10, max 50 |
| `maxFileBytes` | default 1 MiB, max 16 MiB |
| Concurrent file reads | 8 |
| CLI batch input | 1 MiB |

- English-oriented model. One description per file. No chunking or function-level entries, no keyword or hybrid search, no watcher, no HTTP transport.
- Search is exact brute force. On the reference laptop, ranking 10,000 vectors takes about 13 ms and 50,000 about 65 ms; see [docs/BENCHMARK.md](docs/BENCHMARK.md).
- Status and reconcile hash every eligible file in scope, so their cost grows with repository size.
- Listings are best-effort pages, not snapshots. Re-list after mutations, and repeat discovery until it's stable.
- An empty search result does not prove a feature is absent. Fall back to grep or code search, especially for exact identifiers.

## Development

```bash
npm ci
npm run build          # clean tsc build to dist/
npm run lint
npm run typecheck
npm test               # unit + integration (real SQLite, deterministic fake embeddings)
npm run test:model     # real model: download, determinism, token limit, offline, recall@5
npm run test:e2e       # builds, then drives the built CLI and MCP server (real model)
npm run bench          # docs/BENCHMARK.md numbers (needs a cached model)
node scripts/pack-smoke.mjs   # npm pack → install tarball in a fresh project → CLI/library/MCP smoke tests
```

The model and e2e suites cache the model in `$TMPDIR/semantic-code-index-test-model-cache`. Set `SEMANTIC_INDEX_TEST_CACHE_DIR` to use a different location. See [docs/IMPLEMENTATION_REPORT.md](docs/IMPLEMENTATION_REPORT.md) for the test results, dependency versions and deviations from the specification.

## Licenses

- Package code: MIT (proposed; subject to owner approval).
- Model `Xenova/all-MiniLM-L6-v2` (an ONNX conversion of `sentence-transformers/all-MiniLM-L6-v2`): Apache-2.0. It is downloaded at runtime, not redistributed.
- Main dependencies: `better-sqlite3` (MIT), `sqlite-vec` (MIT or Apache-2.0), `@huggingface/transformers` (Apache-2.0), `onnxruntime-node` (MIT), `@modelcontextprotocol/server` (Apache-2.0), `zod` (MIT), `commander` (MIT), `ignore` (MIT).
