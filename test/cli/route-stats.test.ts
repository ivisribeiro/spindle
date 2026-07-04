import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject } from '../helpers.js';
import { runFilePath } from '../../src/core/run/run-state.js';

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

/** Seed run.json's events[] directly with a mixed trajectory (completions across
 *  tiers + an unattributed one, plus retries) — `spin route --stats` is a pure
 *  reader of the ledger, so this is equivalent to driving it through real CLI
 *  calls but avoids entangling the test with G_DEFINE/G_DESIGN handoff plumbing
 *  that is orthogonal to what --stats aggregates. */
function seedEvents(rootDir: string, events: unknown[]): void {
  const file = runFilePath(rootDir);
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
  raw.events = events;
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n');
}

describe('spin route <kind> — unchanged', () => {
  it('still resolves a task kind with no --root init required', async () => {
    const r = await cli(['--root', root, 'route', 'adversary']);
    expect(r.code).toBe(0);
    expect(r.json.tier).toBe('opus');
  });

  it('still exits 2 (usage) on an unknown kind', async () => {
    const r = await cli(['--root', root, 'route', 'bogus']);
    expect(r.code).toBe(2);
  });

  it('--budget low still downgrades a gate-backstopped kind', async () => {
    const r = await cli(['--root', root, 'route', 'code-build', '--budget', 'low']);
    expect(r.code).toBe(0);
    expect(r.json.tier).toBe('haiku');
  });
});

describe('spin route --stats (advisory routing accounting)', () => {
  it('with neither a taskKind nor --stats, exits 2 (malformed invocation)', async () => {
    const r = await cli(['--root', root, 'route']);
    expect(r.code).toBe(2);
  });

  it('requires a run — exit 2 before init, consistent with spin trace', async () => {
    const r = await cli(['--root', root, 'route', '--stats']);
    expect(r.code).toBe(2);
  });

  it('reports all-zero aggregates on an empty run', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'route', '--stats']);
    expect(r.code).toBe(0);
    expect(r.json).toEqual({
      byTier: {
        haiku: { completions: 0, tokens_in: 0, tokens_out: 0 },
        sonnet: { completions: 0, tokens_in: 0, tokens_out: 0 },
        opus: { completions: 0, tokens_in: 0, tokens_out: 0 },
      },
      retries: {},
      unattributed: 0,
    });
  });

  it('aggregates mixed usage-annotated completions and retries correctly (always exit 0)', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const ts = new Date().toISOString();
    seedEvents(root, [
      { kind: 'complete', at: ts, id: 'define', usage: { tier: 'opus', tokens_in: 800, tokens_out: 200 } },
      { kind: 'complete', at: ts, id: 'design', usage: { tier: 'sonnet', tokens_in: 100, tokens_out: 40 } },
      { kind: 'complete', at: ts, id: 'build-a', usage: { tier: 'sonnet', tokens_in: 50, tokens_out: 10 } },
      { kind: 'complete', at: ts, id: 'build-b', usage: { tier: 'haiku', tokens_in: 5, tokens_out: 5 } },
      { kind: 'complete', at: ts, id: 'ship' }, // no usage reported — unattributed
      { kind: 'retry', at: ts, id: 'build-a', attempt: 1 },
      { kind: 'retry', at: ts, id: 'build-a', attempt: 2 },
      { kind: 'retry', at: ts, id: 'design', attempt: 1 },
      { kind: 'gate', at: ts, gate: 'G_DEFINE', passed: true, reasons: [] },
    ]);

    const r = await cli(['--root', root, 'route', '--stats']);
    expect(r.code).toBe(0);
    expect(r.json.byTier.opus).toEqual({ completions: 1, tokens_in: 800, tokens_out: 200 });
    expect(r.json.byTier.sonnet).toEqual({ completions: 2, tokens_in: 150, tokens_out: 50 });
    expect(r.json.byTier.haiku).toEqual({ completions: 1, tokens_in: 5, tokens_out: 5 });
    expect(r.json.retries).toEqual({ 'build-a': 2, design: 1 });
    expect(r.json.unattributed).toBe(1);
  });

  it('a taskKind argument takes precedence over --stats (kind mode wins)', async () => {
    await cli(['--root', root, 'init', '--schema', 'sdd', '--feature', 'f']);
    const r = await cli(['--root', root, 'route', 'adversary', '--stats']);
    expect(r.code).toBe(0);
    expect(r.json.tier).toBe('opus');
    expect(r.json.byTier).toBeUndefined();
  });
});
