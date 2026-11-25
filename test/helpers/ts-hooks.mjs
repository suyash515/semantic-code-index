// Resolve hook so child processes can run the TypeScript sources directly with
// --experimental-transform-types (maps ./x.js imports to ./x.ts when needed).
import { register } from 'node:module';
register('data:text/javascript,' + encodeURIComponent(`
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL && context.parentURL.endsWith('.ts')) {
    const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
    if (existsSync(fileURLToPath(url))) return next(url.href, context);
  }
  return next(specifier, context);
}`));
