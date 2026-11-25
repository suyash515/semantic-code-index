#!/usr/bin/env node
/** Executable entry for the `semantic-code-index` CLI. All logic lives in cli-program.ts. */
import { main } from './cli-program.js';

void main(process.argv).then((code) => {
  // A negative code means a long-running command (mcp) manages its own exit.
  if (code >= 0) process.exitCode = code;
});
