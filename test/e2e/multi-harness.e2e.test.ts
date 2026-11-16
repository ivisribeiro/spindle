import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpProject } from '../helpers.js';

const installer = fileURLToPath(new URL('../../bin/spindle-install.js', import.meta.url));
const runtime = '.spindle/harness/bin/spin.js';
const adapters = {
  codex: '.agents/skills/spindle-workflow/SKILL.md',
  claude: '.claude/skills/spindle-claude-workflow/SKILL.md',
  gemini: '.gemini/commands/spindle.toml',
  cursor: '.agents/skills/spindle-workflow/SKILL.md',
};

let root: string;
beforeEach(() => { root = tmpProject(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

const run = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });

describe('project-local multi-harness installation', () => {
  it('installs native entry points and runs the common CLI in a clean project', () => {
    const instructions = join(root, 'AGENTS.md');
    writeFileSync(instructions, '# Project instructions\n');
    const install = run(installer, '--target', 'all');
    expect(install.status, install.stderr).toBe(0);
    for (const adapter of Object.values(adapters)) {
      expect(readFileSync(join(root, adapter), 'utf8')).toContain('.spindle/harness-workflow.md');
    }
    expect(readFileSync(instructions, 'utf8')).toBe('# Project instructions\n');
    expect(existsSync(join(root, 'node_modules'))).toBe(false);

    const init = run(runtime, 'init', '--schema', 'sdd', '--feature', 'portable');
    expect(init.status, init.stderr).toBe(0);
    const ledger = join(root, '.spindle/run.json');
    const before = readFileSync(ledger, 'utf8');
    const reinstall = run(installer, '--target', 'all');
    expect(reinstall.status, reinstall.stderr).toBe(0);
    expect(readFileSync(ledger, 'utf8')).toBe(before);

    const next = run(runtime, 'next');
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout).ready.length).toBeGreaterThan(0);
    expect(run(runtime, 'gate', 'G_DEFINE').status).toBe(1);
    const approval = run(runtime, 'approve', '--by', 'agent');
    expect(approval.status).toBe(2);
    expect(approval.stdout + approval.stderr).toContain('interactive');
  });

  it('installs the workspace skill and runtime for Antigravity on its own', () => {
    const install = run(installer, '--target', 'antigravity');
    expect(install.status, install.stderr).toBe(0);
    const skill = readFileSync(join(root, adapters.codex), 'utf8');
    expect(skill).toContain('name: spindle-workflow');
    expect(skill).toContain('.spindle/harness-workflow.md');
    expect(existsSync(join(root, adapters.gemini))).toBe(false);
    expect(run(runtime, 'doctor').status).toBe(0);
  });

  it('stops before installing other adapters if an existing skill conflicts', () => {
    expect(run(installer, '--target', 'codex').status).toBe(0);
    const codexSkill = join(root, adapters.codex);
    writeFileSync(codexSkill, '# Locally edited skill\n');

    const install = run(installer, '--target', 'all');
    expect(install.status).toBe(1);
    expect(install.stderr).toContain(adapters.codex);
    expect(readFileSync(codexSkill, 'utf8')).toBe('# Locally edited skill\n');
    expect(existsSync(join(root, adapters.gemini))).toBe(false);
  });

  it('can add a second harness without replacing the first adapter or run', () => {
    expect(run(installer, '--target', 'codex').status).toBe(0);
    expect(existsSync(join(root, adapters.gemini))).toBe(false);
    expect(run(runtime, 'init', '--schema', 'sdd', '--feature', 'handover').status).toBe(0);
    const feature = '.spindle/features/handover';
    writeFileSync(join(root, feature, 'DEFINE.md'),
      '## Why\nRetrying an import can duplicate payments.\n\n' +
      '## What\nIgnore a previously imported payment ID.\n\n' +
      '## Acceptance Criteria\n- AC-1: Reimporting a payment leaves the balance unchanged.\n');
    const handoff = join(feature, '.handoffs', 'define.json');
    writeFileSync(join(root, handoff), JSON.stringify({
      feature: 'handover', clarity: 0.9, criteria: ['AC-1'],
    }));
    expect(run(runtime, 'complete', 'define', '--handoff', handoff).status).toBe(0);
    expect(run(runtime, 'gate', 'G_DEFINE').status).toBe(0);

    const ledger = join(root, '.spindle/run.json');
    const before = readFileSync(ledger, 'utf8');
    expect(run(installer, '--target', 'gemini').status).toBe(0);
    expect(existsSync(join(root, adapters.codex))).toBe(true);
    expect(existsSync(join(root, adapters.gemini))).toBe(true);
    const next = run(runtime, 'next');
    expect(next.status, next.stderr).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      ready: expect.arrayContaining([
        expect.objectContaining({ id: 'brainstorm' }),
        expect.objectContaining({ id: 'design' }),
      ]),
      resume: {
        phase: 'design',
        status: 'ready',
        required_gates: ['G_DEFINE'],
        blocked_by: [],
        artifact_path: `${feature}/DESIGN.md`,
        handoff_path: `${feature}/.handoffs/design.json`,
      },
    });
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });

  it('keeps Design selected but blocked when the Define handoff omits a criterion', () => {
    expect(run(installer, '--target', 'antigravity').status).toBe(0);
    expect(run(runtime, 'init', '--schema', 'sdd', '--feature', 'blocked-resume').status).toBe(0);
    const feature = '.spindle/features/blocked-resume';
    const handoff = `${feature}/.handoffs/define.json`;
    writeFileSync(join(root, feature, 'DEFINE.md'),
      '## Why\nDuplicate callbacks can repeat credits.\n\n' +
      '## What\nIgnore repeated payment IDs.\n\n' +
      '## Acceptance Criteria\n- AC-1: A new payment credits its amount.\n' +
      '- AC-2: A replay leaves the balance unchanged.\n');
    writeFileSync(join(root, handoff), JSON.stringify({
      feature: 'blocked-resume', clarity: 0.9, criteria: ['AC-1'],
    }));
    expect(run(runtime, 'complete', 'define', '--handoff', handoff).status).toBe(0);
    const gate = run(runtime, 'gate', 'G_DEFINE');
    expect(gate.status, gate.stderr).toBe(1);
    expect(JSON.parse(gate.stdout).unmet).toContain('criteria-missing-from-handoff:AC-2');

    const ledger = join(root, '.spindle/run.json');
    const before = readFileSync(ledger, 'utf8');
    const next = run(runtime, 'next');
    expect(next.status).toBe(0);
    expect(JSON.parse(next.stdout)).toMatchObject({
      ready: [expect.objectContaining({ id: 'brainstorm' })],
      resume: {
        phase: 'design',
        status: 'gate-blocked',
        blocked_by: ['G_DEFINE'],
        handoff_path: `${feature}/.handoffs/design.json`,
      },
    });
    expect(readFileSync(ledger, 'utf8')).toBe(before);
    expect(existsSync(join(root, feature, 'DESIGN.md'))).toBe(false);
  });
});
