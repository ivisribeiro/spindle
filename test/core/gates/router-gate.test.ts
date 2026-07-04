import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gRouterCoverage } from '../../../src/core/gates/router-gate.js';
import type { GateContext } from '../../../src/core/gates/types.js';

let root: string;
let agentsDir: string;

function agent(name: string, model = 'sonnet'): string {
  return `---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\n---\n# ${name}\n`;
}

interface RouteEntry {
  name: string;
  model?: string;
  kb_domains?: string[];
}

/** Rich-format routing entry (the new shape the gate validates). */
function route(name: string, model = 'sonnet', kb_domains: string[] = []): RouteEntry {
  return { name, model, kb_domains };
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
  it('passes when routing covers every agent exactly once (models validated, no drift)', () => {
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta')] }));
    expect(r.passed).toBe(true);
    expect(r.reasons.some((x) => x.includes('models + descriptions validated'))).toBe(true);
  });

  it('blocks when an agent is missing from routing', () => {
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('missing:beta');
  });

  it('blocks when an agent appears more than once', () => {
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta'), route('beta')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('duplicate:beta');
  });

  it('blocks when routing references an unknown agent', () => {
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta'), route('ghost')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('extra:ghost');
  });

  it('blocks (no silent skip) on malformed agent frontmatter', () => {
    fs.writeFileSync(path.join(agentsDir, 'broken.md'), '# no frontmatter here\n');
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta')] }));
    expect(r.passed).toBe(false);
    expect(r.reasons.some((x) => x.includes('invalid agent frontmatter'))).toBe(true);
  });
});

describe('G_ROUTER_COVERAGE (rich format — semantic roster validation)', () => {
  it('rejects the legacy flat-string routing format with a regenerate reason', () => {
    const r = gRouterCoverage(ctxFor({ agents: ['alpha', 'beta'] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('legacy-format');
    expect(r.reasons.some((x) => x.includes('regenerate with /gen-router'))).toBe(true);
  });

  it('blocks a degraded (name-only) agent frontmatter, naming the file', () => {
    // A name-only frontmatter fails strict YAML+Zod (no description) → degraded fallback.
    fs.writeFileSync(path.join(agentsDir, 'delta.md'), '---\nname: delta\n---\n# delta\n');
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta'), route('delta')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('degraded:delta');
    expect(r.reasons.some((x) => x.includes('degraded agent frontmatter') && x.includes('delta.md'))).toBe(true);
  });

  it('blocks an agent whose model is outside the closed set haiku|sonnet|opus|inherit', () => {
    fs.writeFileSync(path.join(agentsDir, 'gamma.md'), agent('gamma', 'gpt4'));
    // route gamma with the SAME bad model so only invalid-model fires (no drift noise).
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta'), route('gamma', 'gpt4')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('invalid-model:gamma');
    expect(r.reasons.some((x) => x.includes('invalid model') && x.includes('haiku|sonnet|opus|inherit'))).toBe(true);
  });

  it('accepts model "inherit" and an agent that omits model (treated as inherit)', () => {
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agent('alpha', 'inherit'));
    // beta omits model entirely → effective model is "inherit"; routing must match.
    fs.writeFileSync(path.join(agentsDir, 'beta.md'), '---\nname: beta\ndescription: beta agent\n---\n# beta\n');
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha', 'inherit'), route('beta', 'inherit')] }));
    expect(r.passed).toBe(true);
  });

  it('blocks when the routing entry model drifts from the agent frontmatter model', () => {
    // alpha is sonnet on disk; routing claims opus.
    const r = gRouterCoverage(ctxFor({ agents: [route('alpha', 'opus'), route('beta')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('model-drift:alpha');
    expect(r.reasons.some((x) => x.includes('model drift') && x.includes('alpha'))).toBe(true);
  });

  it('blocks when a routing entry is missing its model field', () => {
    const r = gRouterCoverage(ctxFor({ agents: [{ name: 'alpha', kb_domains: [] }, route('beta')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('missing-model:alpha');
  });

  it('blocks a malformed (non-object) routing entry', () => {
    const r = gRouterCoverage(ctxFor({ agents: [{ nope: true }, route('alpha'), route('beta')] }));
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('malformed-entry');
  });
});

function agentWithKb(name: string, domains: string[], model = 'sonnet'): string {
  const list = domains.map((d) => `  - ${d}`).join('\n');
  return `---\nname: ${name}\ndescription: ${name} agent\nmodel: ${model}\nkb_domains:\n${list}\n---\n# ${name}\n`;
}

describe('G_ROUTER_COVERAGE (kb_domains referential integrity)', () => {
  it('passes when a declared kb_domain resolves to a real dir', () => {
    fs.mkdirSync(path.join(root, 'kb', 'dbt'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agentWithKb('alpha', ['dbt']));
    const ctx = ctxFor({ agents: [route('alpha', 'sonnet', ['dbt']), route('beta')] });
    ctx.args.kb = path.join(root, 'kb');
    expect(gRouterCoverage(ctx).passed).toBe(true);
  });

  it('blocks on a dangling kb_domain (referential integrity, not usage proof)', () => {
    fs.mkdirSync(path.join(root, 'kb'), { recursive: true });
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agentWithKb('alpha', ['ghost']));
    const ctx = ctxFor({ agents: [route('alpha', 'sonnet', ['ghost']), route('beta')] });
    ctx.args.kb = path.join(root, 'kb');
    const r = gRouterCoverage(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('dangling-kb-domain:alpha:ghost');
    expect(r.reasons.some((x) => x.includes('referential integrity'))).toBe(true);
  });

  it('blocks with kb-dir-missing when a domain is declared but the kb dir is absent', () => {
    fs.writeFileSync(path.join(agentsDir, 'alpha.md'), agentWithKb('alpha', ['dbt']));
    const ctx = ctxFor({ agents: [route('alpha', 'sonnet', ['dbt']), route('beta')] });
    ctx.args.kb = path.join(root, 'does-not-exist');
    const r = gRouterCoverage(ctx);
    expect(r.passed).toBe(false);
    expect(r.unmet).toContain('kb-dir-missing');
  });

  it('skips the kb check entirely when no agent declares kb_domains (kb dir absent)', () => {
    // alpha + beta (from beforeEach) declare no kb_domains; default --kb is absent
    expect(gRouterCoverage(ctxFor({ agents: [route('alpha'), route('beta')] })).passed).toBe(true);
  });
});
