import * as fs from 'node:fs';
import { HANDOFF_SCHEMAS, isHandoffId, type HandoffId } from './schemas.js';
import { findUnknownKeys } from './unknown-keys.js';

// Validate a worker-output JSON file (or object) against a named handoff schema.

export interface HandoffCheckResult {
  ok: boolean;
  schemaId: string;
  errors: string[];
  data?: unknown;
  // Advisory only (never affects `ok`/exit code): top-level keys in the RAW input
  // that the schema's non-strict `z.object()` silently stripped on parse — e.g. a
  // typo like "files_writen". Omitted (not `[]`) when nothing was dropped. See
  // unknown-keys.ts for the one-level recursion rule.
  unknown_keys?: string[];
}

export function checkHandoffObject(schemaId: string, value: unknown): HandoffCheckResult {
  if (!isHandoffId(schemaId)) {
    return {
      ok: false,
      schemaId,
      errors: [`unknown handoff schema "${schemaId}". Known: ${Object.keys(HANDOFF_SCHEMAS).join(', ')}`],
    };
  }
  const schema = HANDOFF_SCHEMAS[schemaId as HandoffId];
  const result = schema.safeParse(value);
  if (!result.success) {
    return {
      ok: false,
      schemaId,
      errors: result.error.issues.map((e) => `${e.path.join('.') || '(root)'}: ${e.message}`),
    };
  }
  const unknownKeys = findUnknownKeys(schema, value);
  return {
    ok: true,
    schemaId,
    errors: [],
    data: result.data,
    ...(unknownKeys.length > 0 ? { unknown_keys: unknownKeys } : {}),
  };
}

export function checkHandoffFile(schemaId: string, filePath: string): HandoffCheckResult {
  if (!fs.existsSync(filePath)) {
    return { ok: false, schemaId, errors: [`handoff file not found: ${filePath}`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return { ok: false, schemaId, errors: [`handoff file is not valid JSON: ${filePath}`] };
  }
  return checkHandoffObject(schemaId, parsed);
}
