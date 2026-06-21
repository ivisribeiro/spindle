import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gRouterCoverage } from '../../../src/core/gates/router-gate.js';
import type { GateContext } from '../../../src/core/gates/types.js';

let root: string;
let agentsDir: string;

function agent(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} agent\n---\n# ${name}\n`;
}

function ctxFor(routing: unknown): GateContext {
  const routingPath = path.join(root, 'routing.json');
  fs.writeFileSync(routingPath, JSON.stringify(routing));
  return {
    root,
    args: { agents: agentsDir, routing: routingPath },
    runState: null,
    graph: null,
    featureDir: null,
    handoffDir: null,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-router-'));
  agentsDir = path.join(root, 'agents');
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agent('alpha'));
  fs.writeFileSync(path.join(agentsDir, 'beta.md'), agent('beta'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('G_ROUTER_COVERAGE (bijection)', () => {
  it('passes when routing covers every agent exactly once', () => {
    expect(gRouterCoverage(ctxFor({ agents: ['alpha', 'beta'] })).passed).toBe(true);
  });

  it('blocks when an agent is missing from routing', () => {
    const r = gRouterCoverage(ctxFor({ agents: ['alpha'] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('missing:beta');
  });

  it('blocks when an agent appears more than once', () => {
    const r = gRouterCoverage(ctxFor({ agents: ['alpha', 'beta', 'beta'] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('duplicate:beta');
  });

  it('blocks when routing references an unknown agent', () => {
    const r = gRouterCoverage(ctxFor({ agents: ['alpha', 'beta', 'ghost'] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('extra:ghost');
  });

  it('blocks (no silent skip) on malformed agent frontmatter', () => {
    fs.writeFileSync(path.join(agentsDir, 'broken.md'), '# no frontmatter here\n');
    const r = gRouterCoverage(ctxFor({ agents: ['alpha', 'beta'] }));
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => x.includes('invalid agent frontmatter'))).toBe(true);
  });
});
