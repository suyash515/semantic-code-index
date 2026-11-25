/**
 * Explicit, idempotent project initialization (spec §4.3). Never downloads a model,
 * never runs git add/commit/rm/push. Each step reports its own outcome.
 */
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { SemanticIndexError, toErrorPayload } from '../errors.js';
import type { InitOptions, InitResult, InitStepResult } from '../types.js';
import { CONFIG_FILE_NAME, DEFAULT_EMBEDDING_PROFILE, INDEX_DIR_NAME, canonicalProfileJson } from './defaults.js';
import { defaultConfigText, parseConfig } from './load.js';
import { resolveRoot } from '../project/paths.js';
import { readProjectTextFile } from '../integration/text-files.js';
import { ensureGitignore } from '../integration/gitignore.js';
import { MCP_CONFIG_FILE, mergeClaudeMcpConfig } from '../integration/claude-config.js';
import { INSTRUCTIONS_FILE, mergeClaudeInstructions } from '../integration/claude-instructions.js';
import { SKILL_NAMES, installSkill, skillPath } from '../integration/claude-skills.js';
import { ensureIndexDir, openDatabase } from '../storage/connection.js';
import { initializeSchema } from '../storage/schema.js';
import { gitListTracked, isGitWorkTree } from '../project/git.js';

async function step(
  name: InitStepResult['step'],
  file: string,
  fn: () => Promise<'created' | 'updated' | 'unchanged'>
): Promise<InitStepResult> {
  try {
    return { step: name, file, status: await fn() };
  } catch (err) {
    return { step: name, file, status: 'failed', error: toErrorPayload(err) };
  }
}

export async function initializeProject(options: InitOptions = {}): Promise<InitResult> {
  const root = await resolveRoot(options.root);
  const steps: InitStepResult[] = [];
  const warnings: string[] = [];

  steps.push(
    await step('config', CONFIG_FILE_NAME, async () => {
      const existing = await readProjectTextFile(root, CONFIG_FILE_NAME);
      if (existing !== null) {
        parseConfig(existing); // validate; never overwrite a user's config
        return 'unchanged';
      }
      try {
        await writeFile(path.join(root, CONFIG_FILE_NAME), defaultConfigText(), { encoding: 'utf8', flag: 'wx' });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'unchanged';
        throw new SemanticIndexError('IO_ERROR', `Cannot write ${CONFIG_FILE_NAME}.`, { cause: err });
      }
      return 'created';
    })
  );

  steps.push(
    await step('database', `${INDEX_DIR_NAME}/index.db`, async () => {
      await ensureIndexDir(root);
      const db = await openDatabase(root, { create: true });
      try {
        return initializeSchema(db, canonicalProfileJson(DEFAULT_EMBEDDING_PROFILE)) ? 'created' : 'unchanged';
      } finally {
        db.close();
      }
    })
  );

  steps.push(await step('gitignore', '.gitignore', async () => ((await ensureGitignore(root)) ? 'updated' : 'unchanged')));

  // Warn (never untrack) if generated files are already tracked by Git.
  try {
    if (await isGitWorkTree(root)) {
      const tracked = await gitListFilesTracked(root);
      if (tracked.length > 0) {
        warnings.push(
          `${tracked.length} file(s) under ${INDEX_DIR_NAME}/ are tracked by Git. Ignore rules do not untrack files; run \`git rm -r --cached ${INDEX_DIR_NAME}\` yourself and commit.`
        );
      }
    }
  } catch {
    warnings.push('Could not check whether index files are tracked by Git.');
  }

  if (options.claude) {
    steps.push(await step('claude', MCP_CONFIG_FILE, async () => ((await mergeClaudeMcpConfig(root)) ? 'updated' : 'unchanged')));
  }
  if (options.instructions) {
    steps.push(await step('instructions', INSTRUCTIONS_FILE, async () => ((await mergeClaudeInstructions(root)) ? 'updated' : 'unchanged')));
  }
  if (options.skills) {
    for (const name of SKILL_NAMES) {
      steps.push(await step('skills', skillPath(name), () => installSkill(root, name)));
    }
  }

  return { steps, warnings, ok: steps.every((s) => s.status !== 'failed') };
}

async function gitListFilesTracked(root: string): Promise<string[]> {
  return gitListTracked(root, [INDEX_DIR_NAME]);
}
