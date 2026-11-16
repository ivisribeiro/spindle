import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { approveFixture, cli, tmpProject, write, writeJson } from '../helpers.js';

// Drives the brownfield workflow through the real CLI. Proves two things the old
// audit→define→design dead-end could not: (1) the run now spans the full
// audit→define→design→build→ship cycle, and (2) G_AUDIT is enforced at BOTH anchors —
// `before_define` fail-fasts the run right after the audit phase, and the terminal
// `during` hook means the run can never be reported complete on an un-evidenced audit.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const R = (...args: string[]) => cli(['--root', root, ...args]);

describe('E2E: brownfield cycle through the spin CLI', () => {
  it('runs audit → define → design → build → ship with G_AUDIT fail-fasting before define', async () => {
    expect((await R('init', '--schema', 'brownfield', '--feature', 'auth')).code).toBe(0);

    // the build order now spans the full cycle (no more audit→define→design dead end)
    expect((await R('order')).json.order).toEqual(['audit', 'define', 'design', 'build', 'ship']);

    // --- Phase 0: audit (evidence-backed handoff) ---
    write(root, '.spindle/features/auth/AUDIT.md', '# audit\n');
    const auditHandoff = writeJson(root, 'work/audit.json', {
      domain: 'auth',
      built: [
        {
          item: 'row-level security',
          evidence: { files: ['db/policies.sql'], proof: 'ENABLE ROW LEVEL SECURITY' },
          status: 'proven',
        },
      ],
      gaps: [{ capability: 'rate limiting', why: 'login endpoint is unbounded', priority: 'blocking' }],
    });
    expect((await R('complete', 'audit', '--handoff', auditHandoff)).code).toBe(0);

    // define is engine-blocked until the audit gate runs (before_define: G_AUDIT) —
    // the run fail-fasts at the seam right after the audit phase, not at ship
    const nextAfterAudit = await R('next');
    expect(nextAfterAudit.json.gate_blocked.define).toContain('G_AUDIT');
    expect((await R('gate', 'G_AUDIT')).code).toBe(0);

    // --- Phase 1: define (before_design gate is G_DEFINE) ---
    write(
      root,
      '.spindle/features/auth/DEFINE.md',
      '## Why\nharden auth\n## What\nadd rate limiting\n## Acceptance Criteria\n- AC-1 requests are throttled\n'
    );
    const defineHandoff = writeJson(root, 'work/define.json', {
      feature: 'auth',
      clarity: 0.9,
      criteria: ['AC-1'],
    });
    expect((await R('complete', 'define', '--handoff', defineHandoff)).code).toBe(0);
    expect((await R('gate', 'G_DEFINE')).code).toBe(0);

    // --- Phase 2: design (before_build gate is G_DESIGN) ---
    write(
      root,
      '.spindle/features/auth/DESIGN.md',
      '## Overview\nthrottle mw\n## File Manifest\n\n| File | Action | Purpose |\n| --- | --- | --- |\n| src/throttle.ts | create | limit |\n\n## Decisions\ntoken bucket\n'
    );
    const designHandoff = writeJson(root, 'work/design.json', {
      feature: 'auth',
      manifest: [{ file: 'src/throttle.ts', action: 'create', purpose: 'limit' }],
      decisions: ['token bucket'],
    });
    expect((await R('complete', 'design', '--handoff', designHandoff)).code).toBe(0);
    expect((await R('gate', 'G_DESIGN')).code).toBe(0);

    // --- Phase 3: build (before_ship gates are [G_BUILD, G_SHIP]) ---
    write(root, 'src/throttle.ts', '// throttle\n');
    write(root, '.spindle/features/auth/BUILD_REPORT.md', '# build report\n');
    const buildHandoff = writeJson(root, 'work/build.json', {
      feature: 'auth',
      results: [{ criterion: 'AC-1', status: 'passed' }],
      files_written: ['src/throttle.ts'],
    });
    expect((await R('complete', 'build', '--handoff', buildHandoff)).code).toBe(0);
    expect((await R('gate', 'G_BUILD')).code).toBe(0);

    // --- Phase 4: ship — G_AUDIT already green from the early anchor, so the terminal
    // backstop is satisfied and ship completes on G_BUILD + G_SHIP alone ---
    approveFixture(root);
    expect((await R('gate', 'G_SHIP')).code).toBe(0);

    write(root, '.spindle/features/auth/SHIPPED.md', '# shipped\n');
    expect((await R('complete', 'ship')).code).toBe(0);

    const finalNext = await R('next');
    expect(finalNext.json.complete).toBe(true);
    const state = await R('state');
    expect(state.json.completed.sort()).toEqual(['audit', 'build', 'define', 'design', 'ship']);
  });

  it('a structurally-valid but empty audit still fails the terminal G_AUDIT gate', async () => {
    await R('init', '--schema', 'brownfield', '--feature', 'auth');
    write(root, '.spindle/features/auth/AUDIT.md', '# audit\n');
    // empty audit: the handoff SCHEMA accepts it (built/gaps default to []) …
    const emptyAudit = writeJson(root, 'work/audit.json', { domain: 'auth' });
    expect((await R('complete', 'audit', '--handoff', emptyAudit)).code).toBe(0);
    // … but the terminal G_AUDIT gate blocks it — an empty audit is not an audit
    expect((await R('gate', 'G_AUDIT')).code).toBe(1);
    // so the run can never be reported complete (the probe the P0 review flagged is now closed)
    expect((await R('next')).json.complete).toBe(false);
  });
});
