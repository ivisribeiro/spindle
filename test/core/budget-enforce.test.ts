import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { cli, tmpProject, writeJson } from '../helpers.js';

// `spin budget --enforce`: an opt-in ceiling on top of the always-exit-0 advisory
// accounting. Ceiling precedence: --max-tokens flag, else config.max_tokens from
// the active schema. Enforcing with no ceiling anywhere is a usage error (exit 2).
// Non-enforce behavior must stay byte-identical to the pre-existing advisory shape.

let root: string;
beforeEach(() => {
  root = tmpProject();
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
const R = (...args: string[]) => cli(['--root', root, ...args]);

async function completeDefineWithUsage(tokensIn: number, tokensOut: number): Promise<void> {
  const file = writeJson(root, 'define.json', {
    feature: 'f',
    clarity: 0.9,
    criteria: ['AC-1'],
    usage: { tier: 'sonnet', tokens_in: tokensIn, tokens_out: tokensOut },
  });
  const c = await R('complete', 'define', '--handoff', file);
  expect(c.code).toBe(0);
}

describe('spin budget --enforce', () => {
  it('under the ceiling with --enforce and --max-tokens: exit 0, self_reported true', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'f');
    await completeDefineWithUsage(100, 50); // 150 total
    const r = await R('budget', '--max-tokens', '1000', '--enforce');
    expect(r.code).toBe(0);
    expect(r.json.over_budget).toBe(false);
    expect(r.json.enforced).toBe(true);
    expect(r.json.self_reported).toBe(true);
    expect(r.json.max_tokens).toBe(1000);
    expect(r.json.ceiling_source).toBe('flag');
  });

  it('over the ceiling with --enforce and --max-tokens: exit 1', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'f');
    await completeDefineWithUsage(800, 400); // 1200 total
    const r = await R('budget', '--max-tokens', '1000', '--enforce');
    expect(r.code).toBe(1);
    expect(r.json.over_budget).toBe(true);
    expect(r.json.self_reported).toBe(true);
    expect(r.json.warning).toContain('exceeds');
  });

  it('--enforce with no ceiling available anywhere: exit 2 (usage error)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'f');
    await completeDefineWithUsage(10, 5);
    const r = await R('budget', '--enforce');
    expect(r.code).toBe(2);
  });

  it('config.max_tokens fallback is honored when --max-tokens is absent', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'f');
    // Add config.max_tokens as the fallback ceiling, keeping the real sdd artifacts
    // (including `define`, which completeDefineWithUsage below still needs) intact.
    const schemaPath = `${root}/.spindle/schema.yaml`;
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    fs.writeFileSync(schemaPath, schema.replace('build_retry_cap: 3', 'build_retry_cap: 3\n  max_tokens: 100'));
    await completeDefineWithUsage(80, 50); // 130 total > 100
    const over = await R('budget', '--enforce');
    expect(over.code).toBe(1);
    expect(over.json.max_tokens).toBe(100);
    expect(over.json.ceiling_source).toBe('config');

    // an explicit --max-tokens flag still takes precedence over config.max_tokens
    const underFlag = await R('budget', '--enforce', '--max-tokens', '10000');
    expect(underFlag.code).toBe(0);
    expect(underFlag.json.ceiling_source).toBe('flag');
    expect(underFlag.json.max_tokens).toBe(10000);
  });

  it('advisory mode (no --enforce) never blocks, even over the ceiling — byte-identical to before', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'f');
    await completeDefineWithUsage(800, 400); // 1200 total
    const r = await R('budget', '--max-tokens', '1000');
    expect(r.code).toBe(0);
    expect(r.json.over_budget).toBe(true);
    expect(r.json.advisory).toBe(true);
    // none of the --enforce-only fields leak into the advisory shape
    expect(r.json.enforced).toBeUndefined();
    expect(r.json.self_reported).toBeUndefined();
    expect(r.json.ceiling_source).toBeUndefined();
  });

  it('a fresh run with no --enforce and no ceiling stays exit 0 (unaffected baseline)', async () => {
    await R('init', '--schema', 'sdd', '--feature', 'f');
    const r = await R('budget');
    expect(r.code).toBe(0);
    expect(r.json.reported).toBeNull();
    expect(r.json.over_budget).toBe(false);
  });
});
