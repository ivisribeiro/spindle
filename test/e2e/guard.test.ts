import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// Enforces the load-bearing invariant: the spin CLI NEVER calls a model. If src/
// ever imports an LLM SDK, hits an inference endpoint, or shells to `claude -p`,
// the harness has degraded from a deterministic spine into a hidden agent.

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src');

const FORBIDDEN: Array<{ re: RegExp; why: string }> = [
  { re: /api\.anthropic\.com/, why: 'inference endpoint' },
  { re: /\bclaude\s+-p\b/, why: 'shelling to the claude CLI' },
  { re: /\bfetch\s*\(/, why: 'network call' },
  { re: /from\s+['"]@anthropic/, why: 'Anthropic SDK import' },
  { re: /require\(\s*['"]@anthropic/, why: 'Anthropic SDK require' },
  { re: /openai/i, why: 'model provider SDK' },
];

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('invariant: spin never calls a model', () => {
  it('no src/ file references a model SDK, endpoint, or claude -p', () => {
    const violations: string[] = [];
    for (const file of tsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const { re, why } of FORBIDDEN) {
        if (re.test(text)) {
          violations.push(`${path.relative(SRC, file)}: ${why} (${re})`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
