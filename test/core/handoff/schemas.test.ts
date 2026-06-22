import { describe, it, expect } from 'vitest';
import { checkHandoffObject } from '../../../src/core/handoff/handoff-check.js';

describe('handoff contracts', () => {
  it('accepts a valid define handoff', () => {
    const r = checkHandoffObject('define', {
      feature: 'auth',
      clarity: 0.9,
      criteria: ['AC-1', 'AC-2'],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a define handoff with zero criteria', () => {
    const r = checkHandoffObject('define', { feature: 'auth', clarity: 0.9, criteria: [] });
    expect(r.ok).toBe(false);
  });

  it('rejects malformed criteria ids', () => {
    const r = checkHandoffObject('define', { feature: 'a', clarity: 1, criteria: ['crit-1'] });
    expect(r.ok).toBe(false);
  });

  it('build-report accepts the corrected_spec drift fields, and stays backward-compatible without them (I-C)', () => {
    const withDrift = checkHandoffObject('build-report', {
      feature: 'auth',
      results: [{ criterion: 'AC-1', status: 'passed', corrected_spec: true, correction: '29B1 not 1D3D' }],
    });
    expect(withDrift.ok).toBe(true);

    const legacy = checkHandoffObject('build-report', {
      feature: 'auth',
      results: [{ criterion: 'AC-1', status: 'passed' }],
    });
    expect(legacy.ok).toBe(true);
    // corrected_spec and reconciled default to false when omitted
    expect((legacy.data as any).results[0].corrected_spec).toBe(false);
    expect((legacy.data as any).results[0].reconciled).toBe(false);

    // reconciled acknowledgment is accepted (G2)
    const reconciled = checkHandoffObject('build-report', {
      feature: 'auth',
      results: [{ criterion: 'AC-1', status: 'passed', corrected_spec: true, reconciled: true }],
    });
    expect(reconciled.ok).toBe(true);

    // verified_by evidence is accepted
    const evidence = checkHandoffObject('build-report', {
      feature: 'auth',
      results: [{ criterion: 'AC-1', status: 'passed', verified_by: 'test/a.test.ts' }],
    });
    expect(evidence.ok).toBe(true);
  });

  it('accepts a valid design handoff with a manifest', () => {
    const r = checkHandoffObject('design', {
      feature: 'auth',
      manifest: [{ file: 'src/a.ts', action: 'create', purpose: 'x' }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a design handoff with an empty manifest', () => {
    const r = checkHandoffObject('design', { feature: 'auth', manifest: [] });
    expect(r.ok).toBe(false);
  });

  it('validates finding severity enum', () => {
    const good = checkHandoffObject('finding', {
      findings: [{ file: 'a.ts', severity: 'critical', rule: 'X', message: 'm', source: 'sec' }],
    });
    expect(good.ok).toBe(true);
    const bad = checkHandoffObject('finding', {
      findings: [{ file: 'a.ts', severity: 'apocalyptic', rule: 'X', message: 'm', source: 'sec' }],
    });
    expect(bad.ok).toBe(false);
  });

  it('rejects an unknown handoff schema id', () => {
    const r = checkHandoffObject('does-not-exist', {});
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toContain('unknown handoff schema');
  });

  it('accepts a minimal audit handoff and fills array defaults', () => {
    const r = checkHandoffObject('audit', { domain: 'auth' });
    expect(r.ok).toBe(true);
    const data = r.data as {
      built: unknown[];
      gaps: unknown[];
      opsReadiness: unknown[];
      proposedTasks: unknown[];
      invariants_at_risk: unknown[];
    };
    expect(data.built).toEqual([]);
    expect(data.gaps).toEqual([]);
    expect(data.opsReadiness).toEqual([]);
    expect(data.proposedTasks).toEqual([]);
    expect(data.invariants_at_risk).toEqual([]);
  });

  it('accepts a rich audit handoff with evidence, ops-readiness and tasks', () => {
    const r = checkHandoffObject('audit', {
      domain: 'auth',
      built: [
        {
          item: 'RLS',
          evidence: { files: ['src/db/rls.sql'], lines: '12-48', proof: 'ENABLE RLS present' },
          status: 'proven',
          resolved_at_commit: '8cc15c8',
          verified_in_code: true,
        },
      ],
      gaps: [{ capability: 'rate limit', why: 'brute force', priority: 'blocking' }],
      weakPoints: [{ item: 'GUC bypass', severity: 'high', evidence: 'superuser ignores GUC' }],
      opsReadiness: [
        {
          control: 'ERIN_RUNNER_USE_BUNDLES',
          code_default: 'false',
          prod_value_required: 'true',
          enforced: false,
        },
      ],
      proposedTasks: [{ title: 'wire limiter', detail: 'add bucket', effort: 'M' }],
      invariants_at_risk: ['tenant-isolation'],
      test_tiers: { unit: 'vitest', infra_bound: 'pg' },
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an audit gap with an invalid priority', () => {
    const r = checkHandoffObject('audit', {
      domain: 'auth',
      gaps: [{ capability: 'x', why: 'y', priority: 'someday' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an audit built item with an invalid status', () => {
    const r = checkHandoffObject('audit', {
      domain: 'auth',
      built: [{ item: 'x', evidence: { files: ['a.ts'], proof: 'p' }, status: 'maybe' }],
    });
    expect(r.ok).toBe(false);
  });

  it('rejects an audit handoff missing the required domain', () => {
    const r = checkHandoffObject('audit', { built: [], gaps: [] });
    expect(r.ok).toBe(false);
  });

  it('kb-concept accepts decoding_note (E-1) and stays valid without it', () => {
    expect(checkHandoffObject('kb-concept', { concept: 'c', summary: 's' }).ok).toBe(true);
    expect(
      checkHandoffObject('kb-concept', { concept: 'c', summary: 's', decoding_note: 'opaque code 7' }).ok
    ).toBe(true);
    expect(
      checkHandoffObject('kb-concept', { concept: 'c', summary: 's', decoding_note: 123 }).ok
    ).toBe(false);
  });
});
