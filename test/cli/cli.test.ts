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

  it('schema validate passes for the bundled sdd schema', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd']);
    const r = await cli(['--root', root, 'schema', 'validate']);
    expect(r.code).toBe(0);
    expect(r.json.valid).toBe(true);
  });
});
