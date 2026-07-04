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

  it('spin reconcile resolves a relative --audit against --root (not cwd)', async () => {
    write(
      root,
      'audit-rel.json',
      JSON.stringify({ domain: 'd', built: [{ item: 'x', status: 'proven', verified_in_code: true, resolved_at_commit: 'a', evidence: {} }] })
    );
    // a relative path must resolve under --root; before the fix it resolved under cwd → not found → exit 2
    expect((await R('reconcile', '--audit', 'audit-rel.json')).code).toBe(0);
  });

  it('spin next is ledger-authoritative + gate-aware (a stray .md does not unlock downstream)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'n');
    // write DEFINE.md WITHOUT spin complete — file existence alone must not unlock design
    write(root, '.spindle/features/n/DEFINE.md', '## Why\nx\n## What\ny\n## Acceptance Criteria\n- AC-1 a\n');
    let r = await R('next');
    expect(r.json.ready.map((x: any) => x.id)).not.toContain('design');
    expect(r.json.detected_on_disk).toContain('define'); // surfaced separately, not as readiness

    // complete define in the ledger, but do NOT run G_DEFINE → design is gate_blocked, not ready
    const dh = writeJson(root, 'work/define.json', { feature: 'n', clarity: 0.9, criteria: ['AC-1'] });
    await R('complete', 'define', '--handoff', dh);
    r = await R('next');
    expect(r.json.gate_blocked.design).toEqual(['G_DEFINE']);
    expect(r.json.ready.map((x: any) => x.id)).not.toContain('design');

    // run G_DEFINE green → design becomes ready
    await R('gate', 'G_DEFINE');
    r = await R('next');
    expect(r.json.ready.map((x: any) => x.id)).toContain('design');
  });

  it('a corrupt run.json is an internal error (exit 3), not a usage error', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'c');
    write(root, '.spindle/run.json', '{ broken json');
    expect((await R('state')).code).toBe(3);
  });

  it('spin schema validate rejects unknown handoff/gate references', async () => {
    await R('init', '--schema', 'sdd', '--feature', 's');
    write(
      root,
      '.spindle/schema.yaml',
      'name: t\nversion: 1\nartifacts:\n  - id: a\n    generates: A.md\n    handoff: bogus-handoff\n    requires: []\ngates:\n  before_a: G_NOPE\n'
    );
    const r = await R('schema', 'validate');
    expect(r.code).toBe(1);
    const s = JSON.stringify(r.json);
    expect(s).toContain('bogus-handoff');
    expect(s).toContain('G_NOPE');
  });

  it('spin schema validate rejects an unenforceable gate hook key (would be inert)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'hk');
    // `after_a` is not an enforceable hook form and `before_ghost` names no artifact;
    // both would silently never fire. The gate VALUES are real, so only the KEY check trips.
    write(
      root,
      '.spindle/schema.yaml',
      'name: t\nversion: 1\nartifacts:\n  - id: a\n    generates: A.md\n    requires: []\ngates:\n  after_a: G_DEFINE\n  before_ghost: G_SHIP\n'
    );
    const r = await R('schema', 'validate');
    expect(r.code).toBe(1);
    const s = JSON.stringify(r.json);
    expect(s).toContain('after_a');
    expect(s).toContain('before_ghost');
    expect(s).toContain('enforceable');
  });

  it('spin complete rejects a stray --handoff on a handoff-less artifact (exit 2)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'sh');
    const h = writeJson(root, 'work/x.json', { anything: true });
    // brainstorm declares no handoff schema — a --handoff would never be validated, so
    // passing one is a usage error (a bug in the invocation), not a silently-ignored flag.
    const r = await R('complete', 'brainstorm', '--handoff', h);
    expect(r.code).toBe(2);
    expect(JSON.stringify(r.json)).toContain('no handoff schema');
  });

  it('spin init rejects an unsafe feature slug (exit 2)', async () => {
    expect((await R('init', '--schema', 'sdd', '--feature', '../../escape')).code).toBe(2);
  });

  it('spin merge-findings fails closed on an invalid finding before merging', async () => {
    const badSev = writeJson(root, 'bad.json', { findings: [{ file: 'x.ts', line: 1, severity: 'apocalyptic', rule: 'r', message: 'm', source: 's' }] });
    expect((await R('merge-findings', badSev)).code).toBe(2); // unknown severity
    const noSrc = writeJson(root, 'nosrc.json', { findings: [{ file: 'x.ts', line: 1, severity: 'high', rule: 'r', message: 'm' }] });
    expect((await R('merge-findings', noSrc)).code).toBe(2); // missing source
    const good = writeJson(root, 'good.json', { findings: [{ file: 'x.ts', line: 1, severity: 'high', rule: 'r', message: 'm', source: 'claude' }] });
    expect((await R('merge-findings', good)).code).toBe(0);
  });
});
