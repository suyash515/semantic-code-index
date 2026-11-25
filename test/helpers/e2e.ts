import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const CLI = path.resolve(import.meta.dirname, '../../dist/cli.js');
export const MODEL_CACHE = process.env.SEMANTIC_INDEX_TEST_CACHE_DIR ?? path.join(os.tmpdir(), 'semantic-code-index-test-model-cache');

export function cliEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  return { ...env, SEMANTIC_INDEX_CACHE_DIR: MODEL_CACHE, ...extra };
}

export function runCli(args: string[], opts: { cwd?: string; input?: string; env?: Record<string, string> } = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: opts.cwd, env: opts.env ?? cliEnv(), stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}
