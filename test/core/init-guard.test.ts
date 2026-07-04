import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject } from '../helpers.js';

// `spin init` must not silently clobber an in-progress run (one active run per
// checkout, CLAUDE.md §8). A pristine run (zero progress) stays freely
// re-init-able; a run with recorded progress requires --force.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const R = (...args: string[]) => cli(['--root', root, ...args]);

describe('spin init — one active run per checkout', () => {
  it('inits cleanly into a fresh directory (exit 0)', async () => {
    const r = await R('init', '--schema', 'sdd', '--feature', 'fresh');
    expect(r.code).toBe(0);
    expect(r.json.initialized).toBe(true);
    expect(r.json.schema).toBe('sdd');
    expect(r.json.feature).toBe('fresh');
  });

  it('re-inits a pristine run freely, with no --force needed (exit 0)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'pristine');
    const r = await R('init', '--schema', 'sdd', '--feature', 'pristine');
    expect(r.code).toBe(0);
    expect(r.json.initialized).toBe(true);
  });

  it('a pristine run may even be re-init-ed under a DIFFERENT schema/feature (exit 0)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'a');
    const r = await R('init', '--schema', 'kb', '--feature', 'b');
    expect(r.code).toBe(0);
    expect(r.json.schema).toBe('kb');
    expect(r.json.feature).toBe('b');
  });

  it('refuses to clobber a run with a recorded gate verdict (exit 1, names the active run)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'busy');
    // G_DEFINE blocks (no DEFINE.md yet) but the verdict is still RECORDED into gates{}
    // — that recorded verdict is progress, even though the gate itself failed.
    const g = await R('gate', 'G_DEFINE');
    expect(g.code).toBe(1);

    const r = await R('init', '--schema', 'sdd', '--feature', 'other');
    expect(r.code).toBe(1);
    expect(r.json.initialized).toBe(false);
    expect(r.json.active).toEqual({ schema: 'sdd', feature: 'busy' });
    expect(JSON.stringify(r.json.reason)).toContain('busy');
    expect(JSON.stringify(r.json.escape_hatch)).toContain('--force');

    // the active run must be untouched by the refused attempt
    const state = await R('state');
    expect(state.json.feature).toBe('busy');
  });

  it('refuses to clobber a run with a completed artifact (exit 1)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'busy2');
    // brainstorm is handoff-less; `spin complete` just needs its output on disk.
    fs.mkdirSync(`${root}/.spindle/features/busy2`, { recursive: true });
    fs.writeFileSync(`${root}/.spindle/features/busy2/BRAINSTORM.md`, '# notes\n');
    const c = await R('complete', 'brainstorm');
    expect(c.code).toBe(0);

    const r = await R('init', '--schema', 'sdd', '--feature', 'busy2');
    expect(r.code).toBe(1);
    expect(r.json.active.feature).toBe('busy2');
  });

  it('--force overwrites an in-progress run (exit 0) and the state is actually reset', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'busy3');
    await R('gate', 'G_DEFINE'); // creates progress (a recorded, blocked verdict)

    const r = await R('init', '--schema', 'sdd', '--feature', 'fresh-again', '--force');
    expect(r.code).toBe(0);
    expect(r.json.initialized).toBe(true);
    expect(r.json.forced).toBe(true);

    const state = await R('state');
    expect(state.json.feature).toBe('fresh-again');
    expect(state.json.completed).toEqual([]);
    expect(state.json.events).toEqual([]);
    expect(state.json.gates).toEqual({});
    expect(state.json.approval).toBeNull();
  });
});
