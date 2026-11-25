import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openDatabase } from '../../src/storage/connection.js';
import { initializeSchema, verifySchema } from '../../src/storage/schema.js';
import { Repository, versionOf } from '../../src/storage/repository.js';
import { encodeVector, distanceToScore } from '../../src/storage/vector-codec.js';
import { DEFAULT_EMBEDDING_PROFILE, canonicalProfileJson } from '../../src/config/defaults.js';
import { initializeProject } from '../../src/config/init.js';
import { SKILL_NAMES, SKILL_TEMPLATES } from '../../src/integration/claude-skills.js';
import { makeProject, git, tempDir } from '../helpers/fixtures.js';
import { unitVector } from '../helpers/vectors.js';
import { runTsChild } from '../helpers/child.js';

const PROFILE = canonicalProfileJson(DEFAULT_EMBEDDING_PROFILE);
const H = (c: string) => c.repeat(64);
const now = () => new Date().toISOString();

async function freshRepo() {
  const root = makeProject();
  const db = await openDatabase(root, { create: true });
  initializeSchema(db, PROFILE);
  return { root, db, repo: new Repository(db) };
}

function write(repo: Repository, p: string, vec: Float32Array, desc = `desc ${p}`, hash = H('a')) {
  return repo.applyIndexWrites(
    [{ path: p, expected: versionOf(repo.getRow(p)), description: desc, content_hash: hash, size_bytes: 1, language: null, embedding: encodeVector(vec, 384) }],
    PROFILE,
    now()
  )[0];
}

describe('schema and connection', () => {
  it('creates schema v1 with WAL, metadata, user_version and restrictive perms', async () => {
    const { root, db, repo } = await freshRepo();
    expect(db.pragma('user_version', { simple: true })).toBe(1);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.pragma('synchronous', { simple: true })).toBe(1);
    expect(db.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(repo.getMetadata('schema_version')).toBe('1');
    expect(repo.getGeneration()).toBe(0);
    expect(repo.getProfileJson()).toBe(PROFILE);
    expect(repo.getMetadata('created_at')).toMatch(/Z$/);
    if (process.platform !== 'win32') {
      expect(statSync(path.join(root, '.semantic-index')).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(root, '.semantic-index', 'index.db')).mode & 0o777).toBe(0o600);
    }
    expect(initializeSchema(db, PROFILE)).toBe(false);
    db.close();
  });

  it('returns NOT_INITIALIZED without creating anything', async () => {
    const root = makeProject();
    await expect(openDatabase(root, { create: false })).rejects.toMatchObject({ code: 'NOT_INITIALIZED' });
    expect(existsSync(path.join(root, '.semantic-index'))).toBe(false);
  });

  it('rejects symlinked index dir and db file', async () => {
    const root = makeProject();
    const elsewhere = tempDir();
    symlinkSync(elsewhere, path.join(root, '.semantic-index'));
    await expect(openDatabase(root, { create: true })).rejects.toMatchObject({ code: 'DB_ERROR' });
    const root2 = makeProject();
    mkdirSync(path.join(root2, '.semantic-index'));
    writeFileSync(path.join(elsewhere, 'x.db'), '');
    symlinkSync(path.join(elsewhere, 'x.db'), path.join(root2, '.semantic-index', 'index.db'));
    await expect(openDatabase(root2, { create: false })).rejects.toMatchObject({ code: 'DB_ERROR' });
  });

  it('newer schema → SCHEMA_UNSUPPORTED; mismatched metadata → DB_ERROR; corrupt → DB_ERROR; never reset', async () => {
    const { root, db } = await freshRepo();
    db.pragma('user_version = 2');
    expect(() => verifySchema(db)).toThrowError(expect.objectContaining({ code: 'SCHEMA_UNSUPPORTED' }));
    db.pragma('user_version = 1');
    db.prepare("UPDATE metadata SET value = '7' WHERE key = 'schema_version'").run();
    expect(() => verifySchema(db)).toThrowError(expect.objectContaining({ code: 'DB_ERROR' }));
    db.close();

    const root2 = makeProject();
    mkdirSync(path.join(root2, '.semantic-index'));
    const garbage = Buffer.alloc(8192, 7);
    writeFileSync(path.join(root2, '.semantic-index', 'index.db'), garbage);
    await expect(openDatabase(root2, { create: false })).rejects.toMatchObject({ code: 'DB_ERROR' });
    expect(readFileSync(path.join(root2, '.semantic-index', 'index.db')).equals(garbage)).toBe(true);
    expect(root).toBeTruthy();
  });

  it('enforces CHECK constraints on embedding length', async () => {
    const { db } = await freshRepo();
    expect(() =>
      db.prepare("INSERT INTO files (path, description, content_hash, embedding, size_bytes, state, indexed_at, updated_at) VALUES ('a', 'd', ?, ?, 1, 'indexed', 'x', 'x')").run(H('a'), Buffer.alloc(100))
    ).toThrow(/CHECK/);
  });
});

describe('repository', () => {
  it('creates, updates, reports unchanged, bumps generation only on change', async () => {
    const { repo } = await freshRepo();
    const v = unitVector(384, { 0: 1 });
    expect(write(repo, 'a.ts', v)).toBe('created');
    const g1 = repo.getGeneration();
    expect(g1).toBe(1);
    expect(write(repo, 'a.ts', v)).toBe('unchanged');
    expect(repo.getGeneration()).toBe(1);
    expect(write(repo, 'a.ts', v, 'new description')).toBe('updated');
    expect(repo.getGeneration()).toBe(2);
    const row = repo.getRow('a.ts')!;
    expect(row.description).toBe('new description');
    expect(row.observed_hash).toBe(row.content_hash);
    expect(row.state).toBe('indexed');
  });

  it('keeps indexed_at on update and reuses vector when embedding is null', async () => {
    const { repo } = await freshRepo();
    write(repo, 'a.ts', unitVector(384, { 0: 1 }), 'd');
    const before = repo.getRow('a.ts')!;
    const emb = repo.getEmbedding('a.ts');
    await new Promise((r) => setTimeout(r, 5));
    const [o] = repo.applyIndexWrites(
      [{ path: 'a.ts', expected: versionOf(before), description: 'd', content_hash: H('b'), size_bytes: 2, language: null, embedding: null }],
      PROFILE,
      now()
    );
    expect(o).toBe('updated');
    const after = repo.getRow('a.ts')!;
    expect(after.indexed_at).toBe(before.indexed_at);
    expect(after.updated_at).not.toBe(before.updated_at);
    expect(after.content_hash).toBe(H('b'));
    expect(repo.getEmbedding('a.ts')!.equals(emb!)).toBe(true);
  });

  it('detects CAS conflicts and treats already-matching state as unchanged', async () => {
    const { repo } = await freshRepo();
    const v = unitVector(384, { 0: 1 });
    write(repo, 'a.ts', v, 'one');
    const stale = versionOf(repo.getRow('a.ts'));
    write(repo, 'a.ts', v, 'two');
    const mk = (desc: string) => ({ path: 'a.ts', expected: stale, description: desc, content_hash: H('a'), size_bytes: 1, language: null, embedding: encodeVector(v, 384) });
    expect(repo.applyIndexWrites([mk('three')], PROFILE, now())).toEqual(['conflict']);
    expect(repo.applyIndexWrites([mk('two')], PROFILE, now())).toEqual(['unchanged']);
    expect(repo.getRow('a.ts')!.description).toBe('two');
    // insert race: expected null but row exists
    expect(repo.applyIndexWrites([{ ...mk('x'), expected: null }], PROFILE, now())).toEqual(['conflict']);
  });

  it('refuses writes when the stored profile differs (MODEL_MISMATCH) without modifying data', async () => {
    const { repo } = await freshRepo();
    write(repo, 'a.ts', unitVector(384, { 0: 1 }));
    expect(() =>
      repo.applyIndexWrites([{ path: 'b.ts', expected: null, description: 'd', content_hash: H('a'), size_bytes: 1, language: null, embedding: encodeVector(unitVector(384, { 1: 1 }), 384) }], '{"other":1}', now())
    ).toThrowError(expect.objectContaining({ code: 'MODEL_MISMATCH' }));
    expect(repo.getRow('b.ts')).toBeNull();
  });

  it('ranks by exact cosine with prefix filter before ranking, ties by path, keyset continuation', async () => {
    const { repo } = await freshRepo();
    const q = unitVector(384, { 0: 1 });
    write(repo, 'api/b.ts', unitVector(384, { 0: 1, 1: 1 })); // cos = 0.7071
    write(repo, 'api/a.ts', unitVector(384, { 0: 1, 1: 1 })); // tie with b
    write(repo, 'api/best.ts', unitVector(384, { 0: 1 })); // cos = 1
    write(repo, 'api-old/x.ts', unitVector(384, { 0: 1 })); // excluded by prefix
    write(repo, 'api/neg.ts', unitVector(384, { 0: -1 })); // cos = -1
    write(repo, 'api/orth.ts', unitVector(384, { 2: 1 })); // cos = 0
    const qb = encodeVector(q, 384);
    const all = repo.searchBatch(qb, 'api/', null, 10).rows;
    expect(all.map((r) => r.path)).toEqual(['api/best.ts', 'api/a.ts', 'api/b.ts', 'api/orth.ts', 'api/neg.ts']);
    expect(distanceToScore(all[0]!.distance)).toBeCloseTo(1, 5);
    expect(distanceToScore(all[1]!.distance)).toBeCloseTo(Math.SQRT1_2, 5);
    expect(distanceToScore(all[3]!.distance)).toBeCloseTo(0, 5);
    expect(distanceToScore(all[4]!.distance)).toBeCloseTo(-1, 5);
    const p1 = repo.searchBatch(qb, 'api/', null, 2).rows;
    const last = p1[p1.length - 1]!;
    const p2 = repo.searchBatch(qb, 'api/', { distance: last.distance, path: last.path }, 2).rows;
    expect([...p1, ...p2].map((r) => r.path)).toEqual(all.slice(0, 4).map((r) => r.path));
    expect(repo.searchBatch(qb, null, null, 10).rows.length).toBe(6);
    expect(repo.searchBatch(qb, 'nothing/', null, 10).rows.length).toBe(0);
    expect(repo.countInPrefix('api/')).toBe(5);
    // prefix with LIKE metacharacters is literal
    write(repo, 'a%_b/x.ts', unitVector(384, { 0: 1 }));
    expect(repo.searchBatch(qb, 'a%_b/', null, 10).rows.map((r) => r.path)).toEqual(['a%_b/x.ts']);
  });

  it('reconcile actions apply with CAS; reset and reembed are transactional', async () => {
    const { repo } = await freshRepo();
    const v = unitVector(384, { 0: 1 });
    write(repo, 'a.ts', v);
    write(repo, 'b.ts', v);
    const va = versionOf(repo.getRow('a.ts'));
    expect(repo.applyReconcile([{ kind: 'mark_stale', path: 'a.ts', expected: va, observed_hash: H('c') }], now())).toEqual([true]);
    const sa = repo.getRow('a.ts')!;
    expect(sa.state).toBe('stale');
    expect(sa.observed_hash).toBe(H('c'));
    expect(sa.description).toBe('desc a.ts');
    expect(repo.applyReconcile([{ kind: 'restore', path: 'a.ts', expected: va }], now())).toEqual([false]);
    expect(repo.applyReconcile([{ kind: 'restore', path: 'a.ts', expected: versionOf(sa) }], now())).toEqual([true]);
    expect(repo.getRow('a.ts')!.state).toBe('indexed');
    expect(repo.applyReconcile([{ kind: 'delete', path: 'b.ts', expected: versionOf(repo.getRow('b.ts')) }], now())).toEqual([true]);
    expect(repo.getRow('b.ts')).toBeNull();

    const g = repo.getGeneration();
    const vecs = new Map([[repo.getRow('a.ts')!.id, encodeVector(unitVector(384, { 5: 1 }), 384)]]);
    expect(() => repo.applyReembed(g - 1, vecs, PROFILE)).toThrowError(expect.objectContaining({ code: 'INDEX_CHANGED' }));
    expect(() => repo.applyReembed(g, new Map(), PROFILE)).toThrowError(expect.objectContaining({ code: 'INDEX_CHANGED' }));
    expect(repo.applyReembed(g, vecs, '{"new":1}')).toBe(g + 1);
    expect(repo.getProfileJson()).toBe('{"new":1}');
    expect(repo.getEmbedding('a.ts')!.equals(vecs.values().next().value!)).toBe(true);

    expect(repo.reset(PROFILE)).toBe(1);
    expect(repo.totalRows()).toBe(0);
    expect(repo.getProfileJson()).toBe(PROFILE);
  });

  it('returns DB_BUSY when another connection holds the write lock', async () => {
    const { root, db } = await freshRepo();
    const other = new Database(path.join(root, '.semantic-index', 'index.db'), { timeout: 50 });
    other.exec('BEGIN IMMEDIATE');
    try {
      const db2 = await openDatabase(root, { create: false });
      db2.pragma('busy_timeout = 50');
      const repo2 = new Repository(db2);
      let caught: unknown;
      try {
        write(repo2, 'x.ts', unitVector(384, { 0: 1 }));
      } catch (e) {
        caught = e;
      }
      expect((caught as { code?: string }).code).toMatch(/SQLITE_BUSY/);
      db2.close();
    } finally {
      other.exec('ROLLBACK');
      other.close();
      db.close();
    }
  });

  it('concurrent two-process writers: no lost updates or corrupt records', async () => {
    const { root, db, repo } = await freshRepo();
    const script = path.resolve(import.meta.dirname, '../helpers/storage-writer.ts');
    const runs = await Promise.all([runTsChild(script, [root, '1', '40']), runTsChild(script, [root, '2', '40'])]);
    for (const r of runs) expect(r.code, r.stderr).toBe(0);
    const stats = runs.map((r) => JSON.parse(r.stdout));
    // every private file was written exactly once
    expect(repo.countInPrefix('w1/')).toBe(40 - 0);
    expect(repo.countInPrefix('w2/')).toBe(40);
    const shared = repo.getRow('shared.ts')!;
    expect(shared.description).toMatch(/^worker [12] iteration \d+$/);
    // each write either succeeded or was reported (conflict/busy), never silently lost
    const totalShared = stats.reduce((n, s) => n + s.created + s.updated + s.unchanged + s.conflict + s.busy, 0);
    expect(totalShared).toBe(160);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
    const gen = repo.getGeneration();
    const writes = stats.reduce((n, s) => n + s.created + s.updated, 0);
    expect(gen).toBe(writes);
  });
});

describe('initializeProject', () => {
  it('is idempotent, preserves records and unrelated config, adds gitignore, does not download a model', async () => {
    const root = makeProject({ '.gitignore': 'node_modules\n', 'CLAUDE.md': '# Mine\n', '.mcp.json': '{"mcpServers":{"x":{"command":"x"}}}' }, { git: true });
    const r1 = await initializeProject({ root, claude: true, instructions: true });
    expect(r1.ok).toBe(true);
    expect(Object.fromEntries(r1.steps.map((s) => [s.step, s.status]))).toEqual({
      config: 'created', database: 'created', gitignore: 'updated', claude: 'updated', instructions: 'updated'
    });
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules\n/.semantic-index/\n');
    const db = await openDatabase(root, { create: false });
    write(new Repository(db), 'kept.ts', unitVector(384, { 0: 1 }));
    db.close();
    const r2 = await initializeProject({ root, claude: true, instructions: true });
    expect(r2.steps.every((s) => s.status === 'unchanged')).toBe(true);
    const db2 = await openDatabase(root, { create: false });
    expect(new Repository(db2).getRow('kept.ts')).not.toBeNull();
    db2.close();
    // SQLite file and sidecars are ignored by Git
    const status = git(root, 'status', '--porcelain', '--ignored');
    expect(status).toContain('!! .semantic-index/');
    expect(git(root, 'check-ignore', '.semantic-index/index.db-wal').trim()).toBe('.semantic-index/index.db-wal');
    expect(JSON.parse(readFileSync(path.join(root, '.mcp.json'), 'utf8')).mcpServers.x).toEqual({ command: 'x' });
    expect(readFileSync(path.join(root, 'CLAUDE.md'), 'utf8').startsWith('# Mine\n')).toBe(true);
  });

  it('fails individual steps safely and finishes the rest; never overwrites conflicting config', async () => {
    const root = makeProject({ '.mcp.json': '{bad json', '.semantic-index.json': '{"configVersion":1,"bogus":true}' });
    const r = await initializeProject({ root, claude: true, instructions: true });
    expect(r.ok).toBe(false);
    const by = Object.fromEntries(r.steps.map((s) => [s.step, s]));
    expect(by.config!.status).toBe('failed');
    expect(by.config!.error!.code).toBe('CONFIG_INVALID');
    expect(by.claude!.status).toBe('failed');
    expect(by.database!.status).toBe('created');
    expect(by.instructions!.status).toBe('updated');
    expect(readFileSync(path.join(root, '.mcp.json'), 'utf8')).toBe('{bad json');
  });

  it('installs skills idempotently, preserves customized skills and other .claude content', async () => {
    const root = makeProject({ '.claude/settings.json': '{"x":1}\n', '.claude/skills/mine/SKILL.md': 'my skill\n' });
    const r1 = await initializeProject({ root, skills: true });
    expect(r1.ok).toBe(true);
    const skills = (r: typeof r1) => r.steps.filter((s) => s.step === 'skills').map((s) => [s.file, s.status]);
    expect(skills(r1)).toEqual([
      ['.claude/skills/semantic-search/SKILL.md', 'created'],
      ['.claude/skills/semantic-index/SKILL.md', 'created'],
      ['.claude/skills/semantic-sync/SKILL.md', 'created']
    ]);
    for (const name of SKILL_NAMES) {
      expect(readFileSync(path.join(root, '.claude/skills', name, 'SKILL.md'), 'utf8')).toBe(SKILL_TEMPLATES[name]);
    }
    expect(readFileSync(path.join(root, '.claude/settings.json'), 'utf8')).toBe('{"x":1}\n');
    expect(readFileSync(path.join(root, '.claude/skills/mine/SKILL.md'), 'utf8')).toBe('my skill\n');

    // CRLF checkout (e.g. Git autocrlf) still counts as unchanged.
    const searchSkill = path.join(root, '.claude/skills/semantic-search/SKILL.md');
    writeFileSync(searchSkill, SKILL_TEMPLATES['semantic-search'].replace(/\n/g, '\r\n'));
    expect(skills(await initializeProject({ root, skills: true })).every(([, s]) => s === 'unchanged')).toBe(true);

    // A customized skill fails its own step, is left untouched, and other steps still run.
    const syncSkill = path.join(root, '.claude/skills/semantic-sync/SKILL.md');
    writeFileSync(syncSkill, `${SKILL_TEMPLATES['semantic-sync']}\nTeam note.\n`);
    const r3 = await initializeProject({ root, skills: true, instructions: true });
    expect(r3.ok).toBe(false);
    const sync = r3.steps.find((s) => s.file === '.claude/skills/semantic-sync/SKILL.md')!;
    expect(sync.status).toBe('failed');
    expect(sync.error!.code).toBe('CONFIG_INVALID');
    expect(readFileSync(syncSkill, 'utf8')).toBe(`${SKILL_TEMPLATES['semantic-sync']}\nTeam note.\n`);
    expect(r3.steps.find((s) => s.step === 'instructions')!.status).toBe('updated');
    expect(r3.steps.find((s) => s.file === '.claude/skills/semantic-index/SKILL.md')!.status).toBe('unchanged');
  });

  it('never writes skills through symlinked directories or files', async () => {
    const outside = tempDir();
    const root = makeProject();
    symlinkSync(outside, path.join(root, '.claude'), 'dir');
    const r = await initializeProject({ root, skills: true });
    expect(r.ok).toBe(false);
    for (const s of r.steps.filter((x) => x.step === 'skills')) {
      expect(s.status).toBe('failed');
      expect(s.error!.message).toMatch(/symlinks are not followed/);
    }
    expect(existsSync(path.join(outside, 'skills'))).toBe(false);

    const root2 = makeProject();
    mkdirSync(path.join(root2, '.claude/skills/semantic-search'), { recursive: true });
    const target = path.join(outside, 'target.md');
    writeFileSync(target, 'outside\n');
    symlinkSync(target, path.join(root2, '.claude/skills/semantic-search/SKILL.md'));
    const r2 = await initializeProject({ root: root2, skills: true });
    expect(r2.steps.find((s) => s.file === '.claude/skills/semantic-search/SKILL.md')!.status).toBe('failed');
    expect(readFileSync(target, 'utf8')).toBe('outside\n');
  });

  it('warns when index files are already tracked; never untracks', async () => {
    const root = makeProject({ '.semantic-index/old.txt': 'x' }, { git: true });
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'oops');
    const r = await initializeProject({ root });
    expect(r.warnings.join(' ')).toMatch(/tracked by Git/);
    expect(git(root, 'ls-files')).toContain('.semantic-index/old.txt');
  });

  it('concurrent initialization is safe', async () => {
    const root = makeProject();
    const rs = await Promise.all([initializeProject({ root }), initializeProject({ root }), initializeProject({ root })]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.flatMap((r) => r.steps.filter((s) => s.step === 'database' && s.status === 'created')).length).toBe(1);
  });
});
