/**
 * CLI adapter (spec §13). Thin layer over the core service: parses arguments, prints
 * human-readable or JSON output, and maps outcomes to exit codes
 * (0 = success, 1 = operational failure incl. any failed batch item, 2 = invalid arguments).
 */
import { readFileSync } from 'node:fs';
import { open as openFile, stat } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError, InvalidArgumentError, Option } from 'commander';
import { SemanticIndexError, toErrorPayload, type ErrorPayload } from './errors.js';
import { LIMITS } from './config/defaults.js';
import { createStderrLogger, type Logger } from './logger.js';
import { initializeProject } from './config/init.js';
import { downloadModelAssets, openSemanticIndex, type SemanticIndex } from './service/semantic-index.js';
import { indexFilesInputSchema } from './mcp/schemas.js';
import type {
  GetFileResult,
  IndexFilesResult,
  IndexStatus,
  InitResult,
  Page,
  FileSummary,
  StaleFileSummary,
  ReconcileResult,
  SearchResult
} from './types.js';

const EXIT_OK = 0;
const EXIT_FAILURE = 1;
const EXIT_USAGE = 2;
const ARGUMENT_ERRORS = new Set<ErrorPayload['code']>(['INVALID_INPUT', 'INVALID_PATH', 'INVALID_CURSOR']);

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

class UsageError extends Error {}

interface GlobalOptions {
  root?: string;
  json?: boolean;
  verbose?: boolean;
}

function intOption(name: string, min: number, max: number) {
  return (value: string): number => {
    if (!/^-?\d+$/.test(value)) throw new InvalidArgumentError(`${name} must be an integer.`);
    const n = Number(value);
    if (n < min || n > max) throw new InvalidArgumentError(`${name} must be between ${min} and ${max}.`);
    return n;
  };
}

function scoreOption(value: string): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < -1 || n > 1) throw new InvalidArgumentError('--min-score must be a number in [-1, 1].');
  return n;
}

const out = (s: string) => process.stdout.write(`${s}\n`);
const err = (s: string) => process.stderr.write(`${s}\n`);

class Cli {
  exitCode = EXIT_OK;
  constructor(readonly program: Command) {}

  get opts(): GlobalOptions {
    return this.program.opts<GlobalOptions>();
  }

  logger(): Logger {
    return createStderrLogger(Boolean(this.opts.verbose));
  }

  emit<T>(value: T, human: (v: T) => string): void {
    if (this.opts.json) out(JSON.stringify(value, null, 2));
    else out(human(value));
  }

  fail(e: unknown): void {
    const payload = toErrorPayload(e);
    if (this.opts.json) out(JSON.stringify({ error: payload }, null, 2));
    else {
      err(`Error [${payload.code}]: ${payload.message}`);
      if (payload.details) err(`Details: ${JSON.stringify(payload.details)}`);
      if (payload.retryable) err('This error is retryable.');
    }
    this.exitCode = ARGUMENT_ERRORS.has(payload.code) ? EXIT_USAGE : EXIT_FAILURE;
  }

  /** Run with an opened index; always closes it. */
  async withIndex(fn: (index: SemanticIndex) => Promise<void>): Promise<void> {
    const index = await openSemanticIndex({ root: this.opts.root, logger: this.logger() });
    try {
      await fn(index);
    } finally {
      await index.close();
    }
  }
}

function formatStatus(s: IndexStatus): string {
  const pct = s.coverage === null ? 'n/a' : `${(s.coverage * 100).toFixed(1)}%`;
  return [
    `Coverage: ${pct} (${s.fresh} fresh of ${s.eligible} eligible)${s.complete ? '' : ' [partial]'}`,
    `Eligible: ${s.eligible}  fresh: ${s.fresh}  stale: ${s.stale}  unindexed: ${s.unindexed}`,
    `Records not eligible: missing: ${s.missing}  ineligible: ${s.ineligible}  unavailable: ${s.unavailable}`,
    `Scan mode: ${s.scan_mode}  model: ${s.embedding_model} (${s.model_compatible ? 'compatible' : 'MISMATCH: run reembed or reset --yes'})  schema: v${s.schema_version}`,
    ...s.warnings.map((w) => `Warning: ${w}`)
  ].join('\n');
}

function formatPage(p: Page<FileSummary | StaleFileSummary>): string {
  const lines = p.files.map((f) => `${f.current_hash}  ${String(f.size_bytes).padStart(8)}  ${f.path}${'description' in f ? `\n    was: ${f.description}` : ''}`);
  if (lines.length === 0) lines.push('(no files)');
  if (p.next_cursor) lines.push(`Next page: --cursor ${p.next_cursor}`);
  lines.push(`Scan mode: ${p.scan_mode}`);
  return [...lines, ...p.warnings.map((w) => `Warning: ${w}`)].join('\n');
}

function formatGet(g: GetFileResult): string {
  const lines = [`Path: ${g.path}`, `State: ${g.state}`, `Current hash: ${g.current_hash ?? '-'}`, `Current size: ${g.current_size_bytes ?? '-'}`];
  if (g.record) {
    lines.push(
      `Description: ${g.record.description}`,
      `Indexed hash: ${g.record.content_hash}`,
      `Indexed size: ${g.record.size_bytes}`,
      `Language: ${g.record.language ?? '-'}`,
      `Indexed at: ${g.record.indexed_at}  updated at: ${g.record.updated_at}  stored state: ${g.record.state}`
    );
  } else lines.push('Record: none');
  return lines.join('\n');
}

function formatBatch(r: IndexFilesResult): string {
  const lines = r.results.map((x) => (x.status === 'failed' ? `failed     ${x.path}  [${x.error.code}] ${x.error.message}` : `${x.status.padEnd(10)} ${x.path}`));
  lines.push(`Total ${r.total}: created ${r.created}, updated ${r.updated}, unchanged ${r.unchanged}, failed ${r.failed}`);
  if (r.failed > 0) lines.push('Some items failed; successful items were committed (partial success).');
  return lines.join('\n');
}

function formatSearch(r: SearchResult): string {
  const lines = r.results.map((x, i) => `${String(i + 1).padStart(2)}. ${x.score.toFixed(4)}  ${x.path}${x.state === 'stale' ? '  [STALE]' : ''}\n    ${x.description}`);
  if (lines.length === 0) lines.push('No matching files. Empty results do not prove absence; try ordinary text search.');
  const sk = r.skipped;
  if (sk.stale + sk.missing + sk.ineligible + sk.unavailable > 0) {
    lines.push(`Skipped: stale ${sk.stale}, missing ${sk.missing}, ineligible ${sk.ineligible}, unavailable ${sk.unavailable}`);
  }
  return [...lines, ...r.warnings.map((w) => `Warning: ${w}`)].join('\n');
}

function formatReconcile(r: ReconcileResult): string {
  const verb = r.dry_run ? 'Would' : 'Did';
  const lines = [
    `${r.dry_run ? 'Dry run (no changes made)' : 'Reconciled'}; scan mode ${r.scan_mode}${r.complete ? '' : ' [conflicts: rerun]'}`,
    `${verb} mark stale: ${r.marked_stale}  restore fresh: ${r.restored_fresh}  remove missing: ${r.removed_missing}  remove ineligible: ${r.removed_ineligible}`,
    `Unchanged: ${r.unchanged}  unindexed (observed): ${r.unindexed}  unavailable (kept): ${r.unavailable}  conflicts: ${r.conflicts}`
  ];
  for (const [k, s] of Object.entries(r.samples)) {
    if (s.paths.length === 0) continue;
    lines.push(`${k}:`, ...s.paths.map((p) => `  ${p}`));
    if (s.omitted_count > 0) lines.push(`  ... ${s.omitted_count} more`);
  }
  return [...lines, ...r.warnings.map((w) => `Warning: ${w}`)].join('\n');
}

function formatInit(r: InitResult): string {
  const lines = r.steps.map((s) => `${s.status.padEnd(9)} ${s.step.padEnd(12)} ${s.file}${s.error ? `  [${s.error.code}] ${s.error.message}` : ''}`);
  lines.push(...r.warnings.map((w) => `Warning: ${w}`));
  lines.push(r.ok ? 'Initialization complete. Next: `semantic-code-index model download`.' : 'Some steps failed; fix them and rerun init (completed steps are preserved).');
  return lines.join('\n');
}

async function readBatchInput(source: string): Promise<string> {
  const max = LIMITS.cliBatchInputMaxBytes;
  if (source === '-') {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of process.stdin) {
      total += (chunk as Buffer).length;
      if (total > max) throw new UsageError(`Batch input exceeds ${max} bytes.`);
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const st = await stat(source).catch(() => null);
  if (!st || !st.isFile()) throw new UsageError('--input must be a readable regular file or "-" for stdin.');
  if (st.size > max) throw new UsageError(`Batch input exceeds ${max} bytes.`);
  const fh = await openFile(source, 'r');
  try {
    const buf = Buffer.alloc(max + 1);
    const { bytesRead } = await fh.read(buf, 0, max + 1, 0);
    if (bytesRead > max) throw new UsageError(`Batch input exceeds ${max} bytes.`);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    await fh.close();
  }
}

async function confirmReset(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question('This removes ALL index records (source files are not touched). Type "yes" to continue: ');
    return answer.trim().toLowerCase() === 'yes';
  } finally {
    rl.close();
  }
}

export function buildProgram(): { program: Command; cli: Cli } {
  const program = new Command();
  const cli = new Cli(program);
  program
    .name('semantic-code-index')
    .description('Local semantic file index for AI coding agents (MCP server, CLI and library).')
    .version(packageVersion(), '-V, --version')
    .option('--root <directory>', 'project root (default: current working directory)')
    .option('--json', 'machine-readable JSON output on stdout')
    .option('--verbose', 'diagnostic logs on stderr')
    .showHelpAfterError()
    .exitOverride();

  const action =
    <A extends unknown[]>(fn: (...args: A) => Promise<void>) =>
    async (...args: A) => {
      try {
        await fn(...args);
      } catch (e) {
        if (e instanceof UsageError) {
          cli.fail(new SemanticIndexError('INVALID_INPUT', e.message));
          cli.exitCode = EXIT_USAGE;
        } else cli.fail(e);
      }
    };

  program
    .command('init')
    .description('Initialize the index in the project root (config, database, .gitignore). Does not download the model.')
    .option('--claude', 'merge the MCP server registration into .mcp.json')
    .option('--instructions', 'merge a short agent-instructions block into CLAUDE.md')
    .option('--skills', 'install Claude Code agent skills into .claude/skills/')
    .action(
      action(async (o: { claude?: boolean; instructions?: boolean; skills?: boolean }) => {
        const r = await initializeProject({ root: cli.opts.root, claude: o.claude, instructions: o.instructions, skills: o.skills });
        cli.emit(r, formatInit);
        if (!r.ok) cli.exitCode = EXIT_FAILURE;
      })
    );

  const model = program.command('model').description('Manage the local embedding model.');
  model
    .command('download')
    .description('Download and cache the pinned model (outside the project) and run a smoke inference.')
    .action(
      action(async () => {
        const r = await downloadModelAssets({ root: cli.opts.root, logger: cli.logger() });
        cli.emit(r, (v) => `Model ready: ${v.embedding_model}@${v.revision} (${v.dtype}, ${v.dimensions} dimensions).`);
      })
    );

  program
    .command('mcp')
    .description('Run the MCP stdio server for the initialized project root.')
    .action(
      action(async () => {
        const logger = cli.logger();
        const index = await openSemanticIndex({ root: cli.opts.root, logger });
        const { runStdioServer } = await import('./mcp/server.js');
        await runStdioServer(index, packageVersion(), logger);
        cli.exitCode = -1; // keep the process alive; the server exits on stdin close or signal
      })
    );

  program
    .command('status')
    .description('Show index coverage computed from current files.')
    .option('--prefix <dir>', 'limit to a directory')
    .action(action(async (o: { prefix?: string }) => cli.withIndex(async (i) => cli.emit(await i.getIndexStatus({ path_prefix: o.prefix }), formatStatus))));

  for (const [name, desc, stale] of [
    ['list-unindexed', 'List eligible files without a description.', false],
    ['list-stale', 'List indexed files whose content changed.', true]
  ] as const) {
    program
      .command(name)
      .description(desc)
      .option('--prefix <dir>', 'limit to a directory')
      .option('--limit <n>', 'page size (1–200, default 100)', intOption('--limit', 1, LIMITS.listPageMax))
      .option('--cursor <token>', 'continue from a previous page')
      .action(
        action(async (o: { prefix?: string; limit?: number; cursor?: string }) =>
          cli.withIndex(async (i) => {
            const req = { path_prefix: o.prefix, limit: o.limit, cursor: o.cursor };
            cli.emit(stale ? await i.listStaleFiles(req) : await i.listUnindexedFiles(req), formatPage);
          })
        )
      );
  }

  program
    .command('get <path>')
    .description('Show the current file hash and its index record.')
    .action(action(async (p: string) => cli.withIndex(async (i) => cli.emit(await i.getFile({ path: p }), formatGet))));

  program
    .command('index <path>')
    .description('Index one file with a description and the hash of the content you read.')
    .requiredOption('--description <text>', 'description of the file (30–100 words recommended)')
    .requiredOption('--expected-hash <sha256>', 'current_hash from list/get')
    .action(
      action(async (p: string, o: { description: string; expectedHash: string }) =>
        cli.withIndex(async (i) => {
          const r = await i.indexFiles({ files: [{ path: p, description: o.description, expected_hash: o.expectedHash }] });
          cli.emit(r, formatBatch);
          if (r.failed > 0) cli.exitCode = EXIT_FAILURE;
        })
      )
    );

  program
    .command('index-batch')
    .description('Index up to 50 files from JSON {"files":[{path,description,expected_hash}]} (file path or "-" for stdin, max 1 MiB).')
    .requiredOption('--input <file>', 'JSON input file or "-" for stdin')
    .action(
      action(async (o: { input: string }) => {
        const text = await readBatchInput(o.input);
        let raw: unknown;
        try {
          raw = JSON.parse(text);
        } catch {
          throw new UsageError('Batch input is not valid JSON.');
        }
        const parsed = indexFilesInputSchema.safeParse(raw);
        if (!parsed.success) {
          throw new UsageError(`Invalid batch input: ${parsed.error.issues.slice(0, 5).map((x) => `${x.path.join('.') || '(root)'}: ${x.message}`).join('; ')}`);
        }
        await cli.withIndex(async (i) => {
          const r = await i.indexFiles(parsed.data);
          cli.emit(r, formatBatch);
          if (r.failed > 0) cli.exitCode = EXIT_FAILURE;
        });
      })
    );

  program
    .command('search <query>')
    .description('Semantic search over file descriptions.')
    .option('--limit <n>', 'maximum results (1–50)', intOption('--limit', 1, LIMITS.searchMaxLimit))
    .option('--min-score <n>', 'cosine similarity threshold in [-1, 1]', scoreOption)
    .option('--prefix <dir>', 'limit to a directory')
    .option('--include-stale', 'include stale descriptions (labeled)')
    .action(
      action(async (q: string, o: { limit?: number; minScore?: number; prefix?: string; includeStale?: boolean }) =>
        cli.withIndex(async (i) =>
          cli.emit(await i.searchFiles({ query: q, limit: o.limit, min_score: o.minScore, path_prefix: o.prefix, include_stale: o.includeStale }), formatSearch)
        )
      )
    );

  program
    .command('remove <path>')
    .description('Remove an index record (never the source file).')
    .action(action(async (p: string) => cli.withIndex(async (i) => cli.emit(await i.removeFile({ path: p }), (r) => (r.removed ? `Removed record for ${r.path}.` : `No record for ${r.path}.`)))));

  program
    .command('reconcile')
    .description('Detect changed, deleted and ignored files; mark stale and clean records.')
    .option('--prefix <dir>', 'limit to a directory')
    .option('--dry-run', 'report without changing the index')
    .action(
      action(async (o: { prefix?: string; dryRun?: boolean }) =>
        cli.withIndex(async (i) => cli.emit(await i.reconcileIndex({ path_prefix: o.prefix, dry_run: Boolean(o.dryRun) }), formatReconcile))
      )
    );

  program
    .command('reembed')
    .description('Regenerate all vectors from stored descriptions with the current model (all-or-nothing).')
    .action(action(async () => cli.withIndex(async (i) => cli.emit(await i.reembed(), (r) => `Re-embedded ${r.reembedded} record(s) with ${r.embedding_model}.`))));

  program
    .command('reset')
    .description('Remove all index records (keeps configuration, schema and model cache).')
    .addOption(new Option('--yes', 'confirm without prompting'))
    .action(
      action(async (o: { yes?: boolean }) => {
        const confirmed = o.yes === true || (!cli.opts.json && (await confirmReset()));
        if (!confirmed) throw new UsageError('Reset requires --yes (or interactive confirmation on a TTY). Nothing was changed.');
        await cli.withIndex(async (i) => cli.emit(await i.reset({ confirm: true }), (r) => `Removed ${r.removed} record(s).`));
      })
    );

  return { program, cli };
}

export async function main(argv: string[]): Promise<number> {
  const { program, cli } = buildProgram();
  try {
    await program.parseAsync(argv);
  } catch (e) {
    if (e instanceof CommanderError) {
      if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return EXIT_OK;
      return EXIT_USAGE;
    }
    cli.fail(e);
  }
  return cli.exitCode;
}
