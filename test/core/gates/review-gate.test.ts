import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gReviewBlock } from '../../../src/core/gates/review-gate.js';
import type { GateContext } from '../../../src/core/gates/types.js';

let root: string;
function ctxFor(findings: unknown): GateContext {
  const p = path.join(root, 'findings.json');
  fs.writeFileSync(p, typeof findings === 'string' ? findings : JSON.stringify(findings));
  return { root, args: { findings: p }, runState: null, graph: null, featureDir: null, handoffDir: null };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-review-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('G_REVIEW_BLOCK', () => {
  const finding = (severity: string) => ({
    file: 'a.ts',
    severity,
    rule: 'r',
    message: 'm',
    source: 'security-worker',
  });

  it('passes when there are zero findings (explicit empty array)', () => {
    expect(gReviewBlock(ctxFor({ findings: [] })).passed).toBe(true);
  });

  it('passes when no finding is critical', () => {
    expect(gReviewBlock(ctxFor({ findings: [finding('high'), finding('low')] })).passed).toBe(true);
  });

  it('BLOCKS when a CRITICAL finding survives', () => {
    const r = gReviewBlock(ctxFor({ findings: [finding('critical')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet[0]).toContain('a.ts');
  });

  // Native cross-vendor review: a finding sourced from codex (OpenAI) is a first-class
  // critic — G_REVIEW_BLOCK is source-agnostic, so a codex CRITICAL blocks like any other.
  it('treats a cross-vendor (source: codex) critical finding as first-class', () => {
    const r = gReviewBlock(
      ctxFor({
        findings: [
          { file: 'a.ts', line: 3, severity: 'critical', rule: 'sql-injection', message: 'unparameterized query', source: 'codex' },
        ],
      })
    );
    expect(r.passed).toBe(false);
    expect(r.unmet[0]).toContain('a.ts');
  });

  it('passes a codex finding set with no critical', () => {
    const r = gReviewBlock(
      ctxFor({ findings: [{ file: 'a.ts', line: null, severity: 'high', rule: 'style', message: 'x', source: 'codex' }] })
    );
    expect(r.passed).toBe(true);
  });

  // The hole the final adversary found: a malformed shape must NOT silently pass.
  it('BLOCKS on a flat finding object (missing the findings array)', () => {
    const r = gReviewBlock(ctxFor({ severity: 'CRITICAL', file: 'a.ts', detail: 'oops' }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('findings-shape');
  });

  it('BLOCKS on an object that omits the findings key entirely', () => {
    expect(gReviewBlock(ctxFor({})).passed).toBe(false);
  });

  it('BLOCKS on a finding that violates the schema (wrong field names)', () => {
    const r = gReviewBlock(ctxFor({ findings: [{ severity: 'critical', title: 'x', detail: 'y' }] }));
    expect(r.passed).toBe(false);
  });
});
