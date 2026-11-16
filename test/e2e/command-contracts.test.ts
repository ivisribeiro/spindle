import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema } from '../../src/core/artifact-graph/schema.js';

// The command-contract linter — the mechanical backstop `command-references.test.ts`
// cannot provide. That file proves every gate/route/handoff-schema ID cited in
// plugin/commands/**/*.md exists in the live registries. It cannot catch:
//
//   (a) a dead file reference (a doc pointing at a path that was never created,
//       or moved/renamed without updating the prose that cites it)
//   (b) a `spin complete <id> --handoff` promise on an artifact whose schema
//       declares no `handoff:` field (the CLI's `completeHandler` rejects this
//       with a usage error — see the "dogfood: /brainstorm documented..." comment
//       in src/commands/handlers.ts) — or the inverse: an artifact that DOES
//       require --handoff being completed without one
//   (c) a Task-dispatch instruction naming a worker agent file that does not
//       exist under plugin/agents/
//
// This file scans the real command markdown for each of the three shapes above
// and asserts the citation resolves against the real filesystem / real schemas.

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);
const COMMANDS_DIR = path.join(REPO_ROOT, 'plugin', 'commands');

function commandFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...commandFiles(full));
    else if (entry.name.endsWith('.md') && entry.name.toLowerCase() !== 'readme.md') out.push(full);
  }
  return out;
}

const files = [...commandFiles(COMMANDS_DIR), path.resolve(COMMANDS_DIR, '../adapters/workflow.md')];

function relFile(file: string): string {
  return path.relative(REPO_ROOT, file);
}

// ---------------------------------------------------------------------------
// (a) dead plugin-internal path references
// ---------------------------------------------------------------------------

// Only these top-level roots are "plugin-internal" citations worth checking —
// everything else (external URLs, ${VAR}/~-rooted paths, runtime-generated
// locations under .spindle/, work/, verification/, findings.json) is either
// out of scope or already excluded by construction below (the character class
// stops at `$`, `~`, `<`, `>`, `{`, `}`, `*` — variable/placeholder/glob forms).
//
// `plugin/agents|skills|kb` may stand alone (they're unambiguous directory
// citations — real `--agents <dir>` / `--kb <dir>` CLI flag values). `docs`,
// `schemas`, and `tasks` are common English words, so they require BOTH a
// trailing `/segment` AND a recognized file extension to count as a citation —
// otherwise "the tasks are too coarse" or an illustrative git branch name
// like `docs/kb-redis-patterns` would misfire as a dead-file finding.
const NOT_PATH_CHARS = "\\s`'\")(,;<>{}$~*";
const PLUGIN_DIR_RE = new RegExp(`\\bplugin\\/(?:agents|skills|kb)(?:\\/[^${NOT_PATH_CHARS}]+)?`, 'g');
const TOP_LEVEL_RE = new RegExp(`\\b(?:docs|schemas|tasks)\\/[^${NOT_PATH_CHARS}]+`, 'g');
const HAS_EXTENSION_RE = /\.[A-Za-z0-9]{1,6}$/;

function stripTrailingPunctuation(token: string): string {
  return token.replace(/[.,;:)\]}>]+$/, '');
}

interface PathReference {
  file: string;
  line: number;
  token: string;
}

function extractPathTokensFromLine(line: string): string[] {
  const tokens: string[] = [];
  PLUGIN_DIR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PLUGIN_DIR_RE.exec(line)) !== null) {
    tokens.push(stripTrailingPunctuation(m[0]));
  }
  TOP_LEVEL_RE.lastIndex = 0;
  while ((m = TOP_LEVEL_RE.exec(line)) !== null) {
    const token = stripTrailingPunctuation(m[0]);
    if (HAS_EXTENSION_RE.test(token)) tokens.push(token);
  }
  return tokens;
}

function collectPathReferences(): PathReference[] {
  const refs: PathReference[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    let inFence = false;
    let fenceLang = '';
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fenceMatch = line.match(/^\s*```(\w*)/);
      if (fenceMatch) {
        if (!inFence) {
          inFence = true;
          fenceLang = fenceMatch[1].toLowerCase();
        } else {
          inFence = false;
          fenceLang = '';
        }
        continue;
      }
      // Fenced blocks tagged `markdown`/`md`/`text` are almost always literal
      // OUTPUT TEMPLATES being demonstrated (e.g. readme-maker.md shows the
      // README it will generate for a *different* project) — not citations of
      // files that must exist in *this* repo. Skip them.
      if (inFence && (fenceLang === 'markdown' || fenceLang === 'md' || fenceLang === 'text')) {
        continue;
      }
      // A markdown link `[text](path)` is example/placeholder link syntax in
      // these docs (verified: the only two occurrences in the whole commands
      // tree are readme-maker.md's generated-README template) — a real
      // citation in this codebase always uses a backtick code span or a bare
      // CLI argument, never `[label](url)`. Skip link-syntax lines.
      if (line.includes('](')) continue;

      for (const token of extractPathTokensFromLine(line)) {
        // Obvious placeholders / runtime-substituted forms slip through in
        // pathological cases (e.g. a bare directory left after a
        // `<placeholder>` segment was excluded) — belt-and-suspenders skip
        // for anything that still looks templated.
        if (/[<>${~*]/.test(token)) continue;
        refs.push({ file, line: i + 1, token });
      }
    }
  }
  return refs;
}

describe('command docs cite only real plugin-internal paths', () => {
  it('finds path references to check', () => {
    expect(collectPathReferences().length).toBeGreaterThan(5);
  });

  it('every cited plugin/agents, plugin/skills, docs, schemas, or tasks path exists on disk', () => {
    const refs = collectPathReferences();
    const bad: string[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      const abs = path.join(REPO_ROOT, ref.token);
      if (fs.existsSync(abs)) continue;
      const key = `${relFile(ref.file)}:${ref.line}:${ref.token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      bad.push(`${relFile(ref.file)}:${ref.line}: dead reference "${ref.token}" (no such file or directory)`);
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (b) `spin complete <id> [--handoff]` vs the artifact's declared handoff schema
// ---------------------------------------------------------------------------

const SCHEMA_FILES = ['sdd', 'kb', 'brownfield'].map((name) =>
  path.join(REPO_ROOT, 'schemas', name, 'schema.yaml')
);

// id -> true if ANY schema declares a `handoff:` field for that artifact id.
// id -> present in ANY schema at all (known vs invented id).
function loadArtifactHandoffMap(): { withHandoff: Set<string>; known: Set<string> } {
  const withHandoff = new Set<string>();
  const known = new Set<string>();
  for (const schemaFile of SCHEMA_FILES) {
    const schema = loadSchema(schemaFile);
    for (const artifact of schema.artifacts) {
      known.add(artifact.id);
      if (artifact.handoff) withHandoff.add(artifact.id);
    }
  }
  return { withHandoff, known };
}

// Matches a real CLI invocation of `complete <id>` — anchored on the literal
// "spin complete" or "index.js complete" so English prose ("mark the artifact
// complete without...", "the graph is complete") never matches: those phrases
// never contain either literal substring immediately before the next word.
const COMPLETE_RE = /(?:spin complete|index\.js complete)\s+([a-z][a-z0-9-]*)/g;

interface CompleteInvocation {
  file: string;
  line: number;
  id: string;
  hasHandoff: boolean;
}

function collectCompleteInvocations(): CompleteInvocation[] {
  const out: CompleteInvocation[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      // Bash line-continuation: `spin complete build \` / `  --handoff ...json`
      // is one logical invocation split across two lines. Join a single
      // trailing-backslash continuation so `--handoff` on the next line is seen.
      let combined = lines[i];
      if (/\\\s*$/.test(lines[i]) && i + 1 < lines.length) {
        combined = lines[i].replace(/\\\s*$/, '') + ' ' + lines[i + 1];
      }
      COMPLETE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = COMPLETE_RE.exec(combined)) !== null) {
        const hasHandoff = combined.slice(m.index).includes('--handoff');
        out.push({ file, line: i + 1, id: m[1], hasHandoff });
      }
    }
  }
  return out;
}

describe('command docs promise `spin complete --handoff` only where the schema agrees', () => {
  it('finds `spin complete` invocations to check', () => {
    expect(collectCompleteInvocations().length).toBeGreaterThan(3);
  });

  it('every `spin complete <id> --handoff` names an id that declares handoff, and every bare `spin complete <id>` names one that declares none', () => {
    const { withHandoff, known } = loadArtifactHandoffMap();
    const invocations = collectCompleteInvocations();
    const bad: string[] = [];
    for (const inv of invocations) {
      const where = `${relFile(inv.file)}:${inv.line}`;
      if (!known.has(inv.id)) {
        bad.push(`${where}: "spin complete ${inv.id}" — "${inv.id}" is not a known artifact id in any schema`);
        continue;
      }
      const declaresHandoff = withHandoff.has(inv.id);
      if (inv.hasHandoff && !declaresHandoff) {
        bad.push(
          `${where}: "spin complete ${inv.id} --handoff ..." but artifact "${inv.id}" declares no handoff schema — remove --handoff`
        );
      } else if (!inv.hasHandoff && declaresHandoff) {
        bad.push(
          `${where}: "spin complete ${inv.id}" without --handoff, but artifact "${inv.id}" requires one`
        );
      }
    }
    expect(bad).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// (c) Task-dispatch instructions naming a real worker agent file
// ---------------------------------------------------------------------------

const AGENT_PATH_RE = /plugin\/agents\/[^\s`'")(,;<>{}$~]+\.md/g;

interface AgentDispatchReference {
  file: string;
  line: number;
  token: string;
}

// A "Task-dispatch instruction" is any line within a reasonable window of a
// literal mention of the Task tool. Real dispatch prose in this codebase
// always cites the agent immediately before/after that mention (see
// review/review.md's challenger dispatch), so an 8-line window is generous
// without being so wide it starts picking up unrelated agent citations.
const DISPATCH_WINDOW = 8;

function collectAgentDispatchReferences(): AgentDispatchReference[] {
  const refs: AgentDispatchReference[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, 'utf-8').split('\n');
    const dispatchLines: number[] = [];
    for (let i = 0; i < lines.length; i++) {
      if (/task tool|task\(/i.test(lines[i])) dispatchLines.push(i);
    }
    if (dispatchLines.length === 0) continue;
    const seen = new Set<string>();
    for (const dispatchLine of dispatchLines) {
      const start = Math.max(0, dispatchLine - DISPATCH_WINDOW);
      const end = Math.min(lines.length, dispatchLine + DISPATCH_WINDOW + 1);
      for (let i = start; i < end; i++) {
        AGENT_PATH_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = AGENT_PATH_RE.exec(lines[i])) !== null) {
          const token = stripTrailingPunctuation(m[0]);
          if (/[<>${~]/.test(token)) continue;
          const key = `${i}:${token}`;
          if (seen.has(key)) continue;
          seen.add(key);
          refs.push({ file, line: i + 1, token });
        }
      }
    }
  }
  return refs;
}

describe('Task-dispatch instructions name only real worker agent files', () => {
  it('every plugin/agents/*.md cited near a Task-tool dispatch instruction exists on disk', () => {
    const refs = collectAgentDispatchReferences();
    const bad: string[] = [];
    for (const ref of refs) {
      const abs = path.join(REPO_ROOT, ref.token);
      if (fs.existsSync(abs)) continue;
      bad.push(`${relFile(ref.file)}:${ref.line}: Task-dispatch cites "${ref.token}" — no such agent file`);
    }
    expect(bad).toEqual([]);
  });
});
