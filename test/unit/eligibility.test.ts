import { describe, expect, it } from 'vitest';
import { PathPolicy, isHardExcluded } from '../../src/project/eligibility.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { inferLanguage } from '../../src/project/language.js';

const scan = (o: Partial<ReturnType<typeof defaultConfig>['scan']> = {}) => ({ ...defaultConfig().scan, ...o });

describe('hard exclusions', () => {
  it.each([
    '.git/config', 'a/.git', 'node_modules/x/index.js', 'pkg/node_modules/x.js', '.semantic-index/index.db',
    'dist/a.js', 'build/x', 'coverage/lcov.info', '.next/x', '.cache/x', 'vendor/a.php', 'a/__pycache__/x.py', '.venv/x.py',
    '.env', 'config/.env', '.env.local', '.env.example', 'server.pem', 'tls/private.key', 'id_rsa', 'home/.ssh/id_ed25519', 'id_rsa.pub',
    '.npmrc', '.pypirc', '.netrc', '.aws/credentials', 'logo.png', 'archive.zip', 'data.sqlite', 'app.db', '.semantic-index.json', 'lib.so'
  ])('%s is excluded', (p) => expect(isHardExcluded(p)).toBe(true));
  it.each(['src/a.ts', 'Makefile', 'README.md', 'scripts/deploy', 'db/schema.sql', 'src/distance.ts', 'builder/x.ts', 'environment.ts'])(
    '%s is not excluded',
    (p) => expect(isHardExcluded(p)).toBe(false)
  );
});

describe('PathPolicy', () => {
  it('hides dotfiles unless includeHidden; hard exclusions still apply', () => {
    expect(new PathPolicy(scan()).allowsFile('.github/workflows/ci.yml')).toBe(false);
    expect(new PathPolicy(scan({ includeHidden: true })).allowsFile('.github/workflows/ci.yml')).toBe(true);
    expect(new PathPolicy(scan({ includeHidden: true })).allowsFile('.env')).toBe(false);
    expect(new PathPolicy(scan({ includeHidden: true })).allowsFile('.git/HEAD')).toBe(false);
  });
  it('applies include allowlist and exclude patterns; cannot override hard exclusions', () => {
    const p = new PathPolicy(scan({ include: ['src/', '*.md'], exclude: ['src/generated/', '**/*.test.ts'] }));
    expect(p.allowsFile('src/a.ts')).toBe(true);
    expect(p.allowsFile('README.md')).toBe(true);
    expect(p.allowsFile('docs/x.md')).toBe(true);
    expect(p.allowsFile('lib/a.ts')).toBe(false);
    expect(p.allowsFile('src/generated/x.ts')).toBe(false);
    expect(p.allowsFile('src/a.test.ts')).toBe(false);
    const q = new PathPolicy(scan({ include: ['node_modules/', '.env'] }));
    expect(q.allowsFile('node_modules/x.js')).toBe(false);
    expect(q.allowsFile('.env')).toBe(false);
    expect(p.allowsDirectory('src/generated')).toBe(false);
    expect(p.allowsDirectory('src')).toBe(true);
    expect(p.allowsDirectory('node_modules')).toBe(false);
  });
  it('applies root .gitignore in filesystem mode', () => {
    const p = new PathPolicy(scan(), 'logs/\n*.log\n');
    expect(p.allowsFile('logs/a.txt')).toBe(false);
    expect(p.allowsFile('x.log')).toBe(false);
    expect(p.allowsFile('src/a.ts')).toBe(true);
    expect(p.allowsDirectory('logs')).toBe(false);
  });
});

describe('language', () => {
  it('infers common languages', () => {
    expect(inferLanguage('a/b.ts')).toBe('typescript');
    expect(inferLanguage('Dockerfile')).toBe('dockerfile');
    expect(inferLanguage('x/LICENSE')).toBeNull();
    expect(inferLanguage('q.SQL')).toBe('sql');
  });
});
