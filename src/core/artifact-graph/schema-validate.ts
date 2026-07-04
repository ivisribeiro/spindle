import { parseSchema } from './schema.js';
import { unenforceableHookKeys } from './gate-hooks.js';
import { isGateId } from '../gates/registry.js';
import { isHandoffId } from '../handoff/schemas.js';

// Referential-integrity validation for an on-disk schema.yaml, shared by
// `spin schema validate` and `spin doctor` so the check is defined exactly once.
// `parseSchema` already Zod-validates the shape and runs the DFS cycle /
// duplicate-id / dangling-require checks (it throws SchemaValidationError on any
// of those); this layer additionally verifies that every handoff/gate id the
// schema cites actually exists in the closed sets core knows about.

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

/** Validate raw schema.yaml content. Throws SchemaValidationError (propagated from
 *  `parseSchema`) for structural problems (bad shape, duplicate ids, dangling
 *  `requires`, cycles); callers should catch that the same way they already do. */
export function validateSchemaContent(yamlContent: string): SchemaValidationResult {
  const schema = parseSchema(yamlContent);
  const errors: string[] = [];

  // An editable schema must only cite handoff ids and gate ids that actually
  // exist (the "closed sets") — else `spin complete`/`spin gate` would fail
  // confusingly at runtime instead of here.
  for (const a of schema.artifacts) {
    if (a.handoff && !isHandoffId(a.handoff)) {
      errors.push(`artifact "${a.id}" references unknown handoff "${a.handoff}"`);
    }
  }

  // Hook KEYS must be enforceable, not just their gate-id VALUES. A key the engine
  // cannot anchor to a checkpoint (unknown form, or before_<id> for a non-artifact)
  // would be silently inert — worse than absent, since it reads as protection that
  // never fires.
  for (const badKey of unenforceableHookKeys(schema)) {
    errors.push(
      `gate hook "${badKey}" is not an enforceable lifecycle hook (use before_<artifactId>, before_complete, or during)`
    );
  }
  for (const [hook, val] of Object.entries(schema.gates ?? {})) {
    for (const g of Array.isArray(val) ? val : [val]) {
      if (!isGateId(g)) errors.push(`gate hook "${hook}" references unknown gate "${g}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}
