import type { SchemaYaml } from './types.js';

// The closed set of enforceable lifecycle-gate hook KEYS a workflow schema may put in
// its `gates:` map. Anything outside this set is silently inert — the engine cannot
// anchor it to a checkpoint — so `spin schema validate` rejects it (a hook that never
// fires is worse than no hook: it reads as protection that isn't there).
//
//   before_<artifactId>   gate(s) must be green before <artifactId> completes AND
//                         before `spin next` lists it as ready.
//   before_complete       TERMINAL: green before the run is reported complete.
//   during                TERMINAL: green before the run's final artifact completes.
//
// `during` and `before_complete` share the run-TERMINAL anchor. A mid-workflow anchor
// for a bare `during` (no artifact named) is either impossible — G_KB_STRUCTURE reads
// the very concept files the artifacts it would guard produce, so gating them on it
// deadlocks — or redundant, so both terminal hooks are enforced at the same checkpoint:
// the final artifact in build order cannot complete, and the run cannot be reported
// complete, until every terminal gate is recorded green. Neither hook is inert.

export const TERMINAL_HOOK_KEYS = ['during', 'before_complete'] as const;
const BEFORE_PREFIX = 'before_';

function asList(entry: string | string[]): string[] {
  return Array.isArray(entry) ? entry : [entry];
}

/** Gate ids required before `<artifactId>` completes (the `before_<id>` hook). Empty
 *  when the schema declares none. */
export function gatesBeforeArtifact(schema: SchemaYaml, artifactId: string): string[] {
  const entry = schema.gates?.[`${BEFORE_PREFIX}${artifactId}`];
  return entry ? asList(entry) : [];
}

/** Gate ids anchored to the run's terminal checkpoint — the union of the `during` and
 *  `before_complete` hooks, de-duplicated in stable order. */
export function terminalGates(schema: SchemaYaml): string[] {
  const gates = schema.gates ?? {};
  const out: string[] = [];
  for (const key of TERMINAL_HOOK_KEYS) {
    const entry = gates[key];
    if (entry) out.push(...asList(entry));
  }
  return [...new Set(out)];
}

/** Hook KEYS the engine cannot enforce: an unknown form, or a `before_<id>` whose id is
 *  not a real artifact. `spin schema validate` surfaces these so a would-be-inert hook
 *  fails loudly at validation time instead of quietly protecting nothing at runtime. */
export function unenforceableHookKeys(schema: SchemaYaml): string[] {
  const artifactIds = new Set(schema.artifacts.map((a) => a.id));
  const bad: string[] = [];
  for (const key of Object.keys(schema.gates ?? {})) {
    if ((TERMINAL_HOOK_KEYS as readonly string[]).includes(key)) continue;
    if (key.startsWith(BEFORE_PREFIX)) {
      const id = key.slice(BEFORE_PREFIX.length);
      if (id.length > 0 && artifactIds.has(id)) continue;
    }
    bad.push(key);
  }
  return bad;
}
