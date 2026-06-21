import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listGates } from '../../src/core/gates/registry.js';
import { listTaskKinds } from '../../src/core/model-route/policy.js';
import { HANDOFF_SCHEMAS } from '../../src/core/handoff/schemas.js';

// Every `spin gate <ID>`, `spin route <kind>`, and `spin handoff-check <id>` written
// in a command doc must reference something that ACTUALLY EXISTS. This is the
// mechanical backstop against the drift the final adversary found (an invented
// gate, a non-existent routing kind, a wrong handoff id). It scans the real
// command markdown and validates each reference against the live registries.

const COMMANDS_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'plugin',
  'commands'
);

function commandFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...commandFiles(full));
    else if (entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out;
}

const files = commandFiles(COMMANDS_DIR);
const REAL_GATES = new Set(listGates());
const REAL_KINDS = new Set(listTaskKinds());
const REAL_HANDOFFS = new Set(Object.keys(HANDOFF_SCHEMAS));

function collect(re: RegExp): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf-8');
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, 'g');
    while ((m = r.exec(text)) !== null) {
      const token = m[1];
      if (!refs.has(token)) refs.set(token, []);
      refs.get(token)!.push(path.relative(COMMANDS_DIR, file));
    }
  }
  return refs;
}

describe('command docs reference only real spin primitives', () => {
  it('finds commands to check', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every `gate G_*` reference is a real, invokable gate', () => {
    const refs = collect(/\bgate\s+(G_[A-Z_]+)/);
    const bad: string[] = [];
    for (const [gate, where] of refs) {
      if (!REAL_GATES.has(gate)) bad.push(`${gate} (in ${where.join(', ')})`);
    }
    expect(bad).toEqual([]);
  });

  it('every `route <kind>` reference is a real routing task-kind', () => {
    const refs = collect(/\broute\s+([a-z][a-z-]+)/);
    const bad: string[] = [];
    for (const [kind, where] of refs) {
      // skip prose like "route the request" — only flag tokens that look like ids
      if (kind.includes('-') || REAL_KINDS.has(kind) || /^(architect|adversary|merge)$/.test(kind)) {
        if (!REAL_KINDS.has(kind)) bad.push(`${kind} (in ${where.join(', ')})`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('every `handoff-check <id>` reference is a real handoff schema', () => {
    const refs = collect(/handoff-check\s+([a-z][a-z-]+)/);
    const bad: string[] = [];
    for (const [id, where] of refs) {
      if (!REAL_HANDOFFS.has(id)) bad.push(`${id} (in ${where.join(', ')})`);
    }
    expect(bad).toEqual([]);
  });
});
