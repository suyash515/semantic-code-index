#!/usr/bin/env node
/**
 * Reproducible benchmark (spec §17.2). Requires `npm run build` and a cached model
 * (`semantic-code-index model download`, or SEMANTIC_INDEX_CACHE_DIR pointing to one).
 *
 * Usage: node scripts/bench.mjs [sizes=1000,10000] [--keep]
 * Generates synthetic files, synthetic normalized vectors and descriptions in a temp project,
 * then measures each stage separately. Prints a Markdown report to stdout.
 */
import { mkdtempSync, mkdirSync, writeFileSync, statSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const { initializeProject, openSemanticIndex } = await import(path.join(dist, 'index.js'));
const { openDatabase } = await import(path.join(dist, 'storage/connection.js'));
const { Repository } = await import(path.join(dist, 'storage/repository.js'));
const { encodeVector, validateAndNormalize } = await import(path.join(dist, 'storage/vector-codec.js'));
const { canonicalProfileJson, DEFAULT_EMBEDDING_PROFILE } = await import(path.join(dist, 'config/defaults.js'));
const { Project } = await import(path.join(dist, 'project/scanner.js'));
const { loadConfig } = await import(path.join(dist, 'config/load.js'));
const { TransformersEmbeddingProvider } = await import(path.join(dist, 'embeddings/transformers-provider.js'));
const { resolveCacheDir } = await import(path.join(dist, 'embeddings/cache.js'));

const args = process.argv.slice(2);
const sizes = (args.find((a) => /^\d/.test(a)) ?? '1000,10000').split(',').map(Number);
const keep = args.includes('--keep');
const pkg = JSON.parse(readFileSync(path.resolve(dist, '../package.json'), 'utf8'));

function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];
const ms = (x) => `${x.toFixed(1)} ms`;
const mib = (b) => `${(b / 1024 / 1024).toFixed(2)} MiB`;
async function time(fn) {
  const t = performance.now();
  const r = await fn();
  return [performance.now() - t, r];
}
function fileSize(p) {
  try {
    return statSync(p).size;
  } catch {
    return 0;
  }
}

const cacheDir = resolveCacheDir(null).dir;
const lines = [];
const out = (s = '') => lines.push(s);

out(`# semantic-code-index benchmark`);
out();
out(`- Date: ${new Date().toISOString()}`);
out(`- Package: ${pkg.name}@${pkg.version}; Node ${process.version}; ${os.platform()} ${os.release()} ${os.arch()}`);
out(`- CPU: ${os.cpus()[0]?.model ?? 'unknown'} × ${os.cpus().length}; RAM ${mib(os.totalmem())}`);
out(`- Dependencies: ${['better-sqlite3', 'sqlite-vec', '@huggingface/transformers', '@modelcontextprotocol/server', 'zod'].map((d) => `${d}@${pkg.dependencies[d]}`).join(', ')}`);
out(`- Model: ${DEFAULT_EMBEDDING_PROFILE.model}@${DEFAULT_EMBEDDING_PROFILE.revision.slice(0, 12)} dtype=${DEFAULT_EMBEDDING_PROFILE.dtype}`);
out();

// ---- Model: cold init and warm embedding ----
const provider = new TransformersEmbeddingProvider({ cacheDir, offline: true });
const [coldInit] = await time(() => provider.embed(['cold start']));
const warm = [];
for (let i = 0; i < 30; i++) warm.push((await time(() => provider.embed([`warm query number ${i} about payments and invoices`])))[0]);
const batch16 = (await time(() => provider.embed(Array.from({ length: 16 }, (_, i) => `description ${i} of a typical source file handling orders and payments for customers`))))[0];
out(`## Model`);
out();
out(`| Stage | Time |`);
out(`|---|---|`);
out(`| Cold model initialization + first embedding (cached assets, offline) | ${ms(coldInit)} |`);
out(`| Warm single query embedding (median / p95 of 30) | ${ms(median(warm))} / ${ms(p95(warm))} |`);
out(`| Warm 16-description sub-batch | ${ms(batch16)} |`);
out();

out(`## Index size scaling`);
out();
out(`| Files | Insert vectors | SQL ranking (warm median / p95, 20 runs) | FS verification of 10 candidates | Full reconcile (warm) | Status | Total search (warm median) | DB + WAL on disk | RSS |`);
out(`|---|---|---|---|---|---|---|---|---|`);

for (const n of sizes) {
  const root = mkdtempSync(path.join(os.tmpdir(), `sci-bench-${n}-`));
  const rand = rng(n);
  const files = [];
  for (let i = 0; i < n; i++) {
    const rel = `src/m${String(Math.floor(i / 100)).padStart(4, '0')}/f${String(i).padStart(6, '0')}.ts`;
    const content = `export const value${i} = ${i};\n`;
    mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
    writeFileSync(path.join(root, rel), content);
    files.push({ rel, hash: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content) });
  }
  await initializeProject({ root });
  const db = await openDatabase(root, { create: false });
  const repo = new Repository(db);
  const profile = canonicalProfileJson(DEFAULT_EMBEDDING_PROFILE);
  const [insertMs] = await time(async () => {
    for (let i = 0; i < n; i += 500) {
      const writes = files.slice(i, i + 500).map((f, k) => {
        const v = validateAndNormalize(Array.from({ length: 384 }, () => rand()), 384);
        return { path: f.rel, expected: null, description: `Synthetic description ${i + k} for benchmarking semantic search over generated files.`, content_hash: f.hash, size_bytes: f.size, language: 'typescript', embedding: encodeVector(v, 384) };
      });
      repo.applyIndexWrites(writes, profile, new Date().toISOString());
    }
  });
  const q = encodeVector(validateAndNormalize(Array.from({ length: 384 }, () => rand()), 384), 384);
  repo.searchBatch(q, null, null, 20); // warm
  const sql = [];
  for (let i = 0; i < 20; i++) sql.push((await time(async () => repo.searchBatch(q, null, null, 20)))[0]);
  db.close();

  const config = await loadConfig(root);
  const project = new Project(root, config);
  const [verifyMs] = await time(() => project.fresh().observe(files.slice(0, 10).map((f) => f.rel)));

  const index = await openSemanticIndex({ root, embeddingProvider: provider });
  await index.reconcileIndex({ dry_run: true }); // warm filesystem cache
  const [reconcileMs, rec] = await time(() => index.reconcileIndex());
  if (rec.unchanged !== n) throw new Error(`reconcile mismatch: ${JSON.stringify(rec)}`);
  const [statusMs] = await time(() => index.getIndexStatus());
  await index.searchFiles({ query: 'warm up search', limit: 10 });
  const total = [];
  for (let i = 0; i < 10; i++) total.push((await time(() => index.searchFiles({ query: `where are invoices generated ${i}`, limit: 10 })))[0]);
  await index.close();
  const dbFile = path.join(root, '.semantic-index', 'index.db');
  const disk = fileSize(dbFile) + fileSize(`${dbFile}-wal`) + fileSize(`${dbFile}-shm`);
  out(`| ${n.toLocaleString('en')} | ${ms(insertMs)} | ${ms(median(sql))} / ${ms(p95(sql))} | ${ms(verifyMs)} | ${ms(reconcileMs)} | ${ms(statusMs)} | ${ms(median(total))} | ${mib(disk)} | ${mib(process.memoryUsage().rss)} |`);
  if (!keep) rmSync(root, { recursive: true, force: true });
}
await provider.close();
out();
out(`Notes: vectors and descriptions are synthetic; files are tiny generated TypeScript files in a non-Git temp directory (filesystem scan mode). "SQL ranking" is exact brute-force \`vec_distance_cosine\` over all rows (first 20 results, scope = whole project), excluding embedding and disk verification. "Total search" includes query embedding, ranking and freshness verification. Raw vector payload is 1,536 bytes per file.`);
process.stdout.write(`${lines.join('\n')}\n`);
