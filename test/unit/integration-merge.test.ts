import { describe, expect, it } from 'vitest';
import { mergeGitignore } from '../../src/integration/gitignore.js';
import { mergeMcpConfig, mcpServerEntry } from '../../src/integration/claude-config.js';
import { mergeInstructions, instructionsBlock, START_MARKER, END_MARKER } from '../../src/integration/claude-instructions.js';
import { mergeSkill, templateHash, SKILL_NAMES, SKILL_TEMPLATES, PREVIOUS_TEMPLATE_HASHES } from '../../src/integration/claude-skills.js';

describe('gitignore merge', () => {
  it('creates, appends, and is idempotent; preserves CRLF', () => {
    expect(mergeGitignore(null)).toBe('/.semantic-index/\n');
    expect(mergeGitignore('node_modules\n')).toBe('node_modules\n/.semantic-index/\n');
    expect(mergeGitignore('node_modules')).toBe('node_modules\n/.semantic-index/\n');
    expect(mergeGitignore('a\r\nb\r\n')).toBe('a\r\nb\r\n/.semantic-index/\r\n');
    expect(mergeGitignore('a\n/.semantic-index/\n')).toBeNull();
    expect(mergeGitignore('')).toBe('/.semantic-index/\n');
  });
});

describe('.mcp.json merge', () => {
  it('adds entry preserving other servers and keys', () => {
    const out = mergeMcpConfig(JSON.stringify({ other: true, mcpServers: { x: { command: 'x' } } }));
    const parsed = JSON.parse(out!);
    expect(parsed.other).toBe(true);
    expect(parsed.mcpServers.x).toEqual({ command: 'x' });
    expect(parsed.mcpServers['semantic-code-index']).toEqual(mcpServerEntry());
    expect(mergeMcpConfig(out)).toBeNull();
  });
  it('creates when missing and contains no absolute paths', () => {
    const out = mergeMcpConfig(null)!;
    expect(JSON.parse(out).mcpServers['semantic-code-index'].args).toEqual(['--no-install', 'semantic-code-index', 'mcp']);
    expect(out).not.toMatch(/\/home|\/Users|[A-Z]:\\/);
  });
  it('fails on malformed json or conflicting entry', () => {
    expect(() => mergeMcpConfig('{oops')).toThrow(/not valid JSON/);
    expect(() => mergeMcpConfig('[]')).toThrow(/object/);
    expect(() => mergeMcpConfig('{"mcpServers":[]}')).toThrow(/mcpServers/);
    expect(() => mergeMcpConfig(JSON.stringify({ mcpServers: { 'semantic-code-index': { command: 'node' } } }))).toThrow(/different/);
  });
});

describe('CLAUDE.md merge', () => {
  it('creates, appends, replaces only the block, and is idempotent', () => {
    expect(mergeInstructions(null)).toBe(`${instructionsBlock()}\n`);
    const appended = mergeInstructions('# Project\n\nKeep me.\n')!;
    expect(appended.startsWith('# Project\n\nKeep me.\n\n<!-- semantic-code-index:start -->')).toBe(true);
    expect(mergeInstructions(appended)).toBeNull();
    const old = `top\n${START_MARKER}\nold content\n${END_MARKER}\nbottom\n`;
    const replaced = mergeInstructions(old)!;
    expect(replaced.startsWith('top\n')).toBe(true);
    expect(replaced.endsWith(`${END_MARKER}\nbottom\n`)).toBe(true);
    expect(replaced).not.toContain('old content');
  });
  it('fails safely on duplicate/unbalanced/out-of-order markers', () => {
    expect(() => mergeInstructions(`${START_MARKER}\n${END_MARKER}\n${START_MARKER}\n${END_MARKER}`)).toThrow(/duplicate/);
    expect(() => mergeInstructions(`${START_MARKER}\nno end`)).toThrow(/unbalanced/);
    expect(() => mergeInstructions(`${END_MARKER}\n${START_MARKER}`)).toThrow(/order/);
  });
  it('preserves CRLF', () => {
    const out = mergeInstructions('a\r\n')!;
    expect(out.includes('\r\n<!-- semantic-code-index:start -->\r\n')).toBe(true);
    expect(out.replace(/\r\n/g, '').includes('\n')).toBe(false);
  });
});

describe('skill merge', () => {
  const tpl = '---\nname: x\n---\nbody v2\n';
  const v1 = '---\nname: x\n---\nbody v1\n';
  it('creates when missing and is unchanged when identical (ignoring CRLF)', () => {
    expect(mergeSkill(null, tpl, [])).toBe(tpl);
    expect(mergeSkill(tpl, tpl, [])).toBeNull();
    expect(mergeSkill(tpl.replace(/\n/g, '\r\n'), tpl, [])).toBeNull();
  });
  it('upgrades a known earlier template version, preserving line endings', () => {
    expect(mergeSkill(v1, tpl, [templateHash(v1)])).toBe(tpl);
    expect(mergeSkill(v1.replace(/\n/g, '\r\n'), tpl, [templateHash(v1)])).toBe(tpl.replace(/\n/g, '\r\n'));
  });
  it('refuses to overwrite customized content', () => {
    expect(() => mergeSkill(`${v1}my note\n`, tpl, [templateHash(v1)], '.claude/skills/x/SKILL.md')).toThrow(/customized; it was not overwritten/);
    expect(() => mergeSkill('', tpl, [])).toThrow(/customized/);
  });
  it('current templates are not listed as previous versions', () => {
    for (const name of SKILL_NAMES) expect(PREVIOUS_TEMPLATE_HASHES[name]).not.toContain(templateHash(SKILL_TEMPLATES[name]));
  });
});

describe('CLAUDE.md pointer block', () => {
  it('is short and migrates an older, longer block in place', () => {
    expect(instructionsBlock().split('\n').length).toBeLessThanOrEqual(16);
    const old = `# Mine\n\n${START_MARKER}\n## Semantic codebase index\n\n### Initial indexing and maintenance\n- old long text\n${END_MARKER}\n\nAfter.\n`;
    const next = mergeInstructions(old)!;
    expect(next).toBe(`# Mine\n\n${instructionsBlock()}\n\nAfter.\n`);
    expect(next).not.toContain('Initial indexing and maintenance');
  });
});
