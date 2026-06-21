import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ArtifactGraph } from '../../../src/core/artifact-graph/graph.js';
import { gDefine, gDesign, gBuild, gShip } from '../../../src/core/gates/sdd-gates.js';
import type { GateContext } from '../../../src/core/gates/types.js';

const SDD_YAML = `
name: sdd
version: 1
artifacts:
  - id: define
    generates: DEFINE.md
    handoff: define
    requires: []
  - id: design
    generates: DESIGN.md
    handoff: design
    requires: [define]
  - id: build
    generates: BUILD_REPORT.md
    handoff: build-report
    requires: [design]
`;

let root: string;
let featureDir: string;
let handoffDir: string;
let ctx: GateContext;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-gate-'));
  featureDir = path.join(root, '.spindle', 'features', 'feat');
  handoffDir = path.join(featureDir, '.handoffs');
  fs.mkdirSync(handoffDir, { recursive: true });
  ctx = {
    root,
    args: {},
    runState: null,
    graph: ArtifactGraph.fromYamlContent(SDD_YAML),
    featureDir,
    handoffDir,
  };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeArtifact(name: string, body: string) {
  fs.writeFileSync(path.join(featureDir, name), body);
}
function writeHandoff(id: string, obj: unknown) {
  fs.writeFileSync(path.join(handoffDir, `${id}.json`), JSON.stringify(obj));
}

describe('G_DEFINE', () => {
  it('blocks when DEFINE is missing', () => {
    expect(gDefine(ctx).passed).toBe(false);
  });

  it('blocks when required sections are missing', () => {
    writeArtifact('DEFINE.md', '## Why\nbecause\n');
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1'] });
    const r = gDefine(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('section:What');
  });

  it('passes with all sections + a valid handoff', () => {
    writeArtifact('DEFINE.md', '## Why\nx\n## What\ny\n## Acceptance Criteria\nAC-1 do thing\n');
    writeHandoff('define', { feature: 'feat', clarity: 0.9, criteria: ['AC-1'] });
    expect(gDefine(ctx).passed).toBe(true);
  });
});

describe('G_DESIGN', () => {
  it('blocks without a manifest table', () => {
    writeArtifact('DESIGN.md', '## Overview\nx\n## File Manifest\nnone\n## Decisions\nd\n');
    writeHandoff('design', { feature: 'feat', manifest: [{ file: 'a.ts', action: 'create', purpose: 'p' }] });
    expect(gDesign(ctx).passed).toBe(false);
  });

  it('passes with sections + table', () => {
    writeArtifact(
      'DESIGN.md',
      '## Overview\nx\n## File Manifest\n\n| File | Action | Purpose |\n| --- | --- | --- |\n| a.ts | create | p |\n\n## Decisions\nd\n'
    );
    writeHandoff('design', { feature: 'feat', manifest: [{ file: 'a.ts', action: 'create', purpose: 'p' }] });
    expect(gDesign(ctx).passed).toBe(true);
  });
});

describe('G_BUILD (replaces the prose checkbox)', () => {
  beforeEach(() => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1', 'AC-2'] });
    writeHandoff('design', {
      feature: 'feat',
      manifest: [
        { file: 'src/a.ts', action: 'create', purpose: 'p' },
        { file: 'src/b.ts', action: 'create', purpose: 'p' },
      ],
    });
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-2', status: 'passed' },
      ],
    });
    writeArtifact('BUILD_REPORT.md', '# build\n');
  });

  it('BLOCKS when a manifest file was not built', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// a');
    const r = gBuild(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('src/b.ts');
  });

  it('PASSES once every manifest file exists and criteria are met', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// a');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), '// b');
    expect(gBuild(ctx).passed).toBe(true);
  });

  it('BLOCKS when an acceptance criterion is unmet', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// a');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), '// b');
    writeHandoff('build', { feature: 'feat', results: [{ criterion: 'AC-1', status: 'passed' }] });
    const r = gBuild(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('AC-2');
  });

  it('is idempotent: re-running from identical files yields an identical verdict', () => {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// a');
    const a = gBuild(ctx);
    const b = gBuild(ctx);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('G_SHIP', () => {
  it('blocks on any unmet acceptance criterion', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1', 'AC-2'] });
    writeHandoff('build', { feature: 'feat', results: [{ criterion: 'AC-1', status: 'passed' }] });
    expect(gShip(ctx).passed).toBe(false);
  });

  it('passes when all criteria are met', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1'] });
    writeHandoff('build', { feature: 'feat', results: [{ criterion: 'AC-1', status: 'passed' }] });
    expect(gShip(ctx).passed).toBe(true);
  });
});
