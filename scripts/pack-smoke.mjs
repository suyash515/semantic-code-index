#!/usr/bin/env node
/**
 * Release validation: npm pack → install the tarball into a fresh fixture project (no dev
 * sources) → run init/status/model/index/search/MCP smoke tests via the installed binary.
 * Uses SEMANTIC_INDEX_CACHE_DIR if set (to reuse a downloaded model). Exits nonzero on failure.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const work = mkdtempSync(path.join(os.tmpdir(), 'sci-pack-'));
const log = (m) => process.stderr.write(`[pack-smoke] ${m}\n`);
const check = (cond, msg) => {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
  log(`ok - ${msg}`);
};

try {
  const packOut = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', work], { cwd: repo, encoding: 'utf8', shell: process.platform === 'win32' }));
  const { filename, files, size } = packOut[0];
  const names = files.map((f) => f.path);
  log(`tarball ${filename} (${size} bytes, ${names.length} files)`);
  check(names.includes('dist/cli.js') && names.includes('dist/index.js') && names.includes('dist/index.d.ts'), 'tarball contains compiled CLI, library and declarations');
  check(names.includes('README.md') && names.includes('LICENSE') && names.includes('package.json'), 'tarball contains README, LICENSE, package.json');
  check(!names.some((n) => /^(src|test|scripts)\//.test(n) || /\.(db|onnx|tgz)$/.test(n) || n.includes('.semantic-index')), 'tarball has no sources, tests, databases or model weights');

  const app = path.join(work, 'app');
  mkdirSync(path.join(app, 'src'), { recursive: true });
  writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'fixture-app', version: '1.0.0', private: true, type: 'module' }, null, 2));
  writeFileSync(path.join(app, 'src', 'payments.js'), 'export function chargeCard() {}\n');
  writeFileSync(path.join(app, 'src', 'auth.js'), 'export function login() {}\n');
  execFileSync('git', ['init', '-q'], { cwd: app });
  execFileSync(npm, ['install', '--save-dev', '--no-audit', '--no-fund', path.join(work, filename)], { cwd: app, stdio: 'inherit', shell: process.platform === 'win32' });

  const env = { ...process.env };
  const run = (args, input) => {
    try {
      const stdout = execFileSync(npx, ['--no-install', 'semantic-code-index', ...args], { cwd: app, env, encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
      return { code: 0, stdout };
    } catch (e) {
      return { code: e.status, stdout: String(e.stdout ?? ''), stderr: String(e.stderr ?? '') };
    }
  };

  check(run(['--version']).stdout.trim() === JSON.parse(readFileSync(path.join(repo, 'package.json'), 'utf8')).version, 'installed binary reports the package version');
  check(run(['status']).code === 1, 'status before init returns NOT_INITIALIZED (exit 1)');
  const init = JSON.parse(run(['init', '--claude', '--instructions', '--skills', '--json']).stdout);
  check(init.ok, 'init --claude --instructions --skills succeeds');
  check(readFileSync(path.join(app, '.gitignore'), 'utf8').includes('/.semantic-index/'), '.gitignore contains /.semantic-index/');
  check(!readFileSync(path.join(app, '.mcp.json'), 'utf8').includes(work), '.mcp.json contains no absolute paths');
  check(readFileSync(path.join(app, 'CLAUDE.md'), 'utf8').includes('semantic-code-index:start'), 'CLAUDE.md block merged');
  for (const skill of ['semantic-search', 'semantic-index', 'semantic-sync']) {
    const text = readFileSync(path.join(app, '.claude', 'skills', skill, 'SKILL.md'), 'utf8');
    check(text.startsWith(`---\nname: ${skill}\n`) && !text.includes(work), `skill ${skill} installed without absolute paths`);
  }
  check(JSON.parse(run(['init', '--claude', '--instructions', '--skills', '--json']).stdout).steps.every((s) => s.status === 'unchanged'), 'init rerun is idempotent');
  const status = JSON.parse(run(['status', '--json']).stdout);
  check(status.eligible === 5 && status.scan_mode === 'git', `status works without a model (eligible=${status.eligible})`);
  check(run(['model', 'download']).code === 0, 'model download + smoke inference');

  const list = JSON.parse(run(['list-unindexed', '--json']).stdout);
  const descs = { 'CLAUDE.md': 'Agent instructions for using the semantic index.', 'src/auth.js': 'Authenticates users with passwords and starts login sessions.', 'src/payments.js': 'Charges customer credit cards and handles declined payments.' };
  const batch = { files: list.files.map((f) => ({ path: f.path, description: descs[f.path] ?? 'Project file.', expected_hash: f.current_hash })) };
  const indexed = JSON.parse(run(['index-batch', '--input', '-', '--json'], JSON.stringify(batch)).stdout);
  check(indexed.failed === 0 && indexed.created === list.files.length, `indexed ${indexed.created} files`);
  const search = JSON.parse(run(['search', 'where are card payments charged', '--limit', '1', '--json']).stdout);
  check(search.results[0]?.path === 'src/payments.js', 'search returns the payments file first');
  const offline = run(['search', 'user login', '--json'], undefined);
  check(offline.code === 0, 'search succeeds');

  // Library import has no side effects and exposes the API.
  const lib = execFileSync(process.execPath, ['--input-type=module', '-e', "const m = await import('semantic-code-index'); console.log(JSON.stringify(Object.keys(m).sort()))"], { cwd: path.join(app, 'src'), encoding: 'utf8' });
  check(JSON.parse(lib).includes('openSemanticIndex') && JSON.parse(lib).includes('initializeProject'), 'library exports openSemanticIndex / initializeProject');
  check(!existsSync(path.join(app, 'src', '.semantic-index')), 'importing the library creates nothing');

  // MCP smoke via the exact registered command (npx --no-install semantic-code-index mcp).
  const mcpCfg = JSON.parse(readFileSync(path.join(app, '.mcp.json'), 'utf8')).mcpServers['semantic-code-index'];
  const child = spawn(process.platform === 'win32' ? 'npx.cmd' : mcpCfg.command, mcpCfg.args, { cwd: app, env, stdio: ['pipe', 'pipe', 'pipe'], shell: process.platform === 'win32' });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  const send = (m) => child.stdin.write(`${JSON.stringify(m)}\n`);
  const waitFor = async (pred, ms) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const msgs = out.split('\n').filter(Boolean).map((l) => JSON.parse(l));
      const hit = msgs.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('MCP response timeout');
  };
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'pack-smoke', version: '1' } } });
  const initRes = await waitFor((m) => m.id === 1, 20000);
  check(initRes.result.serverInfo.name === 'semantic-code-index', 'MCP initialize');
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const tools = await waitFor((m) => m.id === 2, 10000);
  check(tools.result.tools.length === 9, 'MCP tools/list returns 9 tools');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_files', arguments: { query: 'login sessions', limit: 1 } } });
  const call = await waitFor((m) => m.id === 3, 20000);
  check(call.result.structuredContent.results[0].path === 'src/auth.js', 'MCP search_files');
  const exited = new Promise((r) => child.on('exit', r));
  child.stdin.end();
  check((await exited) === 0, 'MCP server exits cleanly when stdin closes');
  check(out.split('\n').filter(Boolean).every((l) => JSON.parse(l).jsonrpc === '2.0'), 'MCP stdout contains only JSON-RPC');

  const hashOk = createHash('sha256').update(readFileSync(path.join(app, 'src/payments.js'))).digest('hex') === search.results[0].current_hash;
  check(hashOk, 'search current_hash matches file bytes');
  log('ALL CHECKS PASSED');
} finally {
  if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
  else log(`kept ${work}`);
}
