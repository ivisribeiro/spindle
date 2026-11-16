import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { tmpProject } from '../helpers.js';

const runner = fileURLToPath(new URL('../../scripts/prompt-eval.mjs', import.meta.url));
const workflow = fileURLToPath(new URL('../../plugin/adapters/workflow.md', import.meta.url));

it('grades the injected resume failure and validates an isolated candidate without changing the baseline', () => {
  const root = tmpProject();
  const output = join(root, 'comparison');
  const original = readFileSync(workflow, 'utf8');
  try {
    const run = spawnSync(process.execPath, [runner, '--mode', 'fixture', '--out', output], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    expect(report).toMatchObject({
      synthetic: true,
      comparison: 'simulated-repair-verified',
      promoted: false,
      proposal: { remediation: 'designRecorded', file: 'candidate-workflow.md' },
      baseline: [{ checks: { designRecorded: false, designValid: false, designGate: false, definePreserved: true } }],
      candidate: [{ checks: { designRecorded: true, designValid: true, designGate: true, definePreserved: true } }],
    });
    expect(Object.values(report.candidate[0].checks).every(Boolean)).toBe(true);
    const candidate = readFileSync(join(output, report.proposal.file), 'utf8');
    expect(candidate.replace(/### Resume checkpoint\n\n[^\n]+\n\n/, '')).toBe(original);
    expect(readFileSync(workflow, 'utf8')).toBe(original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15_000);
