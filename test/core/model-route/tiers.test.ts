import { describe, it, expect } from 'vitest';
import { classifyTier } from '../../../src/core/model-route/tiers.js';

describe('classifyTier (orchestration tier T0/T1/T2)', () => {
  it('T0 for mechanical work', () => {
    expect(classifyTier({ mechanical: true }).tier).toBe('T0');
    // even high-risk-looking flags do not matter once it is mechanical
    expect(classifyTier({ mechanical: true, risk: 'high' }).tier).toBe('T0');
  });

  it('T0 for a trivial held-context lookup', () => {
    expect(
      classifyTier({ haveContext: true, breadth: 'single', risk: 'low', reversible: true }).tier
    ).toBe('T0');
  });

  it('T2 for high-risk work, regardless of context', () => {
    expect(classifyTier({ risk: 'high' }).tier).toBe('T2');
    expect(classifyTier({ risk: 'high', haveContext: true, breadth: 'single' }).tier).toBe('T2');
  });

  it('T2 for irreversible actions', () => {
    expect(classifyTier({ reversible: false, risk: 'low' }).tier).toBe('T2');
  });

  it('T1 (not T2) for planning/audit of a project whose context is already held — the re-derivation lesson', () => {
    const d = classifyTier({ haveContext: true, breadth: 'many', risk: 'medium' });
    expect(d.tier).toBe('T1');
    expect(d.reason).toMatch(/re-derivation/);
    expect(d.adversary).toBe('optional-single');
  });

  it('T2 for broad discovery across material NOT held', () => {
    expect(classifyTier({ breadth: 'many', haveContext: false, risk: 'medium' }).tier).toBe('T2');
  });

  it('T1 for a bounded single substantive task without held context', () => {
    expect(classifyTier({ breadth: 'single', risk: 'medium', haveContext: false }).tier).toBe('T1');
  });

  it('defaults (no signals) land at T1, not T2', () => {
    expect(classifyTier().tier).toBe('T1');
    expect(classifyTier({}).tier).toBe('T1');
  });

  it('every decision carries an adversary mode + budget cap', () => {
    expect(classifyTier({ mechanical: true }).adversary).toBe('none');
    expect(classifyTier({ mechanical: true }).budgetCap).toBe('n/a');
    expect(classifyTier({ risk: 'high' }).adversary).toBe('selective');
    expect(classifyTier({ risk: 'high' }).budgetCap).toBe('required');
  });
});
