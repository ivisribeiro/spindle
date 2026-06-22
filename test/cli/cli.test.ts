import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject } from '../helpers.js';

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('spin CLI exit-code ABI', () => {
  it('init returns 0 and writes run-state', async () => {
    const r = await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    expect(r.code).toBe(0);
    expect(r.json.schema).toBe('sdd');
  });

  it('next on a fresh run lists the root artifacts', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'next']);
    expect(r.code).toBe(0);
    expect(r.json.ready.map((x: any) => x.id).sort()).toEqual(['brainstorm', 'define']);
  });

  it('a blocked gate exits 1', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'gate', 'G_DEFINE']);
    expect(r.code).toBe(1);
    expect(r.json.passed).toBe(false);
  });

  it('an unknown gate exits 1 with guidance', async () => {
    await cli(['--root', root, 'init']);
    const r = await cli(['--root', root, 'gate', 'G_NOPE']);
    expect(r.code).toBe(1);
    expect(r.json.reasons[0]).toContain('unknown gate');
  });

  it('route prints tier+model and is deterministic', async () => {
    const r = await cli(['--root', root, 'route', 'adversary']);
    expect(r.code).toBe(0);
    expect(r.json.tier).toBe('opus');
  });

  it('an unknown route kind exits 2 (usage)', async () => {
    const r = await cli(['--root', root, 'route', 'bogus']);
    expect(r.code).toBe(2);
  });

  it('handoff-check exits 1 on an invalid handoff', async () => {
    const file = `${root}/bad.json`;
    fs.writeFileSync(file, JSON.stringify({ feature: 'x', clarity: 1, criteria: [] }));
    const r = await cli(['--root', root, 'handoff-check', 'define', file]);
    expect(r.code).toBe(1);
  });

  it('complete blocks (exit 1) when the handoff is invalid', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const file = `${root}/define.json`;
    fs.writeFileSync(file, JSON.stringify({ feature: 'x', clarity: 1, criteria: [] }));
    const r = await cli(['--root', root, 'complete', 'define', '--handoff', file]);
    expect(r.code).toBe(1);
    expect(r.json.gate).toBe('G_HANDOFF');
  });

  it('gate G_AUDIT passes (exit 0) over a valid --handoff sidecar', async () => {
    const file = `${root}/audit.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        domain: 'auth',
        built: [
          { item: 'RLS', evidence: { files: ['a.sql'], proof: 'ENABLE RLS' }, status: 'proven' },
        ],
        gaps: [{ capability: 'rate limit', why: 'unbounded', priority: 'blocking' }],
      })
    );
    const r = await cli(['--root', root, 'gate', 'G_AUDIT', '--handoff', file]);
    expect(r.code).toBe(0);
    expect(r.json.passed).toBe(true);
  });

  it('gate G_AUDIT blocks (exit 1) when a built item lacks evidence', async () => {
    const file = `${root}/audit.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        domain: 'auth',
        built: [{ item: 'RLS', evidence: { files: [], proof: '' }, status: 'scaffolded' }],
        gaps: [{ capability: 'rate limit', why: 'unbounded', priority: 'blocking' }],
      })
    );
    const r = await cli(['--root', root, 'gate', 'G_AUDIT', '--handoff', file]);
    expect(r.code).toBe(1);
    expect(r.json.passed).toBe(false);
  });

  it('schema validate passes for the bundled sdd schema', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd']);
    const r = await cli(['--root', root, 'schema', 'validate']);
    expect(r.code).toBe(0);
    expect(r.json.valid).toBe(true);
  });

  // --- dogfood improvements (I-A status alias, I-B explain/schema show, I-C spec-drift) ---

  it('status is an alias of state (I-A / F1)', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const state = await cli(['--root', root, 'state']);
    const status = await cli(['--root', root, 'status']);
    expect(status.code).toBe(0);
    expect(status.json).toEqual(state.json);
  });

  it('explain describes a gate (I-B / F2)', async () => {
    const r = await cli(['--root', root, 'explain', 'G_DEFINE']);
    expect(r.code).toBe(0);
    expect(r.json.gate).toBe('G_DEFINE');
    expect(r.json.handoff).toBe('define');
    expect(Array.isArray(r.json.blocks_when)).toBe(true);
  });

  it('explain on an unknown gate exits 2 with the known list', async () => {
    const r = await cli(['--root', root, 'explain', 'G_NOPE']);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('G_DEFINE');
  });

  it('schema show <handoff-id> describes the JSON shape (I-B / F2)', async () => {
    const r = await cli(['--root', root, 'schema', 'show', 'define']);
    expect(r.code).toBe(0);
    expect(r.json.id).toBe('define');
    const names = r.json.fields.map((f: any) => f.name);
    expect(names).toContain('criteria');
  });

  it('schema show <unknown-id> exits 2', async () => {
    const r = await cli(['--root', root, 'schema', 'show', 'bogus']);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('unknown handoff id');
  });

  it('spec-drift exits 0 when no criterion was corrected (I-C)', async () => {
    const file = `${root}/build.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({ feature: 'f', results: [{ criterion: 'AC-1', status: 'passed' }] })
    );
    const r = await cli(['--root', root, 'spec-drift', '--build', file]);
    expect(r.code).toBe(0);
    expect(r.json.clean).toBe(true);
  });

  it('spec-drift exits 1 and lists the corrected criterion (I-C / F6)', async () => {
    const file = `${root}/build.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        feature: 'f',
        results: [
          { criterion: 'AC-1', status: 'passed', corrected_spec: true, correction: 'CRC 29B1 not 1D3D' },
        ],
      })
    );
    const r = await cli(['--root', root, 'spec-drift', '--build', file]);
    expect(r.code).toBe(1);
    expect(r.json.clean).toBe(false);
    expect(r.json.drifted[0].criterion).toBe('AC-1');
  });

  it('spec-drift converges (exit 0) once the correction is reconciled (I-C / G2)', async () => {
    const file = `${root}/build.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        feature: 'f',
        results: [
          { criterion: 'AC-1', status: 'passed', corrected_spec: true, correction: 'fixed', reconciled: true },
        ],
      })
    );
    const r = await cli(['--root', root, 'spec-drift', '--build', file]);
    expect(r.code).toBe(0);
    expect(r.json.clean).toBe(true);
    expect(r.json.reconciled).toEqual(['AC-1']);
  });

  it('schema show surfaces the array-item regex constraint (I-B / G1)', async () => {
    const r = await cli(['--root', root, 'schema', 'show', 'define']);
    expect(r.code).toBe(0);
    const criteria = r.json.fields.find((f: any) => f.name === 'criteria');
    expect((criteria.constraints ?? []).join(' ')).toContain('AC-');
  });

  // --- the run-ledger: spin trace (Measured Harness, Fase 1) ---

  it('trace on a fresh run is empty and exits 0', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'trace']);
    expect(r.code).toBe(0);
    expect(r.json.events).toEqual([]);
    expect(r.json.summary.completed).toBe(0);
    expect(r.json.summary.reported_tokens).toBe(null);
  });

  it('trace records a complete event with opaque model-reported usage', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const file = `${root}/define.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        feature: 'f',
        clarity: 0.9,
        criteria: ['AC-1'],
        usage: { tier: 'sonnet', tokens_in: 100, tokens_out: 50 },
      })
    );
    const c = await cli(['--root', root, 'complete', 'define', '--handoff', file]);
    expect(c.code).toBe(0);
    const r = await cli(['--root', root, 'trace']);
    expect(r.json.summary.completed).toBe(1);
    expect(r.json.summary.tier_histogram.sonnet).toBe(1);
    expect(r.json.summary.reported_tokens).toEqual({ tokens_in: 100, tokens_out: 50 });
  });

  it('trace counts a completion without usage as unreported, tokens stay null', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const file = `${root}/define.json`;
    fs.writeFileSync(file, JSON.stringify({ feature: 'f', clarity: 0.9, criteria: ['AC-1'] }));
    await cli(['--root', root, 'complete', 'define', '--handoff', file]);
    const r = await cli(['--root', root, 'trace']);
    expect(r.json.summary.reported_tokens).toBe(null);
    expect(r.json.summary.tier_histogram.unreported).toBe(1);
  });

  it('trace records a gate verdict once and de-dupes an identical re-run', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    await cli(['--root', root, 'gate', 'G_DEFINE']); // blocks (exit 1)
    await cli(['--root', root, 'gate', 'G_DEFINE']); // identical re-run → no new event
    const r = await cli(['--root', root, 'trace']);
    const gateEvents = r.json.events.filter((e: any) => e.kind === 'gate' && e.gate === 'G_DEFINE');
    expect(gateEvents.length).toBe(1);
    expect(gateEvents[0].passed).toBe(false);
    expect(r.json.summary.gates.blocked).toBe(1);
  });

  it('trace requires a run (exit 2 before init)', async () => {
    const r = await cli(['--root', root, 'trace']);
    expect(r.code).toBe(2);
  });

  // --- spin budget: token accounting (Measured Harness, Fase 3) ---

  it('budget reports null spend on a fresh run (exit 0)', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'budget']);
    expect(r.code).toBe(0);
    expect(r.json.reported).toBe(null);
    expect(r.json.over_budget).toBe(false);
  });

  it('budget sums reported usage per tier and flags over_budget but stays advisory (exit 0)', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const file = `${root}/define.json`;
    fs.writeFileSync(
      file,
      JSON.stringify({
        feature: 'f',
        clarity: 0.9,
        criteria: ['AC-1'],
        usage: { tier: 'opus', tokens_in: 800, tokens_out: 400 },
      })
    );
    await cli(['--root', root, 'complete', 'define', '--handoff', file]);
    const r = await cli(['--root', root, 'budget', '--max-tokens', '1000']);
    expect(r.code).toBe(0); // advisory — never blocks legitimate spend
    expect(r.json.reported.total).toBe(1200);
    expect(r.json.by_tier.opus.tokens_in).toBe(800);
    expect(r.json.over_budget).toBe(true);
    expect(r.json.warning).toContain('exceeds');
  });

  it('budget rejects a non-numeric --max-tokens (exit 2)', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'budget', '--max-tokens', 'lots']);
    expect(r.code).toBe(2);
  });

  // --- spin approve: inviolable human sign-off (A1) ---

  it('approve refuses without an interactive TTY — an agent cannot approve', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'approve']);
    expect(r.code).toBe(2);
    expect(r.json.error).toContain('interactive');
  });

  it('approve records sign-off when run from a TTY, and spin state shows it', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const orig = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    try {
      const r = await cli(['--root', root, 'approve', '--by', 'ivis']);
      expect(r.code).toBe(0);
      expect(r.json.approved).toBe(true);
      expect(r.json.by).toBe('ivis');
    } finally {
      if (orig) Object.defineProperty(process.stdin, 'isTTY', orig);
    }
    const state = await cli(['--root', root, 'state']);
    expect(state.json.approval.by).toBe('ivis');
  });
});
