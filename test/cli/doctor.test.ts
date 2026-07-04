import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject } from '../helpers.js';

// `spin doctor` — read-only orientation + environment diagnosis. Always exit 0
// on a successful diagnosis (even a corrupt/invalid ledger is REPORTED, not
// blocked); exit 3 is reserved for the check itself crashing.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('spin doctor', () => {
  it('on an empty dir: exit 0, reports no run, recommends `spin init`', async () => {
    const r = await cli(['--root', root, 'doctor']);
    expect(r.code).toBe(0);
    expect(r.json.spindle.dirExists).toBe(false);
    expect(r.json.spindle.runFileExists).toBe(false);
    expect(r.json.runState.loaded).toBe(false);
    expect(r.json.schema.exists).toBe(false);
    expect(r.json.next.action).toBe('init');
    expect(r.json.next.command).toContain('spin init');
    // node diagnostics always present, even with no run
    expect(typeof r.json.node.version).toBe('string');
  });

  it('on a fresh sdd run: reports the ledger and recommends the first ready command', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'checkout']);
    const r = await cli(['--root', root, 'doctor']);
    expect(r.code).toBe(0);
    expect(r.json.spindle.dirExists).toBe(true);
    expect(r.json.runState.loaded).toBe(true);
    expect(r.json.runState.schema).toBe('sdd');
    expect(r.json.runState.feature).toBe('checkout');
    expect(r.json.runState.completed).toEqual([]);
    expect(r.json.schema.valid).toBe(true);
    // brainstorm + define are both ready on a fresh sdd run; ready[] is sorted
    // (see ArtifactGraph.getNextArtifacts), so brainstorm sorts first.
    expect(r.json.next.action).toBe('run_command');
    expect(r.json.next.command).toBe('/brainstorm');
  });

  it('advances the recommendation once brainstorm/define complete and G_DEFINE passes', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'checkout']);
    // brainstorm is handoff-less — completing it just needs its output on disk.
    fs.mkdirSync(`${root}/.spindle/features/checkout`, { recursive: true });
    fs.writeFileSync(`${root}/.spindle/features/checkout/BRAINSTORM.md`, '# notes\n');
    await cli(['--root', root, 'complete', 'brainstorm']);

    const defineFile = `${root}/define.json`;
    fs.writeFileSync(
      defineFile,
      JSON.stringify({ feature: 'checkout', clarity: 0.9, criteria: ['AC-1'] })
    );
    fs.writeFileSync(
      `${root}/.spindle/features/checkout/DEFINE.md`,
      '## Why\nx\n## What\ny\n## Acceptance Criteria\nAC-1: z\n'
    );
    await cli(['--root', root, 'complete', 'define', '--handoff', defineFile]);
    await cli(['--root', root, 'gate', 'G_DEFINE']);

    const r = await cli(['--root', root, 'doctor']);
    expect(r.code).toBe(0);
    expect(r.json.runState.completed.sort()).toEqual(['brainstorm', 'define']);
    expect(r.json.runState.gatesSummary.passed).toBe(1);
    expect(r.json.next.command).toBe('/design');
  });

  it('reports a corrupt run.json without blocking (exit 0), and recommends fixing it', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    fs.writeFileSync(`${root}/.spindle/run.json`, '{ not json');
    const r = await cli(['--root', root, 'doctor']);
    expect(r.code).toBe(0);
    expect(r.json.runState.loaded).toBe(false);
    expect(r.json.runState.error).toBeTruthy();
    expect(r.json.next.action).toBe('fix_run_state');
  });

  it('reports an invalid schema.yaml without blocking (exit 0), and recommends fixing it', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    fs.writeFileSync(
      `${root}/.spindle/schema.yaml`,
      'name: t\nversion: 1\nartifacts:\n  - id: a\n    generates: A.md\n    handoff: bogus-handoff\n    requires: []\n'
    );
    const r = await cli(['--root', root, 'doctor']);
    expect(r.code).toBe(0);
    expect(r.json.schema.valid).toBe(false);
    expect(r.json.schema.errors.join(' ')).toContain('bogus-handoff');
    expect(r.json.next.action).toBe('fix_schema');
  });
});
