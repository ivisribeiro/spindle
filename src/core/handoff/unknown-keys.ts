import { z } from 'zod';
import { unwrap } from './describe.js';

// Zod's default (non-strict) `z.object()` silently STRIPS keys it doesn't
// recognize on a successful `.parse()` — so a typo like "files_writen" (instead
// of "files_written") or "pased" (instead of "passed") validates cleanly and the
// mistake vanishes without a trace. This is the repo's documented P2 gap: the
// worker never learns its sidecar was misspelled.
//
// This module recovers that signal AFTER a successful parse by diffing the RAW
// input's keys against the schema's own `shape`. It is advisory-only (see
// handoff-check.ts) — it never changes `ok`/exit code, it just names what got
// dropped so a caller can notice.
//
// Recursion is bounded to exactly ONE level, and only into array-of-object
// fields (e.g. `results[]`, `findings[]`, `manifest[]`) — deliberately not a
// generic deep-object walker. One level covers every handoff shape in
// schemas.ts today; going deeper would add real complexity for no known case.

function typeNameOf(t: z.ZodTypeAny): string | undefined {
  return (t as { _def?: { typeName?: string } })._def?.typeName;
}

function objectShape(t: z.ZodTypeAny): Record<string, z.ZodTypeAny> | null {
  if (typeNameOf(t) !== 'ZodObject') return null;
  return (t as unknown as { shape: Record<string, z.ZodTypeAny> }).shape;
}

function arrayElementType(t: z.ZodTypeAny): z.ZodTypeAny | null {
  if (typeNameOf(t) !== 'ZodArray') return null;
  return (t as unknown as { _def: { type: z.ZodTypeAny } })._def.type;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Diff `raw`'s keys against `schema`'s shape (top level, plus one level into
 * array-of-object fields). Returns a flat, deterministic list of unknown key
 * paths — e.g. `["files_writen", "results[2].pased"]` — or `[]` when every key
 * the caller sent is accounted for by the schema.
 */
export function findUnknownKeys(schema: z.ZodTypeAny, raw: unknown): string[] {
  if (!isPlainObject(raw)) return [];
  const shape = objectShape(unwrap(schema).core);
  if (!shape) return [];

  const unknown: string[] = [];
  const knownTopKeys = new Set(Object.keys(shape));
  for (const key of Object.keys(raw)) {
    if (!knownTopKeys.has(key)) unknown.push(key);
  }

  for (const [key, fieldSchema] of Object.entries(shape)) {
    const rawField = raw[key];
    if (!Array.isArray(rawField)) continue;
    const elementType = arrayElementType(unwrap(fieldSchema).core);
    if (!elementType) continue;
    const elementShape = objectShape(unwrap(elementType).core);
    if (!elementShape) continue;
    const knownElementKeys = new Set(Object.keys(elementShape));
    rawField.forEach((item, index) => {
      if (!isPlainObject(item)) return;
      for (const itemKey of Object.keys(item)) {
        if (!knownElementKeys.has(itemKey)) unknown.push(`${key}[${index}].${itemKey}`);
      }
    });
  }

  return unknown;
}
