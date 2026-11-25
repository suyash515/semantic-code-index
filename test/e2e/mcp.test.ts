/** Launches the built CLI `mcp` command as a child process and drives it with the official MCP client. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { makeProject } from '../helpers/fixtures.js';
import { CLI, cliEnv, runCli } from '../helpers/e2e.js';

const TOOLS = ['get_file', 'get_index_status', 'index_file', 'index_files', 'list_stale_files', 'list_unindexed_files', 'reconcile_index', 'remove_file', 'search_files'];

let root: string;
let client: Client;
let transport: StdioClientTransport;
let stderr = '';
const hash = (rel: string) => createHash('sha256').update(readFileSync(path.join(root, rel))).digest('hex');

type ToolOut = { isError?: boolean; structuredContent?: Record<string, unknown>; content: { type: string; text?: string }[] };
async function call(name: string, args: Record<string, unknown> = {}): Promise<ToolOut> {
  const r = (await client.callTool({ name, arguments: args })) as ToolOut;
  // text content mirrors structured content
  expect(JSON.parse(r.content[0]!.text!)).toEqual(r.structuredContent);
  return r;
}

beforeAll(async () => {
  root = makeProject(
    {
      'src/payments/charge.ts': 'export function charge() { /* stripe */ }\n',
      'src/auth/login.ts': 'export function login() {}\n',
      'src/inventory/stock.ts': 'export const stock = 1;\n',
      'README.md': '# Shop\n'
    },
    { git: true }
  );
  expect((await runCli(['init'], { cwd: root })).code).toBe(0);
  expect((await runCli(['model', 'download'], { cwd: root })).code).toBe(0);
  transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], cwd: root, env: cliEnv(), stderr: 'pipe' });
  transport.stderr?.on('data', (d) => (stderr += d));
  client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);
}, 300_000);

afterAll(async () => {
  await client?.close();
});

describe('MCP stdio server', () => {
  it('advertises the tool catalog with schemas and annotations; no reset/sql/shell tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const t of tools) {
      expect(t.description!.length).toBeGreaterThan(40);
      expect(t.inputSchema.type).toBe('object');
      expect(t.outputSchema).toBeDefined();
    }
    const by = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(by.search_files!.annotations).toMatchObject({ readOnlyHint: true });
    expect(by.get_index_status!.annotations).toMatchObject({ readOnlyHint: true });
    expect(by.remove_file!.annotations).toMatchObject({ destructiveHint: true });
    expect(by.reconcile_index!.annotations).toMatchObject({ destructiveHint: true });
    expect(by.index_files!.inputSchema).toMatchObject({ additionalProperties: false });
    expect(client.getServerVersion()).toMatchObject({ name: 'semantic-code-index', version: '0.1.0' });
  });

  it('full workflow: status → list → index → search → get → stale → reconcile → remove', async () => {
    const status = await call('get_index_status');
    expect(status.structuredContent).toMatchObject({ eligible: 4, unindexed: 4, scan_mode: 'git', model_compatible: true });

    const page = await call('list_unindexed_files', { limit: 200 });
    const files = page.structuredContent!.files as { path: string; current_hash: string }[];
    expect(files.map((f) => f.path)).toEqual(['README.md', 'src/auth/login.ts', 'src/inventory/stock.ts', 'src/payments/charge.ts']);

    const descriptions: Record<string, string> = {
      'README.md': 'Project overview for the online shop.',
      'src/auth/login.ts': 'Authenticates users with passwords and creates login sessions.',
      'src/inventory/stock.ts': 'Tracks warehouse inventory stock levels for products.',
      'src/payments/charge.ts': 'Charges customer credit cards through Stripe and handles declined payments.'
    };
    const batch = await call('index_files', { files: files.map((f) => ({ path: f.path, description: descriptions[f.path], expected_hash: f.current_hash })) });
    expect(batch.isError).toBeFalsy();
    expect(batch.structuredContent).toMatchObject({ total: 4, created: 4, failed: 0 });

    const search = await call('search_files', { query: 'Where are failed credit card payments handled?', limit: 2 });
    const results = search.structuredContent!.results as { path: string; score: number }[];
    expect(results[0]!.path).toBe('src/payments/charge.ts');
    expect(results.length).toBe(2);
    expect(JSON.stringify(search.structuredContent)).not.toContain(root);

    const got = await call('get_file', { path: 'src/auth/login.ts' });
    expect(got.structuredContent).toMatchObject({ state: 'indexed', record: { description: descriptions['src/auth/login.ts'] } });

    writeFileSync(path.join(root, 'src/auth/login.ts'), 'export function login(mfa) {}\n');
    const stale = await call('list_stale_files');
    expect((stale.structuredContent!.files as { path: string }[]).map((f) => f.path)).toEqual(['src/auth/login.ts']);
    const reaffirm = await call('index_file', { path: 'src/auth/login.ts', description: descriptions['src/auth/login.ts'], expected_hash: hash('src/auth/login.ts') });
    expect(reaffirm.structuredContent).toMatchObject({ status: 'updated' });

    unlinkSync(path.join(root, 'README.md'));
    const dry = await call('reconcile_index', { dry_run: true });
    expect(dry.structuredContent).toMatchObject({ dry_run: true, removed_missing: 1 });
    const rec = await call('reconcile_index', {});
    expect(rec.structuredContent).toMatchObject({ dry_run: false, removed_missing: 1, complete: true });

    expect((await call('remove_file', { path: 'src/inventory/stock.ts' })).structuredContent).toEqual({ path: 'src/inventory/stock.ts', removed: true });
    expect((await call('remove_file', { path: 'src/inventory/stock.ts' })).structuredContent).toEqual({ path: 'src/inventory/stock.ts', removed: false });
  });

  it('returns isError with stable error payloads', async () => {
    const changed = await call('index_file', { path: 'src/payments/charge.ts', description: 'x', expected_hash: 'a'.repeat(64) });
    expect(changed.isError).toBe(true);
    expect(changed.structuredContent).toMatchObject({ status: 'failed', error: { code: 'FILE_CHANGED', retryable: true } });

    const notFound = await call('get_file', { path: 'nope.ts' });
    expect(notFound.isError).toBe(true);
    expect(notFound.structuredContent).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String), retryable: false } });

    const badPath = await call('get_file', { path: '../../etc/passwd' });
    expect(badPath.structuredContent).toMatchObject({ error: { code: 'INVALID_PATH' } });

    const badCursor = await call('list_unindexed_files', { cursor: 'nope' });
    expect(badCursor.structuredContent).toMatchObject({ error: { code: 'INVALID_CURSOR' } });

    // Schema-invalid arguments are rejected by the SDK before reaching the service.
    const schemaInvalid = (await client.callTool({ name: 'search_files', arguments: { query: 'x', limit: 999 } })) as ToolOut;
    expect(schemaInvalid.isError).toBe(true);
    const extraKey = (await client.callTool({ name: 'get_file', arguments: { path: 'a', sneaky: 1 } })) as ToolOut;
    expect(extraKey.isError).toBe(true);
  });

  it('keeps logs off stdout (stderr only) and leaks no absolute paths in errors', async () => {
    expect(stderr).not.toMatch(/"jsonrpc"/);
    const r = await call('get_file', { path: 'missing/dir/file.ts' });
    expect(JSON.stringify(r)).not.toContain(root);
  });
});

describe('MCP process behavior', () => {
  it('stdout contains only JSON-RPC messages and the process exits when stdin closes', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: root, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    const send = (m: object) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } });
    await new Promise((r) => setTimeout(r, 1500));
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_files', arguments: { query: 'inventory stock levels', limit: 1 } } });
    await new Promise((r) => setTimeout(r, 4000));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.stdin.end();
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 10_000))]);
    expect(code).toBe(0);
    const lines = out.split('\n').filter((l) => l.trim() !== '');
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(JSON.parse(l).jsonrpc).toBe('2.0');
    const resp = lines.map((l) => JSON.parse(l)).find((m) => m.id === 2);
    expect(resp.result.structuredContent.results.length).toBe(1);
  });

  it('fails fast with NOT_INITIALIZED on stderr (nothing on stdout) for an uninitialized root', async () => {
    const r = await runCli(['mcp'], { cwd: makeProject({ 'a.ts': 'a' }) });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('NOT_INITIALIZED');
  });

  it('exits on SIGTERM', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: root, env: cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    await new Promise((r) => setTimeout(r, 1500));
    const exited = new Promise<number | null>((r) => child.on('exit', (code) => r(code)));
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  });
});
