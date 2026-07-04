import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject, write } from '../helpers.js';

// A cyclic workflow schema must never yield a silently truncated build order.
// Two distinct surfacings, matching the exit-code ABI:
//   - `spin schema validate` reports the cycle as a validation failure (exit 1,
//     same as its handoff/gate reference errors), naming the cycle members.
//   - Any OTHER command that loads the graph (order/next/complete/...) treats a
//     cyclic on-disk schema as corrupt supporting state — exit 3, the same
//     precedent as a corrupt run.json (missing = 2, corrupt = 3).

const CYCLIC_YAML = `name: cyclic
version: 1
artifacts:
  - id: a
    generates: a.md
    requires: [b]
  - id: b
    generates: b.md
    requires: [a]
`;

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const R = (...args: string[]) => cli(['--root', root, ...args]);

describe('cyclic schema surfacing (exit-code ABI)', () => {
  it('schema validate fails (exit 1) and names the cycle members', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'cy');
    write(root, '.spindle/schema.yaml', CYCLIC_YAML);
    const r = await R('schema', 'validate');
    expect(r.code).toBe(1);
    expect(r.json.valid).toBe(false);
    // the DFS names the cycle path, e.g. "Cyclic dependency detected: a -> b -> a"
    expect(r.json.error).toContain('Cyclic dependency');
    expect(r.json.error).toContain('a');
    expect(r.json.error).toContain('b');
  });

  it('spin order on a cyclic schema is an internal error (exit 3), never a truncated order', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'cy');
    write(root, '.spindle/schema.yaml', CYCLIC_YAML);
    const r = await R('order');
    expect(r.code).toBe(3);
  });

  it('spin next on a cyclic schema is an internal error (exit 3)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'cy');
    write(root, '.spindle/schema.yaml', CYCLIC_YAML);
    const r = await R('next');
    expect(r.code).toBe(3);
  });

  it('spin complete on a cyclic schema is an internal error (exit 3)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'cy');
    write(root, '.spindle/schema.yaml', CYCLIC_YAML);
    const r = await R('complete', 'a');
    expect(r.code).toBe(3);
  });
});
