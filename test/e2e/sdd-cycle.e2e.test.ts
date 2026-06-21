import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject, write, writeJson } from '../helpers.js';

// THE deliverable test. Drives the full 5-phase SDD cycle through the real CLI,
// simulating the model layer with deterministic fixture files. Proves the harness
// BLOCKS when state is incomplete and only advances when state is real — the
// property no prose-only design can be tested for.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const R = (...args: string[]) => cli(['--root', root, ...args]);

describe('E2E: full SDD cycle through the spin CLI', () => {
  it('blocks on incomplete state and completes only when real', async () => {
    // --- init ---
    expect((await R('init', '--schema', 'sdd', '--feature', 'sample')).code).toBe(0);

    // ready wave includes define
    let next = await R('next');
    expect(next.json.ready.map((x: any) => x.id)).toContain('define');

    // --- Phase 0: brainstorm (optional, no gate) ---
    write(root, '.spindle/features/sample/BRAINSTORM.md', '# ideas\n');
    expect((await R('complete', 'brainstorm')).code).toBe(0);

    // --- Phase 1: define ---
    write(
      root,
      '.spindle/features/sample/DEFINE.md',
      '## Why\nusers need login\n## What\nan auth flow\n## Acceptance Criteria\n- AC-1 user can log in\n- AC-2 invalid creds rejected\n'
    );
    const defineHandoff = writeJson(root, 'work/define.json', {
      feature: 'sample',
      clarity: 0.95,
      criteria: ['AC-1', 'AC-2'],
    });
    expect((await R('validate', 'define')).code).toBe(0);
    expect((await R('complete', 'define', '--handoff', defineHandoff)).code).toBe(0);
    expect((await R('gate', 'G_DEFINE')).code).toBe(0);

    // design now ready
    next = await R('next');
    expect(next.json.ready.map((x: any) => x.id)).toContain('design');

    // --- Phase 2: design ---
    write(
      root,
      '.spindle/features/sample/DESIGN.md',
      '## Overview\nauth service\n## File Manifest\n\n| File | Action | Purpose |\n| --- | --- | --- |\n| src/auth.ts | create | login |\n| src/session.ts | create | sessions |\n\n## Decisions\nuse JWT\n'
    );
    const designHandoff = writeJson(root, 'work/design.json', {
      feature: 'sample',
      manifest: [
        { file: 'src/auth.ts', action: 'create', purpose: 'login' },
        { file: 'src/session.ts', action: 'create', purpose: 'sessions' },
      ],
      decisions: ['use JWT'],
    });
    expect((await R('complete', 'design', '--handoff', designHandoff)).code).toBe(0);
    expect((await R('gate', 'G_DESIGN')).code).toBe(0);

    // --- Phase 3: build — write ONLY one of two manifest files ---
    write(root, 'src/auth.ts', '// auth\n');
    write(root, '.spindle/features/sample/BUILD_REPORT.md', '# build report\n');
    const buildHandoff = writeJson(root, 'work/build.json', {
      feature: 'sample',
      results: [
        { criterion: 'AC-1', status: 'passed' },
        { criterion: 'AC-2', status: 'passed' },
      ],
      files_written: ['src/auth.ts'],
    });
    expect((await R('complete', 'build', '--handoff', buildHandoff)).code).toBe(0);

    // G_BUILD MUST BLOCK — src/session.ts is missing
    const blockedBuild = await R('gate', 'G_BUILD');
    expect(blockedBuild.code).toBe(1);
    expect(blockedBuild.json.unmet).toContain('src/session.ts');

    // fix the missing file
    write(root, 'src/session.ts', '// session\n');
    const passedBuild = await R('gate', 'G_BUILD');
    expect(passedBuild.code).toBe(0);

    // --- Phase 4: ship ---
    const diff = await R('diff-criteria', '--define', defineHandoff, '--build', buildHandoff);
    expect(diff.code).toBe(0);
    expect(diff.json.unmet).toEqual([]);
    expect((await R('gate', 'G_SHIP')).code).toBe(0);

    write(root, '.spindle/features/sample/SHIPPED.md', '# shipped\n');
    expect((await R('complete', 'ship')).code).toBe(0);

    // --- final state: everything complete ---
    const finalNext = await R('next');
    expect(finalNext.json.complete).toBe(true);
    const state = await R('state');
    expect(state.json.completed.sort()).toEqual(['brainstorm', 'build', 'define', 'design', 'ship']);
    expect(state.json.gates.G_BUILD.passed).toBe(true);
    expect(state.json.gates.G_SHIP.passed).toBe(true);
  });

  it('blocks ship when an acceptance criterion was never satisfied', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'partial');
    const defineHandoff = writeJson(root, 'work/define.json', {
      feature: 'partial',
      clarity: 0.9,
      criteria: ['AC-1', 'AC-2'],
    });
    const buildHandoff = writeJson(root, 'work/build.json', {
      feature: 'partial',
      results: [{ criterion: 'AC-1', status: 'passed' }],
    });
    write(root, '.spindle/features/partial/DEFINE.md', '## Why\nx\n## What\ny\n## Acceptance Criteria\nAC-1 a\nAC-2 b\n');
    await R('complete', 'define', '--handoff', defineHandoff);
    // even with the define+build handoffs present, G_SHIP must block on AC-2
    fs.copyFileSync(buildHandoff, `${root}/.spindle/features/partial/.handoffs/build.json`);
    const ship = await R('gate', 'G_SHIP');
    expect(ship.code).toBe(1);
    expect(ship.json.unmet).toContain('AC-2');
  });
});
