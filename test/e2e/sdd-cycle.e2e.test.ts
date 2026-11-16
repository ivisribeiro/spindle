import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { loadRunState, saveRunState } from '../../src/core/run/run-state.js';
import { approveFixture, cli, tmpProject, write, writeJson } from '../helpers.js';

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
    write(root, 'src/auth.test.ts', '// verifier fixture\n');
    const buildHandoff = writeJson(root, 'work/build.json', {
      feature: 'sample',
      results: [
        { criterion: 'AC-1', status: 'passed', verified_by: 'src/auth.test.ts' },
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
    // human sign-off — `spin approve` is TTY-gated (no TTY in the test runner), so record
    // it directly; G_SHIP requires it.
    approveFixture(root);
    expect((await R('gate', 'G_SHIP')).code).toBe(0);

    write(root, '.spindle/features/sample/SHIPPED.md', '# shipped\n');
    for (const file of [
      '.spindle/features/sample/DEFINE.md',
      '.spindle/features/sample/.handoffs/build.json',
      'src/auth.ts',
      'src/auth.test.ts',
    ]) {
      const original = fs.readFileSync(`${root}/${file}`, 'utf8');
      write(root, file, original + '\n');
      const blocked = await R('complete', 'ship');
      expect(blocked.code).toBe(1);
      expect(blocked.json.unmet).toEqual(['approval-stale', file]);
      write(root, file, original);
      expect((await R('gate', 'G_SHIP')).code).toBe(0);
    }

    const ledger = loadRunState(root);
    saveRunState(root, { ...ledger, approval: { at: ledger.approval!.at, by: ledger.approval!.by } });
    const legacy = await R('complete', 'ship');
    expect(legacy.code).toBe(1);
    expect(legacy.json.unmet).toEqual(['approval-unbound']);

    approveFixture(root);
    expect((await R('complete', 'ship')).json.unmet).toEqual(['G_SHIP']);
    expect((await R('gate', 'G_SHIP')).code).toBe(0);
    expect((await R('complete', 'ship')).code).toBe(0);

    // --- final state: everything complete ---
    const finalNext = await R('next');
    expect(finalNext.json.complete).toBe(true);
    const state = await R('state');
    expect(state.json.completed.sort()).toEqual(['brainstorm', 'build', 'define', 'design', 'ship']);
    expect(state.json.gates.G_BUILD.passed).toBe(true);
    expect(state.json.gates.G_SHIP.passed).toBe(true);
  });

  it('blocks completing design until G_DEFINE has passed (lifecycle gate enforcement)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'lc');
    write(root, '.spindle/features/lc/DEFINE.md', '## Why\nx\n## What\ny\n## Acceptance Criteria\n- AC-1 a\n');
    const dh = writeJson(root, 'work/define.json', { feature: 'lc', clarity: 0.9, criteria: ['AC-1'] });
    expect((await R('complete', 'define', '--handoff', dh)).code).toBe(0);

    write(
      root,
      '.spindle/features/lc/DESIGN.md',
      '## Overview\no\n## File Manifest\n\n| File | Action | Purpose |\n| --- | --- | --- |\n| src/a.ts | create | x |\n\n## Decisions\nd\n'
    );
    const gh = writeJson(root, 'work/design.json', {
      feature: 'lc',
      manifest: [{ file: 'src/a.ts', action: 'create', purpose: 'x' }],
      decisions: [],
    });
    // completing design BEFORE G_DEFINE has passed must block (exit 1) — the lifecycle gate
    const blockedComplete = await R('complete', 'design', '--handoff', gh);
    expect(blockedComplete.code).toBe(1);
    expect(blockedComplete.json.unmet).toContain('G_DEFINE');

    // run G_DEFINE green, then design completes
    expect((await R('gate', 'G_DEFINE')).code).toBe(0);
    expect((await R('complete', 'design', '--handoff', gh)).code).toBe(0);
  });

  it('requires a recorded predecessor even if its gate passes from files on disk', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'dependency');
    write(
      root,
      '.spindle/features/dependency/DEFINE.md',
      '## Why\nPrevent duplicate payments.\n## What\nDeduplicate by import ID.\n' +
        '## Acceptance Criteria\n- AC-1: Reimporting preserves the balance.\n'
    );
    const define = writeJson(root, '.spindle/features/dependency/.handoffs/define.json', {
      feature: 'dependency', clarity: 0.9, criteria: ['AC-1'],
    });
    const design = writeJson(root, 'work/design.json', {
      feature: 'dependency', manifest: [{ file: 'src/import.ts', action: 'create', purpose: 'Deduplicate imports' }], decisions: [],
    });

    expect((await R('gate', 'G_DEFINE')).code).toBe(0);
    const blocked = await R('complete', 'design', '--handoff', design);
    expect(blocked.code).toBe(1);
    expect(blocked.json.unmet).toEqual(['define']);
    expect((await R('state')).json.completed).toEqual([]);

    expect((await R('complete', 'define', '--handoff', define)).code).toBe(0);
    expect((await R('complete', 'design', '--handoff', design)).code).toBe(0);
  });

  it('keeps design blocked until the spec and handoff list the same acceptance criteria', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'criteria');
    write(
      root,
      '.spindle/features/criteria/DEFINE.md',
      '## Why\nReplace legacy AC-3.\n## What\nDeduplicate imports.\n## Acceptance Criteria\n' +
        '- AC-1: The first import records the payment.\n- AC-2: Reimporting preserves the balance.\n'
    );
    const handoff = 'work/define.json';
    const completeDefine = (criteria: string[]) =>
      R('complete', 'define', '--handoff', writeJson(root, handoff, {
        feature: 'criteria',
        clarity: 0.9,
        criteria,
      }));

    expect((await completeDefine(['AC-1', 'AC-3'])).code).toBe(0);
    const verdict = await R('gate', 'G_DEFINE');
    expect(verdict.code).toBe(1);
    expect(verdict.json.unmet).toEqual([
      'criteria-missing-from-handoff:AC-2',
      'criteria-missing-from-markdown:AC-3',
    ]);
    expect((await R('next')).json.gate_blocked.design).toEqual(['G_DEFINE']);

    expect((await completeDefine(['AC-2', 'AC-1'])).code).toBe(0);
    expect((await R('gate', 'G_DEFINE')).code).toBe(0);
    expect((await R('next')).json.ready).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'design' }),
    ]));
  });

  it('blocks completing a handoff-less artifact until its output exists on disk', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'bs');
    // brainstorm has no handoff schema — completing it with no BRAINSTORM.md would hand the
    // operator a "done" the spine never earned. It must block until the output exists.
    const missing = await R('complete', 'brainstorm');
    expect(missing.code).toBe(1);
    expect(missing.json.unmet).toContain('BRAINSTORM.md');

    write(root, '.spindle/features/bs/BRAINSTORM.md', '# ideas\n');
    expect((await R('complete', 'brainstorm')).code).toBe(0);
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
