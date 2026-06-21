import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject, write, writeJson } from '../helpers.js';

// Drives the KB authoring graph through the real CLI. Proves G_KB_COVERAGE blocks
// until every manifest-declared concept actually exists with enough test cases —
// replacing create-kb's blind delegation to an agent.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const R = (...args: string[]) => cli(['--root', root, ...args]);
const FD = () => `${root}/.spindle/features/redis`;

describe('E2E: KB cycle through the spin CLI', () => {
  it('blocks coverage until every manifest concept is authored', async () => {
    expect((await R('init', '--schema', 'kb', '--feature', 'redis')).code).toBe(0);

    const ready = await R('next');
    expect(ready.json.ready.map((x: any) => x.id)).toContain('manifest');

    // manifest declares two concepts
    writeJson(root, '.spindle/features/redis/manifest.json', {
      concepts: [{ slug: 'hashes' }, { slug: 'streams' }],
    });

    // structure not yet satisfied (no index / quick-reference / concept files)
    expect((await R('gate', 'G_KB_STRUCTURE')).code).toBe(1);

    // author scaffolding + one of two concepts
    write(root, '.spindle/features/redis/index.md', '# redis\n');
    write(root, '.spindle/features/redis/quick-reference.md', '# cheatsheet\n');
    write(root, '.spindle/features/redis/concept-hashes.md', '# hashes\n');
    writeJson(root, '.spindle/features/redis/.handoffs/kb-concept-hashes.json', {
      concept: 'hashes',
      summary: 'redis hashes',
      test_cases: ['HSET k f v'],
    });

    // structure now passes (>=1 concept + scaffolding present)
    expect((await R('gate', 'G_KB_STRUCTURE')).code).toBe(0);

    // coverage BLOCKS — 'streams' is declared but not authored
    const blocked = await R('gate', 'G_KB_COVERAGE');
    expect(blocked.code).toBe(1);
    expect(blocked.json.unmet).toContain('concept:streams');

    // author the missing concept
    write(root, '.spindle/features/redis/concept-streams.md', '# streams\n');
    writeJson(root, '.spindle/features/redis/.handoffs/kb-concept-streams.json', {
      concept: 'streams',
      summary: 'redis streams',
      test_cases: ['XADD s * f v'],
    });

    expect((await R('gate', 'G_KB_COVERAGE')).code).toBe(0);
  });

  it('blocks coverage when a concept has too few test cases', async () => {
    await R('init', '--schema', 'kb', '--feature', 'redis');
    writeJson(root, '.spindle/features/redis/manifest.json', { concepts: [{ slug: 'geo' }] });
    write(root, '.spindle/features/redis/index.md', '# x\n');
    write(root, '.spindle/features/redis/quick-reference.md', '# x\n');
    write(root, '.spindle/features/redis/concept-geo.md', '# geo\n');
    writeJson(root, '.spindle/features/redis/.handoffs/kb-concept-geo.json', {
      concept: 'geo',
      summary: 'geo',
      test_cases: [], // below kb_min_test_cases (1)
    });
    const r = await R('gate', 'G_KB_COVERAGE');
    expect(r.code).toBe(1);
    expect(r.json.unmet).toContain('test-cases:geo');
  });
});
