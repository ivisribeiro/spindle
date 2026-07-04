#!/usr/bin/env node
// Machine-verified inventory of Spindle's distribution surface. Counts agents,
// commands, skills, KB domains, gates, handoff schema ids, and route task-kinds
// straight from source (never hand-maintained) and writes verification/inventory.json.
//
// `node scripts/gen-inventory.js`          — regenerate verification/inventory.json
// `node scripts/gen-inventory.js --check`  — exit 1 if the file is stale OR if any
//                                             numeric claim in marketplace.json /
//                                             plugin.json / commands/README.md
//                                             contradicts the real counts.
//
// Dependency-free (fs/path/url only) so it runs before `npm ci` and in CI without
// pulling in a glob library. `npm run inventory` / `npm run inventory:check`.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_PATH = path.join(ROOT, 'verification', 'inventory.json');

// ---------------------------------------------------------------------------
// Source walkers
// ---------------------------------------------------------------------------

/** Recursively list `.md` files under `dir`, returning slash-joined ids relative
 * to `dir` with the extension stripped, excluding any filename in `excludeNames`. */
function listMarkdownIds(dir, excludeNames = ['README.md']) {
  const ids = [];
  function walk(current, prefix) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const nextPrefix = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(full, nextPrefix);
      } else if (entry.isFile() && entry.name.endsWith('.md') && !excludeNames.includes(entry.name)) {
        ids.push(nextPrefix.slice(0, -3)); // strip ".md"
      }
    }
  }
  walk(dir, '');
  return ids.sort();
}

/** List immediate subdirectory names of `dir` (non-recursive). */
function listDirNames(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

// ---------------------------------------------------------------------------
// Closed-set extraction from src/core (regex over TS source — no compilation).
// ---------------------------------------------------------------------------

/** Slice the source between the first `{` after `startMarker` and the next
 * top-level `}` (or `};`), assuming no nested `{` inside (true for both
 * GATE_REGISTRY and HANDOFF_SCHEMAS, whose values are bare identifiers). */
function sliceObjectBlock(source, startMarker, label) {
  const markerIdx = source.indexOf(startMarker);
  if (markerIdx === -1) {
    throw new Error(`gen-inventory: could not find "${startMarker}" while parsing ${label} — source shape changed, update the parser`);
  }
  const braceStart = source.indexOf('{', markerIdx);
  const braceEnd = source.indexOf('}', braceStart + 1);
  if (braceStart === -1 || braceEnd === -1) {
    throw new Error(`gen-inventory: could not find the ${label} object bounds — source shape changed, update the parser`);
  }
  return source.slice(braceStart + 1, braceEnd);
}

function extractGateIds(source) {
  const block = sliceObjectBlock(source, 'GATE_REGISTRY', 'GATE_REGISTRY');
  const ids = [...block.matchAll(/^\s*(G_[A-Z_]+)\s*:/gm)].map((m) => m[1]);
  return [...new Set(ids)].sort();
}

function extractHandoffIds(source) {
  const block = sliceObjectBlock(source, 'HANDOFF_SCHEMAS', 'HANDOFF_SCHEMAS');
  const ids = [...block.matchAll(/^\s*(?:'([^']+)'|([A-Za-z0-9_-]+))\s*:/gm)].map((m) => m[1] || m[2]);
  return [...new Set(ids)].sort();
}

// TASK_KINDS values are `{ tier: ..., floor: ..., downgradable: ..., reason: ... }`
// literals, so sliceObjectBlock's "no nested braces" assumption does not hold.
// Instead, match the distinctive `<key>: { tier:` shape directly — unique to this
// table (MODEL_IDS / TIER_RANK entries never open a brace after the key).
function extractRouteKinds(source) {
  const ids = [...source.matchAll(/^\s*(?:'([a-zA-Z0-9-]+)'|([a-zA-Z][a-zA-Z0-9]*))\s*:\s*\{\s*tier\s*:/gm)].map(
    (m) => m[1] || m[2]
  );
  return [...new Set(ids)].sort();
}

// ---------------------------------------------------------------------------
// Compute
// ---------------------------------------------------------------------------

function computeInventory() {
  const agents = listMarkdownIds(path.join(ROOT, 'plugin', 'agents'));
  const commands = listMarkdownIds(path.join(ROOT, 'plugin', 'commands'));
  const skills = listDirNames(path.join(ROOT, 'plugin', 'skills'));
  const kbDomains = listDirNames(path.join(ROOT, 'plugin', 'kb'));

  const gatesSource = fs.readFileSync(path.join(ROOT, 'src', 'core', 'gates', 'registry.ts'), 'utf-8');
  const gates = extractGateIds(gatesSource);

  const handoffSource = fs.readFileSync(path.join(ROOT, 'src', 'core', 'handoff', 'schemas.ts'), 'utf-8');
  const handoffSchemas = extractHandoffIds(handoffSource);

  const policySource = fs.readFileSync(path.join(ROOT, 'src', 'core', 'model-route', 'policy.ts'), 'utf-8');
  const routeKinds = extractRouteKinds(policySource);

  return {
    note:
      'Generated by scripts/gen-inventory.js from source — do not hand-edit. ' +
      'Run `npm run inventory` to regenerate, `npm run inventory:check` to verify no drift.',
    agents: { count: agents.length, ids: agents },
    commands: { count: commands.length, ids: commands },
    skills: { count: skills.length, ids: skills },
    kbDomains: { count: kbDomains.length, ids: kbDomains },
    gates: { count: gates.length, ids: gates },
    handoffSchemas: { count: handoffSchemas.length, ids: handoffSchemas },
    routeKinds: { count: routeKinds.length, ids: routeKinds },
  };
}

function serialize(inventory) {
  return JSON.stringify(inventory, null, 2) + '\n';
}

// ---------------------------------------------------------------------------
// Cross-check hand-written numeric claims in the distribution manifests
// ---------------------------------------------------------------------------

const CLAIM_PATTERNS = [
  { re: /(\d+)\s+(?:core\s+)?agents\b/i, key: 'agents', label: 'agents' },
  { re: /(\d+)\s+(?:knowledge base|kb)\s+domains?\b/i, key: 'kbDomains', label: 'KB domains' },
  { re: /(\d+)\s+commands\b/i, key: 'commands', label: 'commands' },
  { re: /(\d+)\s+(?:typed\s+)?gates\b/i, key: 'gates', label: 'gates' },
];

function checkTextClaims(text, sourceLabel, inventory, problems) {
  if (!text) return;
  for (const { re, key, label } of CLAIM_PATTERNS) {
    const match = text.match(re);
    if (!match) continue;
    const claimed = Number(match[1]);
    const actual = inventory[key].count;
    if (claimed !== actual) {
      problems.push(`${sourceLabel}: claims ${claimed} ${label}, but there are actually ${actual}`);
    }
  }
}

function checkManifestClaims(inventory) {
  const problems = [];

  const marketplacePath = path.join(ROOT, '.claude-plugin', 'marketplace.json');
  const marketplace = JSON.parse(fs.readFileSync(marketplacePath, 'utf-8'));
  const marketplaceLabel = path.relative(ROOT, marketplacePath);
  checkTextClaims(marketplace.metadata?.description, marketplaceLabel, inventory, problems);
  for (const plugin of marketplace.plugins ?? []) {
    checkTextClaims(plugin.description, `${marketplaceLabel} (plugin "${plugin.name}")`, inventory, problems);
  }

  const pluginJsonPath = path.join(ROOT, 'plugin', '.claude-plugin', 'plugin.json');
  const pluginJson = JSON.parse(fs.readFileSync(pluginJsonPath, 'utf-8'));
  checkTextClaims(pluginJson.description, path.relative(ROOT, pluginJsonPath), inventory, problems);

  const commandsReadmePath = path.join(ROOT, 'plugin', 'commands', 'README.md');
  const commandsReadmeLabel = path.relative(ROOT, commandsReadmePath);
  const commandsReadme = fs.readFileSync(commandsReadmePath, 'utf-8');
  const slashMatch = commandsReadme.match(/(\d+)\s+slash commands\b/i);
  if (slashMatch) {
    const claimed = Number(slashMatch[1]);
    if (claimed !== inventory.commands.count) {
      problems.push(`${commandsReadmeLabel}: claims ${claimed} slash commands, but there are actually ${inventory.commands.count}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function summarize(inventory) {
  return [
    `agents=${inventory.agents.count}`,
    `commands=${inventory.commands.count}`,
    `skills=${inventory.skills.count}`,
    `kbDomains=${inventory.kbDomains.count}`,
    `gates=${inventory.gates.count}`,
    `handoffSchemas=${inventory.handoffSchemas.count}`,
    `routeKinds=${inventory.routeKinds.count}`,
  ].join(' ');
}

function runCheck() {
  const inventory = computeInventory();
  const fresh = serialize(inventory);
  const problems = [];

  if (!fs.existsSync(OUT_PATH)) {
    problems.push(`${path.relative(ROOT, OUT_PATH)} does not exist — run \`npm run inventory\` to generate it.`);
  } else {
    const onDisk = fs.readFileSync(OUT_PATH, 'utf-8');
    if (onDisk !== fresh) {
      let onDiskParsed;
      try {
        onDiskParsed = JSON.parse(onDisk);
      } catch {
        onDiskParsed = null;
      }
      problems.push(`${path.relative(ROOT, OUT_PATH)} is stale — source counts changed since it was last generated. Run \`npm run inventory\` to regenerate.`);
      if (onDiskParsed) {
        for (const key of Object.keys(inventory)) {
          if (key === 'note') continue;
          const before = onDiskParsed[key]?.count;
          const after = inventory[key].count;
          if (before !== after) {
            problems.push(`  ${key}: recorded ${before ?? '?'} -> actual ${after}`);
          }
        }
      }
    }
  }

  problems.push(...checkManifestClaims(inventory));

  if (problems.length > 0) {
    console.error('INVENTORY CHECK FAILED:');
    for (const p of problems) console.error('  - ' + p);
    process.exit(1);
  }

  console.log(`inventory check ok: ${summarize(inventory)}`);
  console.log('verification/inventory.json matches source; marketplace/plugin/README claims match reality.');
}

function runGenerate() {
  const inventory = computeInventory();
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  fs.writeFileSync(OUT_PATH, serialize(inventory));
  console.log(`wrote ${path.relative(ROOT, OUT_PATH)}: ${summarize(inventory)}`);
}

const checkMode = process.argv.includes('--check');
if (checkMode) {
  runCheck();
} else {
  runGenerate();
}
