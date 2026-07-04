#!/usr/bin/env node
// Authorship guard. Upstream source names (AgentSpec / OpenSpec / ECC) must NOT appear
// in the plugin's public-facing prose — that is what makes the product read as a fork.
// Scans plugin/, the repo-root .claude-plugin/ marketplace manifest, and the root
// README.md — the surfaces a prospective user or marketplace listing actually sees.
// Provenance is centralized in CREDITS.md and, per ported file, a frontmatter `origin:`
// stamp. This guard fails CI if a source name leaks back into any of those surfaces.
// `npm run guard:authorship`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FORK_TELLS = [/\bagentspec\b/i, /\bopenspec\b/i, /\becc\b/i];
const SCAN_EXT = new Set(['.md', '.json', '.py', '.txt', '.yaml', '.yml']);

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'dist') continue; // build output — regenerated, not authored
      out.push(...walk(full));
    } else if (SCAN_EXT.has(path.extname(entry.name)) && entry.name !== 'CREDITS.md') {
      out.push(full);
    }
  }
  return out;
}

// The scanned surfaces: the plugin payload itself, the repo-root marketplace manifest
// (.claude-plugin/), and the root README — the three places a fork-tell is visible to
// someone who has never opened src/. CREDITS.md and `origin:` stamps stay exempt
// wherever they appear (checked per-line below), same as before this surface widened.
const SCAN_DIRS = [path.join(ROOT, 'plugin'), path.join(ROOT, '.claude-plugin')];
const SCAN_FILES = [path.join(ROOT, 'README.md')];

const filesToScan = [...SCAN_DIRS.flatMap(walk), ...SCAN_FILES.filter((f) => fs.existsSync(f))];

const violations = [];
for (const file of filesToScan) {
  const lines = fs.readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (/^\s*origin\s*:/.test(line)) return; // allowed: frontmatter provenance stamp
    for (const re of FORK_TELLS) {
      if (re.test(line)) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        break;
      }
    }
  });
}

if (violations.length > 0) {
  console.error('AUTHORSHIP GUARD FAILED — upstream source names leak into the plugin surface.');
  console.error('Move provenance to CREDITS.md or a frontmatter `origin:` stamp. Hits:');
  for (const v of violations) console.error('  ' + v);
  process.exit(1);
}
console.log('authorship guard ok: no fork-tells in plugin/, .claude-plugin/, or README.md');
