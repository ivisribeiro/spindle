import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject, write, writeJson } from '../helpers.js';

// Regression protection for the thin command handlers the v1 audit flagged as having
// no direct test of their exit-code ABI (the contract slash commands branch on):
// order, kinds, tier, retry, invalidate, validate, reconcile.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const R = (...args: string[]) => cli(['--root', root, ...args]);

describe('CLI handler exit-code ABI', () => {
  it('spin order returns the Kahn order (exit 0)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'o');
    const r = await R('order');
    expect(r.code).toBe(0);
    const s = JSON.stringify(r.json);
    expect(s).toContain('define');
    expect(s).toContain('ship');
  });

  it('spin kinds lists routing task-kinds (exit 0)', async () => {
    const r = await R('kinds');
    expect(r.code).toBe(0);
    expect(JSON.stringify(r.json).length).toBeGreaterThan(2);
  });

  it('spin tier classifies from signals (exit 0) and rejects a bad enum (exit 2)', async () => {
    const ok = await R('tier', '--risk', 'high', '--breadth', 'many', '--irreversible');
    expect(ok.code).toBe(0);
    expect(ok.json.decision).toBeTruthy();
    // the audit feared a silent fallthrough on an unknown --risk; it is validated → exit 2
    expect((await R('tier', '--risk', 'bogus')).code).toBe(2);
  });

  it('spin retry is bounded by build_retry_cap=3 (boundary is exact, not off-by-one)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'r');
    expect((await R('retry', 'build', '--ok')).code).toBe(0); // count 0 < cap
    expect((await R('retry', 'build', '--inc')).code).toBe(0); // 1
    expect((await R('retry', 'build', '--inc')).code).toBe(0); // 2
    expect((await R('retry', 'build', '--inc')).code).toBe(0); // 3 == cap, inc still ok
    expect((await R('retry', 'build', '--ok')).code).toBe(1); // ceiling hit (count >= cap)
    expect((await R('retry', 'build', '--inc')).code).toBe(1); // 4 > cap, inc blocks
  });

  it('spin invalidate drops the downstream closure (exit 0) and rejects an unknown id (exit 2)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'i');
    expect((await R('invalidate', 'nope')).code).toBe(2);
    const r = await R('invalidate', 'define');
    expect(r.code).toBe(0);
    expect(r.json.invalidated).toEqual(expect.arrayContaining(['design', 'build', 'ship']));
  });

  it('spin validate passes a well-formed DEFINE and blocks a malformed one', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'v');
    write(root, '.spindle/features/v/DEFINE.md', '## Why\nx\n## What\ny\n## Acceptance Criteria\n- AC-1 a\n');
    expect((await R('validate', 'define')).code).toBe(0);
    write(root, '.spindle/features/v/DEFINE.md', '## Why\nx\n'); // missing required sections
    expect((await R('validate', 'define')).code).toBe(1);
  });

  it('spin reconcile blocks a proven-but-unverified audit (drift) and passes a clean one', async () => {
    const drift = writeJson(root, 'audit-drift.json', {
      domain: 'd',
      built: [{ item: 'rls', status: 'proven', evidence: {} }],
    });
    expect((await R('reconcile', '--audit', drift)).code).toBe(1); // proven + verified_in_code=false → drift_open
    const clean = writeJson(root, 'audit-clean.json', {
      domain: 'd',
      built: [{ item: 'rls', status: 'proven', verified_in_code: true, resolved_at_commit: 'abc123', evidence: {} }],
    });
    expect((await R('reconcile', '--audit', clean)).code).toBe(0); // silently_fixed → clean
  });
});
