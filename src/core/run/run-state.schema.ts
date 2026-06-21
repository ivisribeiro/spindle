import { z } from 'zod';

// The run-state ledger (.spindle/run.json). CLI-written ONLY — never written by a
// model. Gates read this + the filesystem, never conversation memory, so a gate
// verdict survives a mid-session crash and is idempotent on re-run.

export const GateRecord = z.object({
  passed: z.boolean(),
  at: z.string(),
  reasons: z.array(z.string()).default([]),
});
export type GateRecord = z.infer<typeof GateRecord>;

export const RunStateSchema = z.object({
  version: z.literal(1).default(1),
  schema: z.string(), // active schema name, e.g. "sdd" | "kb"
  feature: z.string(), // active feature slug
  completed: z.array(z.string()).default([]),
  retries: z.record(z.string(), z.number().int().nonnegative()).default({}),
  gates: z.record(z.string(), GateRecord).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunState = z.infer<typeof RunStateSchema>;
