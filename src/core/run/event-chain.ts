import { createHash } from 'node:crypto';
import type { RunEvent } from './run-state.schema.js';

// Tamper-EVIDENT (not tamper-proof) hash chain over run.json's events[].
//
// Every event appended from this module onward carries a `hash`:
//
//   hash = sha256( canonicalize(event WITHOUT its own `hash` field) + prevHash )
//
// where `prevHash` is the `hash` of the immediately preceding HASHED event
// already in events[], or '' (empty string) if there is no such event yet —
// either because this is the very first event ever appended, or because every
// event before it is a pre-existing "legacy" (unhashed) event. In both cases
// the chain simply starts fresh from here; nothing retroactively hashes
// history that predates this feature.
//
// Canonical form (the exact bytes that get hashed): `JSON.stringify` over the
// event object with ALL object keys sorted recursively (depth-first, by
// `Object.keys(...).sort()`), so the same logical event always serializes to
// the same string regardless of property insertion order. Arrays are walked
// but NOT reordered — array order is semantic (e.g. a gate's `reasons[]`).
// `hash` itself is stripped before canonicalizing, since a value can't be an
// input to its own computation.
//
// The honest limit (see STATUS.md): this chain only covers `events[]`. It
// proves the recorded TRAJECTORY hasn't been edited after the fact — it does
// NOT protect the current-state maps (`completed[]`/`gates{}`/`approval`),
// which remain plain JSON and are just as forgeable as before. A hand-edit to
// `run.json` that only touches those maps (and leaves events[] alone) is
// invisible to `spin trace --verify`.

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) sorted[key] = canonicalize(obj[key]);
    return sorted;
  }
  return value;
}

/** Canonical JSON string of an event's own content, excluding `hash`. */
export function canonicalEventContent(event: RunEvent): string {
  const { hash: _hash, ...rest } = event as RunEvent & { hash?: string };
  return JSON.stringify(canonicalize(rest));
}

/** sha256(hex) of the canonical content concatenated with the previous hashed
 *  event's hash (or '' when this starts a new chain). */
export function computeEventHash(event: RunEvent, prevHash: string | null): string {
  const input = canonicalEventContent(event) + (prevHash ?? '');
  return createHash('sha256').update(input).digest('hex');
}

/** The most recently appended HASHED event in `events`, walking from the end,
 *  or null when there is none (brand-new ledger, or an all-legacy ledger). */
function lastHashedEvent(events: readonly RunEvent[]): (RunEvent & { hash: string }) | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as RunEvent & { hash?: string };
    if (e.hash) return e as RunEvent & { hash: string };
  }
  return null;
}

/**
 * Compute the hashed form of a new event about to be appended to `events`.
 * Pure: does not mutate `events`; the caller does `[...events, hashNewEvent(...)]`.
 * This is the ONLY place a new event's `hash` is produced — every CLI mutation
 * point (markComplete/incRetry/recordGate/markApproved in run-state.ts) routes
 * through it via `appendEvent`.
 */
export function hashNewEvent(events: readonly RunEvent[], event: RunEvent): RunEvent {
  const prev = lastHashedEvent(events);
  const hash = computeEventHash(event, prev ? prev.hash : null);
  return { ...event, hash };
}

export interface ChainVerifyOk {
  ok: true;
  verified: number;
  legacy: number;
}
export interface ChainVerifyBroken {
  ok: false;
  verified: number;
  legacy: number;
  brokenAt: number;
  reason: string;
}
export type ChainVerifyResult = ChainVerifyOk | ChainVerifyBroken;

/**
 * Walk events[] in order and verify the hash chain.
 *
 * Unhashed ("legacy") events are only valid as a PREFIX: once a hashed event
 * has been seen, a later event with no hash is itself a break — it means a
 * hash was stripped, or an event was spliced into the trajectory out of band,
 * either of which is exactly what this chain exists to catch.
 */
export function verifyEventChain(events: readonly RunEvent[]): ChainVerifyResult {
  let verified = 0;
  let legacy = 0;
  let prevHash: string | null = null;
  let chainStarted = false;

  for (let i = 0; i < events.length; i++) {
    const e = events[i] as RunEvent & { hash?: string };

    if (!e.hash) {
      if (chainStarted) {
        return {
          ok: false,
          verified,
          legacy,
          brokenAt: i,
          reason: `event at index ${i} (kind "${e.kind}") has no hash, but the chain already started at an earlier index — a hashed event was likely stripped or replaced`,
        };
      }
      legacy++;
      continue;
    }

    const expected = computeEventHash(e, prevHash);
    if (expected !== e.hash) {
      return {
        ok: false,
        verified,
        legacy,
        brokenAt: i,
        reason: `hash mismatch at index ${i} (kind "${e.kind}"): expected ${expected}, found ${e.hash} — the event's content, or an earlier link in the chain, was altered`,
      };
    }

    verified++;
    chainStarted = true;
    prevHash = e.hash;
  }

  return { ok: true, verified, legacy };
}
