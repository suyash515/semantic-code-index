// Ensure the CLI entry is executable after compilation.
import { chmodSync, existsSync, readFileSync } from 'node:fs';
const cli = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(cli)) throw new Error('dist/cli.js missing after build');
if (!readFileSync(cli, 'utf8').startsWith('#!/usr/bin/env node')) throw new Error('dist/cli.js lacks shebang');
if (process.platform !== 'win32') chmodSync(cli, 0o755);
