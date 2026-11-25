/**
 * Reconciliation (spec §9.4). Scans and hashes outside write transactions, never deletes
 * on an incomplete scan or transient I/O error, and revalidates each planned change
 * (filesystem observation + row version) right before committing it.
 */
import { SemanticIndexError } from '../errors.js';
import { LIMITS } from '../config/defaults.js';
import { normalizePrefix } from '../project/paths.js';
import type { Observation } from '../project/scanner.js';
import { versionOf, type FileRow, type ReconcileAction } from '../storage/repository.js';
import type { ReconcileResult, SampleList } from '../types.js';
import { BoundedList, checkAborted, finalizeWarnings, type ServiceContext } from './context.js';

type Planned = { action: ReconcileAction; category: 'marked_stale' | 'restored_fresh' | 'removed_missing' | 'removed_ineligible' };

/** Decide the action for a row given an observation; null means unchanged/keep. */
function plan(row: FileRow, o: Observation): Planned | 'unchanged' | 'unavailable' {
  const expected = versionOf(row);
  switch (o.state) {
    case 'unavailable':
      return 'unavailable';
    case 'missing':
      return { action: { kind: 'delete', path: row.path, expected }, category: 'removed_missing' };
    case 'ineligible':
      return { action: { kind: 'delete', path: row.path, expected }, category: 'removed_ineligible' };
    case 'eligible':
      if (o.hash === row.content_hash) {
        if (row.state === 'indexed' && row.observed_hash === row.content_hash) return 'unchanged';
        return { action: { kind: 'restore', path: row.path, expected }, category: 'restored_fresh' };
      }
      if (row.state === 'stale' && row.observed_hash === o.hash) return 'unchanged';
      return { action: { kind: 'mark_stale', path: row.path, expected, observed_hash: o.hash }, category: 'marked_stale' };
  }
}

function sameAction(a: ReconcileAction, b: ReconcileAction): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'mark_stale' && b.kind === 'mark_stale') return a.observed_hash === b.observed_hash;
  return true;
}

export async function reconcileIndex(ctx: ServiceContext, req: unknown, signal?: AbortSignal): Promise<ReconcileResult> {
  if (req !== undefined && req !== null && (typeof req !== 'object' || Array.isArray(req))) throw new SemanticIndexError('INVALID_INPUT', 'Request must be an object.');
  const r = (req ?? {}) as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => k !== 'path_prefix' && k !== 'dry_run');
  if (unknown.length > 0) throw new SemanticIndexError('INVALID_INPUT', `Unknown parameters: ${unknown.slice(0, 5).join(', ')}.`);
  if (r.dry_run !== undefined && typeof r.dry_run !== 'boolean') throw new SemanticIndexError('INVALID_INPUT', 'dry_run must be a boolean.');
  const dryRun = r.dry_run === true;
  const prefix = normalizePrefix(r.path_prefix);
  ctx.project.fresh();

  const scan = await ctx.project.scan(prefix, signal);
  if (!scan.complete) {
    throw new SemanticIndexError('SCAN_FAILED', 'The scan was incomplete (unreadable directories); no records were changed. Fix permissions and retry.', {
      retryable: true,
      details: { warnings: scan.warnings.slice(0, 10) }
    });
  }
  const scanned = new Set(scan.paths);
  const rows = ctx.repo.rowsInPrefix(prefix);
  const rowPaths = new Set(rows.map((x) => x.path));
  const obs = await ctx.project.observe([...new Set([...scan.paths, ...rowPaths])], scanned, signal);

  const S = () => new BoundedList(LIMITS.sampleMax);
  const samples = {
    unindexed: S(),
    marked_stale: S(),
    restored_fresh: S(),
    removed_missing: S(),
    removed_ineligible: S(),
    unavailable: S(),
    conflicts: S()
  };
  const counts = { unindexed: 0, marked_stale: 0, restored_fresh: 0, removed_missing: 0, removed_ineligible: 0, unchanged: 0, unavailable: 0, conflicts: 0 };

  for (const p of scan.paths) {
    if (rowPaths.has(p)) continue;
    const o = obs.get(p)!;
    if (o.state === 'eligible') {
      counts.unindexed++;
      samples.unindexed.push(p);
    } else if (o.state === 'unavailable') {
      counts.unavailable++;
      samples.unavailable.push(p);
    }
  }

  const planned: Planned[] = [];
  for (const row of rows) {
    const decision = plan(row, obs.get(row.path)!);
    if (decision === 'unchanged') counts.unchanged++;
    else if (decision === 'unavailable') {
      counts.unavailable++;
      samples.unavailable.push(row.path);
    } else planned.push(decision);
  }

  if (dryRun) {
    for (const p of planned) {
      counts[p.category]++;
      samples[p.category].push(p.action.path);
    }
  } else {
    const chunkSize = LIMITS.indexBatchMax;
    for (let i = 0; i < planned.length; i += chunkSize) {
      checkAborted(signal);
      const chunk = planned.slice(i, i + chunkSize);
      // Revalidate the filesystem observation right before committing.
      const fresh = await ctx.project.observe(chunk.map((p) => p.action.path), undefined, signal);
      const confirmed: Planned[] = [];
      for (const p of chunk) {
        const row = ctx.repo.getRow(p.action.path);
        const again = row ? plan(row, fresh.get(p.action.path)!) : 'unchanged';
        if (typeof again === 'object' && sameAction(again.action, p.action) && again.category === p.category) confirmed.push(p);
        else {
          counts.conflicts++;
          samples.conflicts.push(p.action.path);
        }
      }
      if (confirmed.length === 0) continue;
      const applied = ctx.repo.applyReconcile(confirmed.map((p) => p.action), new Date().toISOString());
      confirmed.forEach((p, k) => {
        if (applied[k]) {
          counts[p.category]++;
          samples[p.category].push(p.action.path);
        } else {
          counts.conflicts++;
          samples.conflicts.push(p.action.path);
        }
      });
    }
  }

  const toSample = (b: BoundedList): SampleList => ({ paths: b.items, omitted_count: b.omitted });
  const warnings = [...scan.warnings];
  if (counts.unavailable > 0) warnings.push(`${counts.unavailable} path(s) could not be inspected; their records were kept.`);
  if (counts.conflicts > 0) warnings.push(`${counts.conflicts} change(s) conflicted with concurrent activity and were skipped; run reconcile again.`);
  return {
    dry_run: dryRun,
    complete: counts.conflicts === 0,
    scan_mode: scan.mode,
    ...counts,
    samples: {
      unindexed: toSample(samples.unindexed),
      marked_stale: toSample(samples.marked_stale),
      restored_fresh: toSample(samples.restored_fresh),
      removed_missing: toSample(samples.removed_missing),
      removed_ineligible: toSample(samples.removed_ineligible),
      unavailable: toSample(samples.unavailable),
      conflicts: toSample(samples.conflicts)
    },
    warnings: finalizeWarnings(warnings)
  };
}
