# semantic-code-index benchmark

- Date: 2026-11-25T17:43:01.853Z
- Package: semantic-code-index@0.1.0; Node v22.16.0; linux 6.2.0-39-generic x64
- CPU: AMD Ryzen 5 5600U with Radeon Graphics × 12; RAM 31392.80 MiB
- Dependencies: better-sqlite3@13.2.0, sqlite-vec@0.1.9, @huggingface/transformers@4.3.2, @modelcontextprotocol/server@2.4.0, zod@4.6.7
- Model: Xenova/all-MiniLM-L6-v2@751bff37182d dtype=q8

## Model

| Stage | Time |
|---|---|
| Cold model initialization + first embedding (cached assets, offline) | 273.1 ms |
| Warm single query embedding (median / p95 of 30) | 2.8 ms / 11.4 ms |
| Warm 16-description sub-batch | 65.4 ms |

## Index size scaling

| Files | Insert vectors | SQL ranking (warm median / p95, 20 runs) | FS verification of 10 candidates | Full reconcile (warm) | Status | Total search (warm median) | DB + WAL on disk | RSS |
|---|---|---|---|---|---|---|---|---|
| 1,000 | 46.0 ms | 0.7 ms / 0.8 ms | 12.0 ms | 88.5 ms | 157.4 ms | 19.2 ms | 2.02 MiB | 215.31 MiB |
| 10,000 | 479.0 ms | 12.6 ms / 15.2 ms | 11.6 ms | 599.2 ms | 622.2 ms | 47.4 ms | 20.07 MiB | 292.16 MiB |
| 50,000 | 2240.5 ms | 65.5 ms / 84.6 ms | 15.3 ms | 3212.8 ms | 3814.6 ms | 107.0 ms | 100.31 MiB | 422.56 MiB |

Notes: vectors and descriptions are synthetic; files are tiny generated TypeScript files in a non-Git temp directory (filesystem scan mode). "SQL ranking" is exact brute-force `vec_distance_cosine` over all rows (first 20 results, scope = whole project), excluding embedding and disk verification. "Total search" includes query embedding, ranking and freshness verification. Raw vector payload is 1,536 bytes per file.
