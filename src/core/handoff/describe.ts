import { z } from 'zod';
import { HANDOFF_SCHEMAS, isHandoffId, type HandoffId } from './schemas.js';

// A small, dependency-free Zod introspector. `spin schema show <handoff-id>` uses
// it to print a handoff's field shape (name, type, required?, constraints) so an
// agent can author the JSON sidecar WITHOUT reading schemas.ts (dogfood F2). It
// covers exactly the Zod constructs the handoff schemas use; an unrecognized node
// degrades to its raw typeName rather than throwing.

export interface FieldDesc {
  name: string;
  type: string;
  required: boolean;
  constraints?: string[];
  enumValues?: string[];
  default?: unknown;
  fields?: FieldDesc[]; // nested object, or the element shape of an array-of-objects
}

export interface HandoffDesc {
  id: string;
  fields: FieldDesc[];
}

export interface Unwrapped {
  core: z.ZodTypeAny;
  required: boolean;
  default?: unknown;
}

// Exported so `unknown-keys.ts` can peel the same ZodOptional/ZodDefault/ZodNullable
// wrappers without duplicating this logic (DRY — both modules need the schema's
// CORE shape, not its optionality wrapper).
/** Peel ZodOptional / ZodDefault / ZodNullable to find the core type + required-ness. */
export function unwrap(t: z.ZodTypeAny): Unwrapped {
  let core = t;
  let required = true;
  let def: unknown;
  // Loop because constructs can nest (e.g. .optional().default(...)).
  for (;;) {
    const name = (core as { _def?: { typeName?: string } })._def?.typeName;
    if (name === 'ZodOptional') {
      required = false;
      core = (core as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    } else if (name === 'ZodDefault') {
      required = false;
      const d = (core as unknown as { _def: { defaultValue: () => unknown; innerType: z.ZodTypeAny } })._def;
      try {
        def = d.defaultValue();
      } catch {
        /* default factory threw; omit */
      }
      core = d.innerType;
    } else if (name === 'ZodNullable') {
      core = (core as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
    } else {
      break;
    }
  }
  return { core, required, default: def };
}

function stringConstraints(t: z.ZodTypeAny): string[] {
  const checks =
    (t as unknown as { _def: { checks?: Array<{ kind: string; value?: number; regex?: RegExp }> } })._def
      .checks ?? [];
  const out: string[] = [];
  for (const c of checks) {
    if (c.kind === 'regex' && c.regex) out.push(`matches ${c.regex.toString()}`);
    else if (c.kind === 'min') out.push(`min length ${c.value}`);
    else if (c.kind === 'max') out.push(`max length ${c.value}`);
    else if (c.kind === 'email') out.push('email');
    else out.push(c.kind);
  }
  return out;
}

function numberConstraints(t: z.ZodTypeAny): string[] {
  const checks = (t as unknown as { _def: { checks?: Array<{ kind: string; value?: number }> } })._def.checks ?? [];
  return checks.map((c) => (c.value !== undefined ? `${c.kind} ${c.value}` : c.kind));
}

function describeCore(core: z.ZodTypeAny): Pick<FieldDesc, 'type' | 'constraints' | 'enumValues' | 'fields'> {
  const name = (core as { _def?: { typeName?: string } })._def?.typeName;
  switch (name) {
    case 'ZodString': {
      const constraints = stringConstraints(core);
      return { type: 'string', ...(constraints.length ? { constraints } : {}) };
    }
    case 'ZodNumber': {
      const constraints = numberConstraints(core);
      return { type: 'number', ...(constraints.length ? { constraints } : {}) };
    }
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodEnum':
      return { type: 'enum', enumValues: (core as unknown as { _def: { values: string[] } })._def.values };
    case 'ZodArray': {
      const adef = (core as unknown as {
        _def: { type: z.ZodTypeAny; minLength?: { value: number }; maxLength?: { value: number } };
      })._def;
      const el = unwrap(adef.type);
      const elDesc = describeCore(el.core);
      // Surface the ELEMENT's constraints — the per-item rule (e.g. criteria items
      // must match /^AC-\d+$/) is exactly what an agent needs and what was being
      // dropped (dogfood run #2, G1). Prefix with "items" so array-level vs
      // item-level rules don't conflate.
      const constraints: string[] = [];
      if (adef.minLength) constraints.push(`min ${adef.minLength.value} item(s)`);
      if (adef.maxLength) constraints.push(`max ${adef.maxLength.value} item(s)`);
      for (const c of elDesc.constraints ?? []) constraints.push(`items ${c}`);
      if (elDesc.enumValues) constraints.push(`items in ${JSON.stringify(elDesc.enumValues)}`);
      return {
        type: `array<${elDesc.type}>`,
        ...(constraints.length ? { constraints } : {}),
        ...(elDesc.fields ? { fields: elDesc.fields } : {}),
      };
    }
    case 'ZodObject':
      return { type: 'object', fields: describeObject(core) };
    default:
      return { type: name ? name.replace(/^Zod/, '').toLowerCase() : 'unknown' };
  }
}

function describeObject(obj: z.ZodTypeAny): FieldDesc[] {
  const shape = (obj as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
  return Object.entries(shape).map(([fname, ztype]) => {
    const u = unwrap(ztype);
    const core = describeCore(u.core);
    return {
      name: fname,
      type: core.type,
      required: u.required,
      ...(core.constraints ? { constraints: core.constraints } : {}),
      ...(core.enumValues ? { enumValues: core.enumValues } : {}),
      ...(u.default !== undefined ? { default: u.default } : {}),
      ...(core.fields ? { fields: core.fields } : {}),
    };
  });
}

/** Describe a handoff schema by id, or null if the id is unknown. */
export function describeHandoff(id: string): HandoffDesc | null {
  if (!isHandoffId(id)) return null;
  const schema = HANDOFF_SCHEMAS[id as HandoffId];
  return { id, fields: describeObject(schema as unknown as z.ZodTypeAny) };
}

export function listHandoffIds(): string[] {
  return Object.keys(HANDOFF_SCHEMAS).sort();
}
