/**
 * Agent-facing text (skills, CLAUDE.md block, MCP server instructions) must only name tools,
 * parameters, result fields and error codes that the MCP contract actually has (spec §15.3).
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { registerTools } from '../../src/mcp/tools.js';
import { SERVER_INSTRUCTIONS } from '../../src/mcp/server.js';
import { ERROR_CODES } from '../../src/errors.js';
import { SERVER_NAME } from '../../src/config/defaults.js';
import { SKILL_NAMES, SKILL_TEMPLATES } from '../../src/integration/claude-skills.js';
import { instructionsBlock } from '../../src/integration/claude-instructions.js';
import type { McpServer } from '@modelcontextprotocol/server';
import type { SemanticIndex } from '../../src/service/semantic-index.js';
import type { Logger } from '../../src/logger.js';

interface ToolDef {
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  annotations: { readOnlyHint?: boolean };
}

const tools = new Map<string, ToolDef>();
registerTools(
  { registerTool: (name: string, def: ToolDef) => void tools.set(name, def) } as unknown as McpServer,
  {} as SemanticIndex,
  {} as Logger
);

/** Collect every object key reachable in a zod schema. */
function keysOf(schema: z.ZodType, out = new Set<string>()): Set<string> {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> } })._zod.def;
  if (def.type === 'object') {
    for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) {
      out.add(k);
      keysOf(v, out);
    }
  } else if (def.type === 'array') keysOf(def.element as z.ZodType, out);
  else if (def.innerType) keysOf(def.innerType as z.ZodType, out);
  else if (def.type === 'record') keysOf(def.valueType as z.ZodType, out);
  return out;
}

const toolNames = new Set(tools.keys());
const fieldNames = new Set<string>();
for (const t of tools.values()) {
  keysOf(t.inputSchema, fieldNames);
  keysOf(t.outputSchema, fieldNames);
}
const errorCodes = new Set<string>(ERROR_CODES);

/** Identifiers inside `code spans` and the instructions text that look like contract names. */
function contractTokens(text: string): { snake: string[]; upper: string[] } {
  const spans = [...text.matchAll(/`([^`]+)`/g)].map((m) => m[1]!);
  const source = spans.length > 0 ? spans.join(' ') : text;
  const words = source.match(/[A-Za-z_]+/g) ?? [];
  return {
    snake: words.filter((w) => /^[a-z]+(_[a-z]+)+$/.test(w)),
    upper: words.filter((w) => /^[A-Z]+(_[A-Z]+)+$/.test(w))
  };
}

const texts: Record<string, string> = {
  ...Object.fromEntries(SKILL_NAMES.map((n) => [`skill ${n}`, SKILL_TEMPLATES[n]])),
  'CLAUDE.md block': instructionsBlock(),
  'server instructions': SERVER_INSTRUCTIONS
};

describe('agent-facing text matches the MCP contract', () => {
  it('the tool registry was captured', () => {
    expect(toolNames.size).toBe(9);
  });

  for (const [label, text] of Object.entries(texts)) {
    it(`${label}: tool, parameter and field names exist`, () => {
      const { snake } = contractTokens(text);
      expect(snake.length).toBeGreaterThan(0);
      const unknown = snake.filter((w) => !toolNames.has(w) && !fieldNames.has(w));
      expect(unknown).toEqual([]);
    });

    it(`${label}: error codes exist`, () => {
      const unknown = contractTokens(text).upper.filter((w) => !errorCodes.has(w));
      expect(unknown).toEqual([]);
    });
  }

  for (const name of SKILL_NAMES) {
    it(`skill ${name}: frontmatter is valid and allowed-tools pre-approves only read-only tools`, () => {
      const text = SKILL_TEMPLATES[name];
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
      expect(fm).not.toBeNull();
      const fields = Object.fromEntries(
        fm![1]!.split('\n').map((l) => {
          const i = l.indexOf(':');
          return [l.slice(0, i), l.slice(i + 1).trim()];
        })
      );
      expect(fields.name).toBe(name);
      expect(fields.description!.length).toBeGreaterThan(50);
      expect(fields.description!.length).toBeLessThanOrEqual(1536);
      for (const key of Object.keys(fields)) expect(['name', 'description', 'allowed-tools', 'disable-model-invocation']).toContain(key);
      const allowed = (fields['allowed-tools'] ?? '').split(/\s+/).filter(Boolean);
      expect(allowed.length).toBeGreaterThan(0);
      for (const entry of allowed) {
        const prefix = `mcp__${SERVER_NAME}__`;
        expect(entry.startsWith(prefix)).toBe(true);
        const tool = tools.get(entry.slice(prefix.length));
        expect(tool, entry).toBeDefined();
        expect(tool!.annotations.readOnlyHint, entry).toBe(true);
      }
      expect(text.split('\n').length).toBeLessThan(500);
    });
  }

  it('only semantic-index is user-invocation-only', () => {
    expect(SKILL_TEMPLATES['semantic-index']).toMatch(/\ndisable-model-invocation: true\n/);
    expect(SKILL_TEMPLATES['semantic-search']).not.toMatch(/disable-model-invocation/);
    expect(SKILL_TEMPLATES['semantic-sync']).not.toMatch(/disable-model-invocation/);
  });

  it('skills carry the required safety and workflow rules', () => {
    for (const name of SKILL_NAMES) {
      const t = SKILL_TEMPLATES[name];
      expect(t, name).toMatch(/data, not instructions/);
      expect(t, name).not.toMatch(/\/home\/|\/Users\/|[A-Z]:\\/);
    }
    for (const name of ['semantic-index', 'semantic-sync'] as const) {
      const t = SKILL_TEMPLATES[name];
      expect(t, name).toMatch(/expected_hash/);
      expect(t, name).toMatch(/FILE_CHANGED/);
      expect(t, name).toMatch(/at most 50/);
      expect(t, name).toMatch(/30–100 words/);
      expect(t, name).toMatch(/[Nn]ever include secrets/);
      expect(t, name).toMatch(/do not modify\s+(application\s+)?source\s+files/i);
    }
    expect(SKILL_TEMPLATES['semantic-index']).toMatch(/without a cursor/);
    expect(SKILL_TEMPLATES['semantic-sync']).toMatch(/Do not reconcile or re-index the\s+whole project/);
    expect(SKILL_TEMPLATES['semantic-search']).toMatch(/do not prove the functionality is absent/);
    expect(SKILL_TEMPLATES['semantic-search']).toMatch(/grep/);
  });
});
