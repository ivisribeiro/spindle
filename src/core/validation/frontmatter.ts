import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Parse + validate YAML frontmatter from agent/skill/command markdown.
// Fail-closed: a file with no parseable top-level `name` is an error, never a
// silent skip (that was the data-loss hole in AgentSpec's regex Python router).
//
// Tolerant by design: Claude Code's own frontmatter loader accepts block-scalar
// descriptions with embedded <example> blocks and other rich content that strict
// YAML rejects. So we try strict YAML+Zod first, then fall back to a top-level
// `name` line extraction. Routing only needs the name; we never want a valid,
// working agent dropped because its description has an unquoted colon.

export const AgentFrontmatter = z.object({
  name: z.string().min(1, 'agent name is required'),
  description: z.string().min(1, 'agent description is required'),
  model: z.string().optional(),
  tools: z.union([z.string(), z.array(z.string())]).optional(),
  output_schema: z.string().optional(),
  // KB domains this agent declares it reads. OPTIONAL + additive (agents without
  // the key stay valid). This is the ONLY place src/ becomes aware of kb_domains —
  // gRouterCoverage uses it for a referential-integrity check (does the domain dir
  // exist), NOT proof the model read it at runtime.
  kb_domains: z.array(z.string()).optional(),
});
export type AgentFrontmatter = z.infer<typeof AgentFrontmatter>;

export interface FrontmatterResult {
  ok: boolean;
  data?: AgentFrontmatter;
  raw?: Record<string, unknown>;
  error?: string;
  /** true when the strict YAML parse failed and the name fallback was used. */
  degraded?: boolean;
}

const FENCE = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/;

/** Returns the raw frontmatter block text (between the leading/closing ---), or null. */
export function extractFrontmatterBlock(markdown: string): string | null {
  const match = FENCE.exec(markdown);
  return match ? match[1] : null;
}

/** Strict parse: returns the YAML object only if it parses to an object. */
export function extractFrontmatter(markdown: string): Record<string, unknown> | null {
  const block = extractFrontmatterBlock(markdown);
  if (block === null) return null;
  try {
    const parsed = parseYaml(block);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Extracts a top-level `key:` inline value (column 0). Used by the fallback. */
function topLevelValue(block: string, key: string): string | undefined {
  const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm');
  const m = re.exec(block);
  if (!m) return undefined;
  let v = m[1].trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  // Block-scalar indicator => the value is on following lines, not inline.
  if (v === '' || v.startsWith('|') || v.startsWith('>')) return '';
  return v;
}

/** Parse + validate agent frontmatter. Strict YAML first, tolerant name fallback. */
export function parseAgentFrontmatter(markdown: string): FrontmatterResult {
  const block = extractFrontmatterBlock(markdown);
  if (block === null) {
    return { ok: false, error: 'missing or unparseable frontmatter block' };
  }

  let raw: Record<string, unknown> | null = null;
  try {
    const parsed = parseYaml(block);
    if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>;
  } catch {
    raw = null;
  }

  if (raw) {
    const result = AgentFrontmatter.safeParse(raw);
    if (result.success) {
      return { ok: true, data: result.data, raw };
    }
  }

  // Tolerant fallback: the agent is valid as long as it declares a name.
  const name = topLevelValue(block, 'name');
  if (name) {
    const description = topLevelValue(block, 'description') || name;
    return { ok: true, data: { name, description }, raw: raw ?? undefined, degraded: true };
  }

  return {
    ok: false,
    raw: raw ?? undefined,
    error: 'frontmatter has no parseable top-level name',
  };
}
