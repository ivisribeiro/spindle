// Generates the state-coupled eval fixtures (G_DEFINE/DESIGN/BUILD/SHIP + KB
// G_KB_STRUCTURE/COVERAGE) under schemas/evals/. Each case dir IS the gate root, so
// it carries a real `.spindle/` tree (run.json + schema.yaml + feature artifacts +
// handoffs). The arg-file gates (G_AUDIT/OPS_CONFIG/PLAN/REVIEW_BLOCK/ROUTER_COVERAGE)
// are authored separately and not touched here. Re-run after a gate-shape change:
//   node scripts/gen-eval-fixtures.mjs && node dist/cli/index.js eval --strict
//
// This is fixture-authoring tooling, not the spine — it never calls a model.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evalsDir = path.join(repoRoot, 'schemas', 'evals');
const sddSchema = fs.readFileSync(path.join(repoRoot, 'schemas', 'sdd', 'schema.yaml'), 'utf-8');
const kbSchema = fs.readFileSync(path.join(repoRoot, 'schemas', 'kb', 'schema.yaml'), 'utf-8');

const TS = '2026-06-22T00:00:00.000Z';
const runState = (schema, feature, approval = null) => ({
  version: 1,
  schema,
  feature,
  completed: [],
  retries: {},
  gates: {},
  events: [],
  approval,
  createdAt: TS,
  updatedAt: TS,
});

/** Write a fixture: { name, schemaYaml, feature, files{rel:content}, runState, case } */
function writeFixture(fx) {
  const dir = path.join(evalsDir, fx.name);
  fs.rmSync(dir, { recursive: true, force: true });
  const spindle = path.join(dir, '.spindle');
  const feat = path.join(spindle, 'features', fx.feature);
  fs.mkdirSync(path.join(feat, '.handoffs'), { recursive: true });
  fs.writeFileSync(path.join(spindle, 'schema.yaml'), fx.schemaYaml);
  fs.writeFileSync(path.join(spindle, 'run.json'), JSON.stringify(fx.runState, null, 2) + '\n');
  for (const [rel, content] of Object.entries(fx.files ?? {})) {
    const target = path.join(dir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
  fs.writeFileSync(path.join(dir, 'case.json'), JSON.stringify(fx.case, null, 2) + '\n');
  console.log(`wrote ${fx.name} (${fx.case.gate} → ${fx.case.expect})`);
}

const j = (o) => JSON.stringify(o, null, 2) + '\n';
const F = 'feat'; // SDD feature slug
const D = 'demo'; // KB domain slug
const f = (rel) => `.spindle/features/${F}/${rel}`;
const fk = (rel) => `.spindle/features/${D}/${rel}`;

const DEFINE_OK = `# DEFINE — feat

## Why
A deterministic example so the gate has something honest to certify.

## What
A minimal feature with a single stable acceptance criterion.

## Acceptance Criteria
- AC-1: the example exists and is verifiable.
`;

const DEFINE_NO_AC = `# DEFINE — feat

## Why
A deterministic example.

## What
A minimal feature — but the Acceptance Criteria section was forgotten.
`;

const DESIGN_OK = `# DESIGN — feat

## Overview
One file implements the example.

## File Manifest
| File | Action | Purpose |
|---|---|---|
| src/a.ts | create | implement the example |

## Decisions
- Keep it to one module.
`;

const DESIGN_NO_TABLE = `# DESIGN — feat

## Overview
One file implements the example.

## File Manifest
To be decided — no manifest table authored yet.

## Decisions
- Keep it to one module.
`;

const defineHandoff = j({ feature: F, clarity: 0.9, criteria: ['AC-1'], open_questions: [] });
const designHandoff = (file) =>
  j({ feature: F, manifest: [{ file, action: 'create', purpose: 'implement' }], decisions: [], technologies: [] });
const buildHandoff = j({ feature: F, results: [{ criterion: 'AC-1', status: 'passed' }], files_written: [] });

// ---- SDD fixtures ----
writeFixture({
  name: 'G_DEFINE-pass',
  schemaYaml: sddSchema,
  feature: F,
  runState: runState('sdd', F),
  files: { [f('DEFINE.md')]: DEFINE_OK, [f('.handoffs/define.json')]: defineHandoff },
  case: { id: 'G_DEFINE-pass', gate: 'G_DEFINE', expect: 'pass', args: {}, note: 'all sections present + a valid define handoff' },
});

writeFixture({
  name: 'G_DEFINE-block',
  schemaYaml: sddSchema,
  feature: F,
  runState: runState('sdd', F),
  files: { [f('DEFINE.md')]: DEFINE_NO_AC, [f('.handoffs/define.json')]: defineHandoff },
  case: { id: 'G_DEFINE-block', gate: 'G_DEFINE', expect: 'block', args: {}, note: 'DEFINE.md is missing the Acceptance Criteria section (section:Acceptance Criteria)' },
});

writeFixture({
  name: 'G_DESIGN-pass',
  schemaYaml: sddSchema,
  feature: F,
  runState: runState('sdd', F),
  files: { [f('DESIGN.md')]: DESIGN_OK, [f('.handoffs/design.json')]: designHandoff('src/a.ts') },
  case: { id: 'G_DESIGN-pass', gate: 'G_DESIGN', expect: 'pass', args: {}, note: 'sections + manifest table + valid design handoff' },
});

writeFixture({
  name: 'G_DESIGN-block',
  schemaYaml: sddSchema,
  feature: F,
  runState: runState('sdd', F),
  files: { [f('DESIGN.md')]: DESIGN_NO_TABLE, [f('.handoffs/design.json')]: designHandoff('src/a.ts') },
  case: { id: 'G_DESIGN-block', gate: 'G_DESIGN', expect: 'block', args: {}, note: 'DESIGN has no file-manifest table (manifest-table)' },
});

writeFixture({
  name: 'G_BUILD-pass',
  schemaYaml: sddSchema,
  feature: F,
  runState: runState('sdd', F),
  files: {
    [f('BUILD_REPORT.md')]: '# BUILD REPORT — feat\n\nAC-1 satisfied.\n',
    [f('.handoffs/design.json')]: designHandoff('built.txt'),
    [f('.handoffs/define.json')]: defineHandoff,
    [f('.handoffs/build.json')]: buildHandoff,
    'built.txt': 'the manifest file, present on disk\n', // path.join(root, "built.txt")
  },
  case: { id: 'G_BUILD-pass', gate: 'G_BUILD', expect: 'pass', args: {}, note: 'manifest file exists, AC-1 satisfied, BUILD_REPORT present' },
});

writeFixture({
  name: 'G_BUILD-block',
  schemaYaml: sddSchema,
  feature: F,
  runState: runState('sdd', F),
  files: {
    [f('BUILD_REPORT.md')]: '# BUILD REPORT — feat\n',
    [f('.handoffs/design.json')]: designHandoff('missing.txt'), // missing.txt is NOT created
    [f('.handoffs/define.json')]: defineHandoff,
    [f('.handoffs/build.json')]: buildHandoff,
  },
  case: { id: 'G_BUILD-block', gate: 'G_BUILD', expect: 'block', args: {}, note: 'manifest declares missing.txt which was not built (unmet: missing.txt)' },
});

function shipFixture(name, expect, note, approvalKind, results = [{ criterion: 'AC-1', status: 'passed' }]) {
  const files = {
    [f('DEFINE.md')]: DEFINE_OK,
    [f('DESIGN.md')]: DESIGN_OK,
    [f('BUILD_REPORT.md')]: '# BUILD REPORT — feat\n\nAC-1 satisfied.\n',
    [f('.handoffs/define.json')]: defineHandoff,
    [f('.handoffs/design.json')]: designHandoff('src/a.ts'),
    [f('.handoffs/build.json')]: j({ feature: F, results, files_written: ['src/a.ts'] }),
    'src/a.ts': 'export const example = true;\n',
  };
  const signed = { ...files, '.spindle/schema.yaml': sddSchema };
  const snapshot = {
    version: 1,
    files: Object.keys(signed).sort().map((file) => ({
      path: file,
      sha256: createHash('sha256').update(signed[file]).digest('hex'),
    })),
  };
  const approval = approvalKind === 'missing' ? null : {
    at: TS,
    by: 'tester',
    ...(approvalKind === 'legacy' ? {} : { snapshot }),
  };
  if (approvalKind === 'stale') files['src/a.ts'] += '// edited after approval\n';
  writeFixture({
    name, schemaYaml: sddSchema, feature: F, runState: runState('sdd', F, approval),
    files, case: { id: name, gate: 'G_SHIP', expect, args: {}, note },
  });
}

shipFixture('G_SHIP-pass', 'pass', 'all criteria met and approval matches the captured files', 'bound');
shipFixture('G_SHIP-block', 'block', 'criteria met but no human approval was recorded', 'missing');
shipFixture('G_SHIP-stale-approval-block', 'block', 'a manifest file changed after approval', 'stale');
shipFixture('G_SHIP-legacy-approval-block', 'block', 'approval from a legacy ledger lacks file evidence', 'legacy');

const corrected = {
  criterion: 'AC-1', status: 'passed', corrected_spec: true, correction: 'CRC 29B1 not 1D3D',
};
shipFixture('G_SHIP-spec-drift-block', 'block', 'the recorded spec correction is unresolved', 'bound', [corrected]);
shipFixture('G_SHIP-spec-drift-reconciled-pass', 'pass', 'the recorded spec correction is reconciled', 'bound', [
  { ...corrected, reconciled: true },
]);

// ---- KB fixtures ----
const manifestOk = j({ concepts: [{ slug: 'alpha' }] });
const kbConcept = (testCases) => j({ concept: 'alpha', summary: 'the alpha concept', test_cases: testCases, needs_decoding: false });

writeFixture({
  name: 'G_KB_STRUCTURE-pass',
  schemaYaml: kbSchema,
  feature: D,
  runState: runState('kb', D),
  files: {
    [fk('index.md')]: '# demo\n\n- [alpha](concept-alpha.md)\n',
    [fk('quick-reference.md')]: '# demo — quick reference\n\nalpha: the alpha concept.\n',
    [fk('manifest.json')]: manifestOk,
    [fk('concept-alpha.md')]: '# alpha\n\nThe alpha concept.\n',
  },
  case: { id: 'G_KB_STRUCTURE-pass', gate: 'G_KB_STRUCTURE', expect: 'pass', args: {}, note: 'index + quick-reference + valid manifest + a concept file' },
});

writeFixture({
  name: 'G_KB_STRUCTURE-block',
  schemaYaml: kbSchema,
  feature: D,
  runState: runState('kb', D),
  files: {
    [fk('index.md')]: '# demo\n',
    [fk('quick-reference.md')]: '# demo — quick reference\n',
    [fk('concept-alpha.md')]: '# alpha\n\nThe alpha concept.\n',
    // manifest.json intentionally omitted
  },
  case: { id: 'G_KB_STRUCTURE-block', gate: 'G_KB_STRUCTURE', expect: 'block', args: {}, note: 'manifest.json is missing (unmet: manifest.json)' },
});

writeFixture({
  name: 'G_KB_COVERAGE-pass',
  schemaYaml: kbSchema,
  feature: D,
  runState: runState('kb', D),
  files: {
    [fk('manifest.json')]: manifestOk,
    [fk('concept-alpha.md')]: '# alpha\n\nThe alpha concept.\n',
    [fk('.handoffs/kb-concept-alpha.json')]: kbConcept(['decode the alpha header']),
  },
  case: { id: 'G_KB_COVERAGE-pass', gate: 'G_KB_COVERAGE', expect: 'pass', args: {}, note: 'every manifest concept has a file and >=1 test case' },
});

writeFixture({
  name: 'G_KB_COVERAGE-block',
  schemaYaml: kbSchema,
  feature: D,
  runState: runState('kb', D),
  files: {
    [fk('manifest.json')]: manifestOk,
    [fk('concept-alpha.md')]: '# alpha\n\nThe alpha concept.\n',
    [fk('.handoffs/kb-concept-alpha.json')]: kbConcept([]), // zero test cases
  },
  case: { id: 'G_KB_COVERAGE-block', gate: 'G_KB_COVERAGE', expect: 'block', args: {}, note: 'concept alpha has zero test cases, min 1 (unmet: test-cases:alpha)' },
});

console.log('\n16 state-coupled fixtures generated under schemas/evals/.');
