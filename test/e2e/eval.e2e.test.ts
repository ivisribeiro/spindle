import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { cli } from '../helpers.js';

// `spin eval` replays the bundled corpus through the REAL gate functions. This test
// proves the eval mechanism itself: the corpus is clean, --strict is honestly
// fail-closed on incomplete coverage, and a verdict regression is caught.

describe('spin eval — the harness evaluating itself (Fase 2)', () => {
  it('replays the bundled corpus with no regressions (exit 0)', async () => {
    const r = await cli(['eval']);
    expect(r.code).toBe(0);
    expect(r.json.failed).toBe(0);
    expect(r.json.total).toBeGreaterThanOrEqual(10);
    for (const g of ['G_AUDIT', 'G_OPS_CONFIG', 'G_PLAN', 'G_REVIEW_BLOCK', 'G_ROUTER_COVERAGE']) {
      expect(r.json.coverage.covered).toContain(g);
    }
  });

  it('--strict passes: every registry gate has a pass AND a block fixture (C3)', async () => {
    const r = await cli(['eval', '--strict']);
    expect(r.code).toBe(0);
    expect(r.json.failed).toBe(0);
    expect(r.json.coverage.complete).toBe(true);
    expect(r.json.coverage.uncovered).toEqual([]);
    expect(r.json.coverage.missing_pass).toEqual([]);
    expect(r.json.coverage.missing_block).toEqual([]);
    // the 6 state-coupled gates are now in the corpus alongside the 5 arg-file gates
    for (const g of ['G_DEFINE', 'G_DESIGN', 'G_BUILD', 'G_SHIP', 'G_KB_STRUCTURE', 'G_KB_COVERAGE']) {
      expect(r.json.coverage.covered).toContain(g);
    }
  });

  it('catches a verdict regression (a recorded pass that the real gate blocks)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-eval-'));
    const caseDir = path.join(dir, 'broken');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(
      path.join(caseDir, 'findings.json'),
      JSON.stringify({
        findings: [{ file: 'x.ts', line: 1, severity: 'critical', rule: 'r', message: 'm', source: 's' }],
      })
    );
    fs.writeFileSync(
      path.join(caseDir, 'case.json'),
      JSON.stringify({ id: 'wrong', gate: 'G_REVIEW_BLOCK', expect: 'pass', args: { findings: 'findings.json' } })
    );
    const r = await cli(['eval', '--corpus', dir]);
    expect(r.code).toBe(1);
    expect(r.json.regressions.map((x: any) => x.id)).toContain('wrong');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('errors as a usage failure when the corpus dir does not exist (exit 2)', async () => {
    const r = await cli(['eval', '--corpus', '/no/such/corpus/here']);
    expect(r.code).toBe(2);
  });

  it('handles a corrupt case.json gracefully — an error result, exit 1, never a crash (exit 3)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-eval-'));
    const caseDir = path.join(dir, 'broken');
    fs.mkdirSync(caseDir, { recursive: true });
    fs.writeFileSync(path.join(caseDir, 'case.json'), '{ not valid json');
    const r = await cli(['eval', '--corpus', dir]);
    expect(r.code).toBe(1); // a bad fixture is a caught regression, not an internal crash
    expect(r.json.results.some((x: any) => x.actual === 'error')).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
