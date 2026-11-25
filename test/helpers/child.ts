import { spawn } from 'node:child_process';
import path from 'node:path';

const HOOK = path.resolve(import.meta.dirname, 'ts-hooks.mjs');

/** Run a TypeScript script in a separate Node process; resolves with parsed JSON stdout. */
export function runTsChild(script: string, args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--no-warnings', '--experimental-transform-types', '--import', HOOK, script, ...args], {
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}
