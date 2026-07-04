import * as fs from 'node:fs';
import * as path from 'node:path';
import { type GateContext, type GateResult, pass, block } from './types.js';
import { parseAgentFrontmatter } from '../validation/frontmatter.js';

// G_ROUTER_COVERAGE — a semantically validated roster, not merely "names exist".
// It asserts a bijection between the agent roster and the generated routing table
// (every agent frontmatter parses, each appears exactly once, none missing, none
// extra — no silent skips), AND, for every roster agent:
//   (a) the frontmatter is NOT the degraded name-only fallback (a degraded parse
//       means the description is missing/unparseable — now a BLOCK, not a shrug);
//   (b) the declared model is in the closed set {haiku, sonnet, opus, inherit};
//   (c) every declared kb_domain resolves to a real dir (referential integrity,
//       NOT usage proof);
//   (d) the routing entry's model MATCHES the agent frontmatter's model (drift
//       between roster and routing blocks).
// The routing table is the rich object format {name, model, kb_domains}. The old
// flat-string format is rejected with a clear "regenerate with /gen-router".

// The closed set of model tiers a roster agent may declare. These are the values
// that actually appear in plugin/agents (haiku|sonnet|opus) plus `inherit` (an
// agent that omits `model` inherits the caller's — treated as the effective model).
const VALID_MODELS = new Set(['haiku', 'sonnet', 'opus', 'inherit']);

interface RoutingEntry {
  name: string;
  model?: string;
  kb_domains?: string[];
}

interface RoutingFile {
  agents?: unknown[];
}

function listAgentFiles(dir: string): string[] {
  const out: string[] = [];
  function walk(d: string) {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.name.endsWith('.md') &&
        !entry.name.startsWith('_') &&
        entry.name.toLowerCase() !== 'readme.md'
      )
        out.push(full);
    }
  }
  walk(dir);
  return out.sort();
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function gRouterCoverage(ctx: GateContext): GateResult {
  const gate = 'G_ROUTER_COVERAGE';
  const agentsDir = ctx.args.agents;
  const routingPath = ctx.args.routing;

  if (!agentsDir || !fs.existsSync(agentsDir)) {
    return block(gate, [`agents dir not found: ${agentsDir ?? '(unset)'}`], ['agents-dir']);
  }
  if (!routingPath || !fs.existsSync(routingPath)) {
    return block(gate, [`routing file not found: ${routingPath ?? '(unset)'}`], ['routing-file']);
  }

  const reasons: string[] = [];
  const unmet: string[] = [];

  // --kb resolves the KB root for the referential-integrity check (NOT usage
  // proof): a declared domain must point at a real dir. Default plugin/kb under root.
  const kbDir = ctx.args.kb ? path.resolve(ctx.root, ctx.args.kb) : path.resolve(ctx.root, 'plugin/kb');
  const kbPresent = isDir(kbDir);

  // 1. Parse every agent frontmatter, fail-closed. Collect name + model (source of
  //    truth) and kb_domains. A degraded (name-only) parse is a BLOCK: the roster
  //    must be fully typed, not merely name-bearing.
  const rosterNames: string[] = [];
  const rosterModel = new Map<string, string>(); // effective model (omit => inherit)
  const degraded = new Set<string>();
  const declaredDomains: Array<{ agent: string; domain: string }> = [];
  for (const file of listAgentFiles(agentsDir)) {
    const rel = path.relative(agentsDir, file);
    const md = fs.readFileSync(file, 'utf-8');
    const fm = parseAgentFrontmatter(md);
    if (!fm.ok) {
      reasons.push(`invalid agent frontmatter: ${rel} (${fm.error})`);
      unmet.push(rel);
      continue;
    }
    const name = fm.data!.name;
    rosterNames.push(name);
    // An omitted model means "inherit"; record that so drift-matching is meaningful.
    rosterModel.set(name, fm.data!.model ?? 'inherit');
    if (fm.degraded) {
      // Name-only fallback: the strict YAML+Zod parse failed (missing/unparseable
      // description). Reject it — routing needs a fully typed roster entry.
      reasons.push(
        `degraded agent frontmatter: ${rel} (name-only fallback — description missing or unparseable; fix the frontmatter)`
      );
      unmet.push(`degraded:${name}`);
      degraded.add(name);
      continue; // model + kb_domains are unreliable on a degraded parse
    }
    const model = fm.data!.model ?? 'inherit';
    if (!VALID_MODELS.has(model)) {
      reasons.push(
        `agent "${name}" declares invalid model "${model}" (must be one of ${[...VALID_MODELS].join('|')})`
      );
      unmet.push(`invalid-model:${name}`);
    }
    for (const d of fm.data!.kb_domains ?? []) {
      declaredDomains.push({ agent: name, domain: d });
    }
  }

  // 2. Load routing output.
  let routing: RoutingFile;
  try {
    routing = JSON.parse(fs.readFileSync(routingPath, 'utf-8')) as RoutingFile;
  } catch {
    return block(gate, [`routing file is not valid JSON: ${routingPath}`], ['routing-json']);
  }
  const rawEntries = Array.isArray(routing.agents) ? routing.agents : [];

  // 2a. Reject the legacy flat-string format outright. A single clear reason —
  //     do NOT silently accept both shapes.
  const legacyCount = rawEntries.filter((e) => typeof e === 'string').length;
  if (legacyCount > 0) {
    return block(
      gate,
      [
        `routing.json entry must be an object {name, model, kb_domains}, found ${legacyCount} legacy string ${
          legacyCount === 1 ? 'entry' : 'entries'
        } — regenerate with /gen-router`,
      ],
      ['legacy-format']
    );
  }

  // 2b. Parse the rich object entries. A non-object or name-less entry is malformed.
  const routedEntries: RoutingEntry[] = [];
  for (const e of rawEntries) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) {
      reasons.push(`routing.json entry is not an object: ${JSON.stringify(e)} — regenerate with /gen-router`);
      unmet.push('malformed-entry');
      continue;
    }
    const obj = e as Record<string, unknown>;
    const name = typeof obj.name === 'string' ? obj.name : undefined;
    if (!name) {
      reasons.push(`routing.json entry missing a string "name": ${JSON.stringify(e)}`);
      unmet.push('malformed-entry');
      continue;
    }
    routedEntries.push({
      name,
      model: typeof obj.model === 'string' ? obj.model : undefined,
      kb_domains: Array.isArray(obj.kb_domains)
        ? (obj.kb_domains.filter((x) => typeof x === 'string') as string[])
        : undefined,
    });
  }

  // 3. Bijection checks over the routing entry names.
  const routedNames = routedEntries.map((e) => e.name);
  const rosterSet = new Set(rosterNames);
  const routedCounts = new Map<string, number>();
  for (const name of routedNames) routedCounts.set(name, (routedCounts.get(name) ?? 0) + 1);

  for (const name of rosterSet) {
    const count = routedCounts.get(name) ?? 0;
    if (count === 0) {
      reasons.push(`agent missing from routing: ${name}`);
      unmet.push(`missing:${name}`);
    } else if (count > 1) {
      reasons.push(`agent appears ${count}x in routing (bijection broken): ${name}`);
      unmet.push(`duplicate:${name}`);
    }
  }
  for (const name of routedCounts.keys()) {
    if (!rosterSet.has(name)) {
      reasons.push(`routing references unknown agent: ${name}`);
      unmet.push(`extra:${name}`);
    }
  }

  // 4. Model drift: the routing entry model must MATCH the agent frontmatter model.
  //    Skip entries not in the roster (bijection handles those) and degraded agents
  //    (already blocked; their model is unreliable).
  for (const e of routedEntries) {
    if (!rosterSet.has(e.name) || degraded.has(e.name)) continue;
    const agentModel = rosterModel.get(e.name)!;
    if (e.model === undefined) {
      reasons.push(`routing entry for "${e.name}" is missing "model" — regenerate with /gen-router`);
      unmet.push(`missing-model:${e.name}`);
    } else if (e.model !== agentModel) {
      reasons.push(
        `routing model drift for "${e.name}": routing says "${e.model}" but agent frontmatter declares "${agentModel}"`
      );
      unmet.push(`model-drift:${e.name}`);
    }
  }

  // 5. Referential integrity for kb_domains (NOT usage proof). Only checked when
  //    at least one agent declares a domain — zero declarations skips the check
  //    entirely, so a roster with no KB usage (and no kb dir) still passes.
  if (declaredDomains.length > 0) {
    if (!kbPresent) {
      reasons.push(
        `cannot verify ${declaredDomains.length} declared kb_domains: KB dir not found at ${kbDir} (pass --kb)`
      );
      unmet.push('kb-dir-missing');
    } else {
      for (const { agent, domain } of declaredDomains) {
        if (!isDir(path.join(kbDir, domain))) {
          reasons.push(
            `agent "${agent}" declares kb_domain "${domain}" with no dir at ${path.join(kbDir, domain)} (referential integrity, not usage proof)`
          );
          unmet.push(`dangling-kb-domain:${agent}:${domain}`);
        }
      }
    }
  }

  if (unmet.length === 0) {
    return pass(gate, [
      `bijection holds over ${rosterNames.length} agents (models + descriptions validated, no drift)`,
      kbPresent && declaredDomains.length > 0
        ? `all ${declaredDomains.length} declared kb_domains resolve (referential integrity)`
        : 'no kb_domains to verify',
    ]);
  }
  return block(gate, reasons, unmet);
}
