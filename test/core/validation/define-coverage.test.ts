import { describe, it, expect } from 'vitest';
import {
  computeDefineCoverage,
  normalizeText,
  DISCOVERY_BLOCKS,
  DISCOVERY_BLOCK_IDS,
} from '../../../src/core/validation/define-coverage.js';

// A DEFINE that genuinely touches all nine discovery blocks.
const FULL_DEFINE = `
# DEFINE — supplier-portal

## Why
The current onboarding problem causes real pain: suppliers abandon the flow.

## What
Scope: a portal feature covering the submission workflow.
Users: suppliers and internal operators are the stakeholders.
Architecture: a REST API backed by a Postgres schema.
Non-functional: p99 latency under 300ms with predictable cost at scale.
Security: authentication, authorization and encryption of PII per LGPD.
Delivery: deploy behind CI with a rollback path and monitoring.
Goals: the objective is a 40% drop in abandonment — the success metric.
Constraints: assumes the legacy ERP stays; the risk is its rate limit.

## Acceptance Criteria
- AC-1: a supplier completes onboarding in one session.
- AC-2: every submitted document is retained with an audit trail.
- AC-3: the portal rejects an unauthenticated submission.
- AC-4: onboarding p99 latency stays under 300ms.
- AC-5: a failed deploy rolls back without data loss.
`;

const STUB_DEFINE = `
# DEFINE — thing

## Why
We want it.

## What
Build the thing.

## Acceptance Criteria
- AC-1: it works.
`;

describe('normalizeText', () => {
  it('strips diacritics and lowercases so pt-BR and English score alike', () => {
    expect(normalizeText('Segurança')).toBe('seguranca');
    expect(normalizeText('ARQUITETURA')).toBe('arquitetura');
  });
});

describe('DISCOVERY_BLOCKS', () => {
  it('exposes nine blocks with unique ids', () => {
    expect(DISCOVERY_BLOCKS).toHaveLength(9);
    expect(new Set(DISCOVERY_BLOCK_IDS).size).toBe(9);
  });
});

describe('computeDefineCoverage', () => {
  it('scores a complete DEFINE at full coverage', () => {
    const r = computeDefineCoverage({
      markdown: FULL_DEFINE,
      criteria: ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5'],
      openQuestions: [],
    });
    expect(r.uncovered).toEqual([]);
    expect(r.coverage).toBe(100);
    expect(r.decision_clarity).toBe(100);
    expect(r.readiness).toBe(100);
  });

  it('scores a stub DEFINE far below a complete one and names the gaps', () => {
    const r = computeDefineCoverage({
      markdown: STUB_DEFINE,
      criteria: ['AC-1'],
      openQuestions: [],
    });
    expect(r.readiness).toBeLessThan(50);
    expect(r.uncovered).toContain('security');
    expect(r.uncovered).toContain('nfr');
    expect(r.covered.length + r.uncovered.length).toBe(9);
  });

  it('is pure — identical inputs give identical output', () => {
    const input = { markdown: FULL_DEFINE, criteria: ['AC-1'], openQuestions: ['q'] };
    expect(computeDefineCoverage(input)).toEqual(computeDefineCoverage(input));
  });

  it('discounts clarity as declared open questions accumulate', () => {
    const base = { markdown: FULL_DEFINE, criteria: ['AC-1', 'AC-2'] };
    const none = computeDefineCoverage({ ...base, openQuestions: [] });
    const some = computeDefineCoverage({ ...base, openQuestions: ['a', 'b'] });
    const many = computeDefineCoverage({ ...base, openQuestions: ['a', 'b', 'c', 'd', 'e'] });
    expect(some.decision_clarity).toBeLessThan(none.decision_clarity);
    expect(many.decision_clarity).toBeLessThan(some.decision_clarity);
    // Coverage is a property of the prose — open questions must not move it.
    expect(some.coverage).toBe(none.coverage);
  });

  it('cannot be gamed by the handoff alone: criteria without prose stay low', () => {
    const r = computeDefineCoverage({
      markdown: '## Why\nx\n## What\ny\n## Acceptance Criteria\n- AC-1: x\n',
      criteria: Array.from({ length: 40 }, (_, i) => `AC-${i + 1}`),
      openQuestions: [],
    });
    // Evidence saturates, so a criteria dump can never reach the top band alone.
    expect(r.coverage).toBeLessThan(60);
    expect(r.readiness).toBeLessThan(80);
  });

  it('handles an empty artifact without throwing', () => {
    const r = computeDefineCoverage({ markdown: '', criteria: [], openQuestions: [] });
    expect(r).toMatchObject({ coverage: 0, decision_clarity: 0, readiness: 0 });
    expect(r.uncovered).toHaveLength(9);
  });

  it('scores pt-BR prose the same as its English equivalent', () => {
    const pt = computeDefineCoverage({
      markdown: '## Por que\nO problema é real.\n## O que\nSegurança, arquitetura e testes de entrega.\n',
      criteria: ['AC-1'],
      openQuestions: [],
    });
    expect(pt.covered).toContain('security');
    expect(pt.covered).toContain('architecture');
    expect(pt.covered).toContain('problem');
  });
});
