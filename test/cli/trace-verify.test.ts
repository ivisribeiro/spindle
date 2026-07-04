import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject } from '../helpers.js';
import { runFilePath } from '../../src/core/run/run-state.js';

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Complete `define` with a minimal valid handoff — the same pattern used by
 *  the existing `spin trace` tests in test/cli/cli.test.ts. */
async function completeDefine(rootDir: string): Promise<void> {
  const file = `${rootDir}/define.json`;
  fs.writeFileSync(
    file,
    JSON.stringify({
      feature: 'f',
      clarity: 0.9,
      criteria: ['AC-1'],
      usage: { tier: 'sonnet', tokens_in: 10, tokens_out: 5 },
    })
  );
  await cli(['--root', rootDir, 'complete', 'define', '--handoff', file]);
}

describe('spin trace --verify (hash-chain tamper evidence)', () => {
  it('plain `spin trace` is unchanged: no `chain` key, exit 0', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    await completeDefine(root);
    const r = await cli(['--root', root, 'trace']);
    expect(r.code).toBe(0);
    expect(r.json.chain).toBeUndefined();
  });

  it('--verify on a fresh run exits 0 with an empty chain', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'trace', '--verify']);
    expect(r.code).toBe(0);
    expect(r.json.chain).toEqual({ verified: 0, legacy: 0 });
  });

  it('--verify exits 0 with the right counts after several real mutation-point events', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    await completeDefine(root); // 'complete' event
    await cli(['--root', root, 'gate', 'G_DEFINE']); // blocks (exit 1) but still records a 'gate' event
    await cli(['--root', root, 'retry', 'design', '--inc']); // 'retry' event

    const r = await cli(['--root', root, 'trace', '--verify']);
    expect(r.code).toBe(0);
    expect(r.json.chain.legacy).toBe(0);
    expect(r.json.chain.verified).toBe(r.json.events.length);
    expect(r.json.chain.verified).toBeGreaterThanOrEqual(3);
  });

  it('--verify exits 1 and names the first broken link when an event is tampered', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    await completeDefine(root);
    await cli(['--root', root, 'retry', 'design', '--inc']);

    const file = runFilePath(root);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(raw.events.length).toBe(2);
    raw.events[1].attempt = 99; // mutate the second event's content in place
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');

    const r = await cli(['--root', root, 'trace', '--verify']);
    expect(r.code).toBe(1);
    expect(r.json.chain.broken_at).toBe(1);
    expect(typeof r.json.chain.reason).toBe('string');
    expect(r.json.chain.reason).toContain('index 1');
  });

  it('--verify on a hand-written legacy (unhashed) ledger exits 0 and reports the legacy count', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const file = runFilePath(root);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.events = [
      { kind: 'complete', at: new Date().toISOString(), id: 'define' },
      { kind: 'retry', at: new Date().toISOString(), id: 'design', attempt: 1 },
    ]; // no `hash` field — simulates a pre-existing ledger written before this feature
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');

    const r = await cli(['--root', root, 'trace', '--verify']);
    expect(r.code).toBe(0);
    expect(r.json.chain).toEqual({ verified: 0, legacy: 2 });
  });

  it('appending to a legacy ledger starts the chain fresh (prev=null) and verifies', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const file = runFilePath(root);
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    raw.events = [{ kind: 'complete', at: new Date().toISOString(), id: 'define' }];
    fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');

    await cli(['--root', root, 'retry', 'design', '--inc']); // appended through the real mutation point

    const r = await cli(['--root', root, 'trace', '--verify']);
    expect(r.code).toBe(0);
    expect(r.json.chain).toEqual({ verified: 1, legacy: 1 });
  });

  it('requires a run (exit 2 before init), same as plain trace', async () => {
    const r = await cli(['--root', root, 'trace', '--verify']);
    expect(r.code).toBe(2);
  });
});
