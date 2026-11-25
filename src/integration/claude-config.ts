import { isDeepStrictEqual } from 'node:util';
import { SemanticIndexError } from '../errors.js';
import { SERVER_NAME } from '../config/defaults.js';
import { readProjectTextFile, writeProjectTextFile } from './text-files.js';

export const MCP_CONFIG_FILE = '.mcp.json';

/** Portable project-scoped registration; no absolute paths, no implicit package download. */
export function mcpServerEntry(): Record<string, unknown> {
  return { type: 'stdio', command: 'npx', args: ['--no-install', SERVER_NAME, 'mcp'] };
}

/**
 * Pure merge of the MCP registration into `.mcp.json` text.
 * Returns null when already present and identical. Throws on malformed config or conflicting entry.
 */
export function mergeMcpConfig(existing: string | null): string | null {
  let doc: Record<string, unknown> = {};
  if (existing !== null && existing.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(existing);
    } catch {
      throw new SemanticIndexError('CONFIG_INVALID', `${MCP_CONFIG_FILE} is not valid JSON; it was not modified.`);
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new SemanticIndexError('CONFIG_INVALID', `${MCP_CONFIG_FILE} must contain a JSON object; it was not modified.`);
    }
    doc = parsed as Record<string, unknown>;
  }
  const servers = doc.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) {
    throw new SemanticIndexError('CONFIG_INVALID', `${MCP_CONFIG_FILE} "mcpServers" must be an object; it was not modified.`);
  }
  const serverMap = servers as Record<string, unknown>;
  const desired = mcpServerEntry();
  if (SERVER_NAME in serverMap) {
    if (isDeepStrictEqual(serverMap[SERVER_NAME], desired)) return null;
    throw new SemanticIndexError(
      'CONFIG_INVALID',
      `${MCP_CONFIG_FILE} already has a different "${SERVER_NAME}" entry; it was not overwritten. Remove or fix it manually.`
    );
  }
  const next = { ...doc, mcpServers: { ...serverMap, [SERVER_NAME]: desired } };
  return `${JSON.stringify(next, null, 2)}\n`;
}

export async function mergeClaudeMcpConfig(root: string): Promise<boolean> {
  const existing = await readProjectTextFile(root, MCP_CONFIG_FILE);
  const next = mergeMcpConfig(existing);
  if (next === null) return false;
  await writeProjectTextFile(root, MCP_CONFIG_FILE, next);
  return true;
}
