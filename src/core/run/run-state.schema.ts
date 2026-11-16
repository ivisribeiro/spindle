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

// Opaque, model-REPORTED usage. The CLI RECORDS these numbers (handed in via a
// handoff sidecar); it NEVER computes, tokenizes, or prices them — that would put
// model-awareness in src/ and the guard test forbids it. This is best-effort
// accounting, not enforcement: a missing or wrong number is the model's to answer
// for, not something the deterministic spine can verify.
export const Usage = z.object({
  tier: z.string().optional(), // reported routed tier: 'haiku' | 'sonnet' | 'opus'
  model: z.string().optional(),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
});
export type Usage = z.infer<typeof Usage>;

// The run-ledger: append-only events recording the run's TRAJECTORY, distinct from
// the current-state maps (completed[]/retries{}/gates{}). A build that blocked
// G_BUILD twice then passed leaves three gate events; the gates{} map only holds
// the latest. Written ONLY at the CLI's existing mutation points.
//
// `hash` (optional on every variant) is the tamper-EVIDENT chain link added by
// src/core/run/event-chain.ts's `hashNewEvent`: every event appended from that
// module onward carries it. It is `.optional()` so pre-existing run.json files
// (written before this feature shipped) keep validating — their events simply
// have no `hash` and are treated as a legacy prefix that predates the chain. See
// event-chain.ts for the canonical form and chain-verification semantics, and
// STATUS.md for the honest limit (only events[] is chained; the state maps are
// still plain, forgeable JSON).
export const RunEvent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('complete'),
    at: z.string(),
    id: z.string(),
    usage: Usage.optional(),
    hash: z.string().optional(),
  }),
  z.object({
    kind: z.literal('gate'),
    at: z.string(),
    gate: z.string(),
    passed: z.boolean(),
    reasons: z.array(z.string()).default([]),
    hash: z.string().optional(),
  }),
  z.object({
    kind: z.literal('retry'),
    at: z.string(),
    id: z.string(),
    attempt: z.number().int().nonnegative(),
    hash: z.string().optional(),
  }),
  z.object({ kind: z.literal('approve'), at: z.string(), by: z.string(), hash: z.string().optional() }),
]);
export type RunEvent = z.infer<typeof RunEvent>;

export const ApprovalSnapshot = z.object({
  version: z.literal(1),
  files: z.array(z.object({ path: z.string().min(1), sha256: z.string().regex(/^[0-9a-f]{64}$/) })).min(1),
});
export type ApprovalSnapshot = z.infer<typeof ApprovalSnapshot>;

export const RunStateSchema = z.object({
  version: z.literal(1).default(1),
  schema: z.string(), // active schema name, e.g. "sdd" | "kb"
  feature: z.string(), // active feature slug
  completed: z.array(z.string()).default([]),
  retries: z.record(z.string(), z.number().int().nonnegative()).default({}),
  gates: z.record(z.string(), GateRecord).default({}),
  // Append-only trajectory. `.default([])` keeps pre-ledger run.json files valid.
  events: z.array(RunEvent).default([]),
  // Pre-binding ledgers still load. G_SHIP requires a fresh, snapshot-bound approval.
  approval: z.object({ at: z.string(), by: z.string(), snapshot: ApprovalSnapshot.optional() }).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RunState = z.infer<typeof RunStateSchema>;
