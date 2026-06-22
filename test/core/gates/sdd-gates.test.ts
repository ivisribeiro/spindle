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

  function buildAllFiles() {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), '// a');
    fs.writeFileSync(path.join(root, 'src', 'b.ts'), '// b');
  }

  it('BLOCKS a phantom criterion the build passes but DEFINE never declared (set-drift)', () => {
    buildAllFiles();
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-2', status: 'passed' },
        { criterion: 'AC-9', status: 'passed' }, // not in DEFINE
      ],
    });
    const r = gBuild(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('phantom:AC-9');
  });

  it('BLOCKS when a passed criterion cites a verified_by file that does not exist', () => {
    buildAllFiles();
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed', verified_by: 'test/missing.test.ts' },
        { criterion: 'AC-2', status: 'passed' },
      ],
    });
    const r = gBuild(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('evidence-missing:AC-1');
  });

  it('BLOCKS a passed criterion whose CI verifier reported failed (A2)', () => {
    buildAllFiles();
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'a.test.ts'), '// t');
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed', verified_by: 'test/a.test.ts', verified_by_result: 'failed' },
        { criterion: 'AC-2', status: 'passed' },
      ],
    });
    const r = gBuild(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('verifier-failed:AC-1');
  });

  it('requires a verifier on every passed criterion when config.require_verified_by (A2)', () => {
    buildAllFiles();
    const strict = {
      ...ctx,
      graph: ArtifactGraph.fromYamlContent(SDD_YAML + '\nconfig:\n  require_verified_by: true\n'),
    };
    const r = gBuild(strict);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('missing-verifier:AC-2');
  });

  it('passes with require_verified_by when every passed criterion cites an existing verifier (A2)', () => {
    buildAllFiles();
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'a.test.ts'), '// t');
    fs.writeFileSync(path.join(root, 'test', 'b.test.ts'), '// t');
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed', verified_by: 'test/a.test.ts', verified_by_result: 'passed' },
        { criterion: 'AC-2', status: 'passed', verified_by: 'test/b.test.ts', verified_by_result: 'passed' },
      ],
    });
    const strict = {
      ...ctx,
      graph: ArtifactGraph.fromYamlContent(SDD_YAML + '\nconfig:\n  require_verified_by: true\n'),
    };
    expect(gBuild(strict).passed).toBe(true);
  });

  it('PASSES when a cited verifier file exists', () => {
    buildAllFiles();
    fs.mkdirSync(path.join(root, 'test'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test', 'x.test.ts'), '// t');
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed', verified_by: 'test/x.test.ts' },
        { criterion: 'AC-2', status: 'passed' },
      ],
    });
    expect(gBuild(ctx).passed).toBe(true);
  });

  it('does NOT require existence for a verified_by that is a command, not a path', () => {
    buildAllFiles();
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed', verified_by: 'npm run e2e' },
        { criterion: 'AC-2', status: 'passed' },
      ],
    });
    expect(gBuild(ctx).passed).toBe(true);
  });

  // Adversary-found false-block vectors: none of these are POSIX repo paths, so they
  // must be ACCEPTED without an existence check rather than blocking a legit build.
  it('does NOT existence-check non-repo-path verified_by values (URL / Windows / version)', () => {
    for (const v of [
      'https://crccalc.com/run/123',
      'http://ci.example.com/job/y.ts',
      'C:\\Users\\dev\\test\\pix.test.ts',
      'src\\a.ts',
      'v1.2',
      '1.0',
    ]) {
      buildAllFiles();
      writeHandoff('build', {
        feature: 'feat',
        results: [
          { criterion: 'AC-1', status: 'passed', verified_by: v },
          { criterion: 'AC-2', status: 'passed' },
        ],
      });
      expect(gBuild(ctx).passed, `verified_by=${v} should not false-block`).toBe(true);
    }
  });

  it('BLOCKS when reported test coverage is below its threshold (coverage floor)', () => {
    buildAllFiles();
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-2', status: 'passed' },
      ],
      coverage: { tool: 'vitest', pct: 50, threshold: 80 },
    });
    const r = gBuild(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('coverage-below-threshold');
  });

  it('PASSES when reported coverage meets its threshold', () => {
    buildAllFiles();
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-2', status: 'passed' },
      ],
      coverage: { tool: 'vitest', pct: 92, threshold: 80 },
    });
    expect(gBuild(ctx).passed).toBe(true);
  });
});

describe('G_SHIP', () => {
  const approve = () => {
    ctx.runState = { approval: { at: '2026-01-01T00:00:00.000Z', by: 'tester' } } as unknown as typeof ctx.runState;
  };

  it('blocks when criteria are met but there is no human approval (A1)', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1'] });
    writeHandoff('build', { feature: 'feat', results: [{ criterion: 'AC-1', status: 'passed' }] });
    const r = gShip(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('approval');
  });

  it('blocks on any unmet acceptance criterion', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1', 'AC-2'] });
    writeHandoff('build', { feature: 'feat', results: [{ criterion: 'AC-1', status: 'passed' }] });
    expect(gShip(ctx).passed).toBe(false);
  });

  it('passes when all criteria are met and a human approved', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1'] });
    writeHandoff('build', { feature: 'feat', results: [{ criterion: 'AC-1', status: 'passed' }] });
    approve();
    expect(gShip(ctx).passed).toBe(true);
  });

  it('BLOCKS a phantom criterion at ship (build/define set-drift)', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1'] });
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-7', status: 'passed' }, // not in DEFINE
      ],
    });
    const r = gShip(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('phantom:AC-7');
  });

  it('passes but SURFACES spec-drift when the build corrected a criterion (I-C / F6)', () => {
    writeHandoff('define', { feature: 'feat', clarity: 1, criteria: ['AC-1'] });
    writeHandoff('build', {
      feature: 'feat',
      results: [
        { criterion: 'AC-1', status: 'passed', corrected_spec: true, correction: 'CRC 29B1 not 1D3D' },
      ],
    });
    approve();
    const r = gShip(ctx);
    expect(r.passed).toBe(true); // a legitimate correction does not block ship
    expect(r.reasons.some((x) => x.includes('CORRECTED') && x.includes('AC-1'))).toBe(true);
  });
});

describe('G_DEFINE clarity floor (config-driven)', () => {
  const FLOOR_YAML = SDD_YAML + '\nconfig:\n  clarity_floor: 0.8\n';
  function defineReady(clarity: number) {
    writeArtifact('DEFINE.md', '## Why\nx\n## What\ny\n## Acceptance Criteria\n- AC-1 a\n');
    writeHandoff('define', { feature: 'feat', clarity, criteria: ['AC-1'] });
  }

  it('blocks when clarity is below the configured floor', () => {
    const c: GateContext = { ...ctx, graph: ArtifactGraph.fromYamlContent(FLOOR_YAML) };
    defineReady(0.5);
    const r = gDefine(c);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('clarity-floor');
  });

  it('passes when clarity is at/above the configured floor', () => {
    const c: GateContext = { ...ctx, graph: ArtifactGraph.fromYamlContent(FLOOR_YAML) };
    defineReady(0.9);
    expect(gDefine(c).passed).toBe(true);
  });

  it('does not enforce clarity when no floor is configured (default)', () => {
    defineReady(0.1); // far below any sane floor, but the default schema sets none
    expect(gDefine(ctx).passed).toBe(true);
  });
});
