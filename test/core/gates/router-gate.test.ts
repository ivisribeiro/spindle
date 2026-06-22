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

function agentWithKb(name: string, domains: string[]): string {
  const list = domains.map((d) => `  - ${d}`).join('\n');
  return `---\nname: ${name}\ndescription: ${name} agent\nkb_domains:\n${list}\n---\n# ${name}\n`;
}

describe('G_ROUTER_COVERAGE (kb_domains referential integrity)', () => {
  it('passes when a declared kb_domain resolves to a real dir', () => {
    fs.mkdirSync(path.join(root, 'kb', 'dbt'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agentWithKb('alpha', ['dbt']));
    const ctx = ctxFor({ agents: ['alpha', 'beta'] });
    ctx.args.kb = path.join(root, 'kb');
    expect(gRouterCoverage(ctx).passed).toBe(true);
  });

  it('blocks on a dangling kb_domain (referential integrity, not usage proof)', () => {
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agentWithKb('alpha', ['ghost']));
    const ctx = ctxFor({ agents: ['alpha', 'beta'] });
    ctx.args.kb = path.join(root, 'kb');
    const r = gRouterCoverage(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('dangling-kb-domain:alpha:ghost');
    expect(r.reasons.some((x) => x.includes('referential integrity'))).toBe(true);
  });

  it('blocks with kb-dir-missing when a domain is declared but the kb dir is absent', () => {
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agentWithKb('alpha', ['dbt']));
    const ctx = ctxFor({ agents: ['alpha', 'beta'] });
    ctx.args.kb = path.join(root, 'does-not-exist');
    const r = gRouterCoverage(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('kb-dir-missing');
  });

  it('skips the kb check entirely when no agent declares kb_domains (kb dir absent)', () => {
    // alpha + beta (from beforeEach) declare no kb_domains; default --kb is absent
    expect(gRouterCoverage(ctxFor({ agents: ['alpha', 'beta'] })).passed).toBe(true);
  });
});
