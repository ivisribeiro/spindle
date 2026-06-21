#!/usr/bin/env node
// Standalone enforcement of the one invariant: the spin CLI NEVER calls a model.
// Scans src/ for inference endpoints, model SDK imports, or `claude -p`. Exits 1
// on any hit. The same check runs inside the vitest suite (test/e2e/guard.test.ts);
// this script is for CI / pre-commit use. `npm run guard`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');

const FORBIDDEN = [
  { re: /api\.anthropic\.com/, why: 'inference endpoint' },
  { re: /\bclaude\s+-p\b/, why: 'shelling to the claude CLI' },
  { re: /\bfetch\s*\(/, why: 'network call' },
  { re: /from\s+['"]@anthropic/, why: 'Anthropic SDK import' },
  { re: /require\(\s*['"]@anthropic/, why: 'Anthropic SDK require' },
  { re: /openai/i, why: 'model provider SDK' },
];

function tsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

const violations = [];
for (const file of tsFiles(SRC)) {
  const text = fs.readFileSync(file, 'utf-8');
  for (const { re, why } of FORBIDDEN) {
    if (re.test(text)) violations.push(`${path.relative(SRC, file)}: ${why} (${re})`);
  }
}

if (violations.length > 0) {
  console.error('GUARD FAILED — spin must never call a model. Violations:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('guard ok: no model calls in src/');
