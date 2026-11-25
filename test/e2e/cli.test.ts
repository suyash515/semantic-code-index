/** Built CLI end-to-end with the real local model (requires a cached model or network on first run). */
import { beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { makeProject } from '../helpers/fixtures.js';
import { cliEnv, runCli } from '../helpers/e2e.js';
import { createHash } from 'node:crypto';

let root: string;
const hash = (rel: string) => createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');

beforeAll(async () => {
  root = makeProject({ 'billing/invoice.py': 'def invoice(): pass\n', 'auth/session.go': 'package auth\n', 'logs/logger.rb': 'class Logger; end\n', 'Makefile': 'all:\n' });
  const init = await runCli(['init', '--json'], { cwd: root });
  expect(init.code).toBe(0);
  expect(JSON.parse(init.stdout).ok).toBe(true);
}, 120_000);

describe('CLI', () => {
  it('init --claude --instructions --skills writes integration files and is idempotent', async () => {
    const proj = makeProject({ 'CLAUDE.md': '# Team notes\n' });
    const first = await runCli(['init', '--claude', '--instructions', '--skills', '--json'], { cwd: proj });
    expect(first.code).toBe(0);
    const r1 = JSON.parse(first.stdout);
    expect(r1.steps.filter((s: { step: string }) => s.step === 'skills').map((s: { file: string; status: string }) => `${s.status} ${s.file}`)).toEqual([
      'created .claude/skills/semantic-search/SKILL.md',
      'created .claude/skills/semantic-index/SKILL.md',
      'created .claude/skills/semantic-sync/SKILL.md'
    ]);
    expect(readFileSync(path.join(proj, '.claude/skills/semantic-index/SKILL.md'), 'utf8')).toMatch(/^---\nname: semantic-index\n/);
    expect(readFileSync(path.join(proj, 'CLAUDE.md'), 'utf8')).toMatch(/^# Team notes\n[\s\S]*semantic-search/);
    const second = await runCli(['init', '--claude', '--instructions', '--skills', '--json'], { cwd: proj });
    expect(second.code).toBe(0);
    expect(JSON.parse(second.stdout).steps.every((s: { status: string }) => s.status === 'unchanged')).toBe(true);
    const human = await runCli(['init', '--skills'], { cwd: proj });
    expect(human.stdout).toMatch(/unchanged\s+skills\s+\.claude\/skills\/semantic-sync\/SKILL\.md/);
  });

  it('model download, then batch index from stdin, search, get, list, reconcile, reembed, reset', async () => {
    expect((await runCli(['model', 'download', '--json'], { cwd: root })).code).toBe(0);
    const list = JSON.parse((await runCli(['list-unindexed', '--json', '--limit', '10'], { cwd: root })).stdout);
    expect(list.scan_mode).toBe('filesystem');
    expect(list.files.map((f: { path: string }) => f.path)).toEqual(['Makefile', 'auth/session.go', 'billing/invoice.py', 'logs/logger.rb']);

    const descs: Record<string, string> = {
      Makefile: 'Build automation targets for compiling the project.',
      'auth/session.go': 'Creates and validates authenticated user sessions after login.',
      'billing/invoice.py': 'Generates customer invoices and calculates amounts due for billing.',
      'logs/logger.rb': 'Writes structured application log messages to files.'
    };
    const input = JSON.stringify({ files: list.files.map((f: { path: string; current_hash: string }) => ({ path: f.path, description: descs[f.path], expected_hash: f.current_hash })) });
    const batch = await runCli(['index-batch', '--input', '-', '--json'], { cwd: root, input });
    expect(batch.code).toBe(0);
    expect(JSON.parse(batch.stdout)).toMatchObject({ created: 4, failed: 0 });

    const search = await runCli(['search', 'where are invoices generated', '--limit', '1', '--json'], { cwd: root });
    expect(search.code).toBe(0);
    expect(JSON.parse(search.stdout).results[0].path).toBe('billing/invoice.py');
    const human = await runCli(['search', 'user login session'], { cwd: root });
    expect(human.stdout).toMatch(/auth\/session\.go/);

    const got = JSON.parse((await runCli(['--json', 'get', 'auth/session.go'], { cwd: root })).stdout);
    expect(got.state).toBe('indexed');

    writeFileSync(path.join(root, 'logs/logger.rb'), 'class Logger; def info; end; end\n');
    const stale = JSON.parse((await runCli(['list-stale', '--json'], { cwd: root })).stdout);
    expect(stale.files.map((f: { path: string }) => f.path)).toEqual(['logs/logger.rb']);
    const single = await runCli(['index', 'logs/logger.rb', '--description', descs['logs/logger.rb']!, '--expected-hash', hash('logs/logger.rb'), '--json'], { cwd: root });
    expect(JSON.parse(single.stdout).results[0].status).toBe('updated');

    const dry = await runCli(['reconcile', '--dry-run', '--json'], { cwd: root });
    expect(JSON.parse(dry.stdout)).toMatchObject({ dry_run: true, unchanged: 4 });
    const re = await runCli(['reembed', '--json'], { cwd: root });
    expect(JSON.parse(re.stdout).reembedded).toBe(4);
    const status = JSON.parse((await runCli(['status', '--json'], { cwd: root })).stdout);
    expect(status).toMatchObject({ fresh: 4, coverage: 1 });

    const noYes = await runCli(['reset', '--json'], { cwd: root });
    expect(noYes.code).toBe(2);
    expect(JSON.parse(noYes.stdout).error.code).toBe('INVALID_INPUT');
    const reset = await runCli(['reset', '--yes', '--json'], { cwd: root });
    expect(JSON.parse(reset.stdout)).toEqual({ removed: 4 });
  });

  it('exit code 1 on partial batch failure; 2 on invalid input; --root works from another cwd', async () => {
    const h = hash('Makefile');
    const input = JSON.stringify({ files: [{ path: 'Makefile', description: 'Build targets.', expected_hash: h }, { path: 'nope.txt', description: 'x', expected_hash: h }] });
    const r = await runCli(['--root', root, 'index-batch', '--input', '-', '--json'], { cwd: '/', input });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout)).toMatchObject({ total: 2, failed: 1 });
    const bad = await runCli(['index-batch', '--input', '-'], { cwd: root, input: '{"files":[{"path":"a"}]}' });
    expect(bad.code).toBe(2);
    expect((await runCli(['index-batch', '--input', '-'], { cwd: root, input: 'x'.repeat(1024 * 1024 + 10) })).code).toBe(2);
    expect((await runCli(['search', 'x', '--min-score', '5'], { cwd: root })).code).toBe(2);
  });

  it('offline mode works after download; missing cache gives MODEL_NOT_AVAILABLE', async () => {
    const ok = await runCli(['search', 'billing invoices', '--json'], { cwd: root, env: cliEnv({ SEMANTIC_INDEX_OFFLINE: '1' }) });
    expect(ok.code).toBe(0);
    const empty = makeProject();
    const missing = await runCli(['search', 'billing invoices', '--json'], { cwd: root, env: cliEnv({ SEMANTIC_INDEX_OFFLINE: '1', SEMANTIC_INDEX_CACHE_DIR: path.join(empty, '..', `${path.basename(empty)}-cache`) }) });
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout).error.code).toBe('MODEL_NOT_AVAILABLE');
    // status works without any model
    expect((await runCli(['status'], { cwd: root, env: cliEnv({ SEMANTIC_INDEX_OFFLINE: '1', SEMANTIC_INDEX_CACHE_DIR: '/nonexistent-cache' }) })).code).toBe(0);
  });
});
