import type { Artifact, SchemaYaml, CompletedSet, BlockedArtifacts } from './types.js';
import { loadSchema, parseSchema } from './schema.js';
import { gatesBeforeArtifact, terminalGates } from './gate-hooks.js';

// Ported verbatim from OpenSpec (MIT). Deterministic Kahn topological sort,
// ready-set and blocked-set queries over the artifact dependency graph.

/** Raised by `getBuildOrder()` when Kahn's algorithm cannot emit every artifact — the
 *  unmistakable signature of a dependency cycle (a node whose in-degree never reaches
 *  zero). `schema.ts`'s `parseSchema` already runs its own DFS cycle check on every
 *  YAML-loaded schema, so this normally never fires on that path — but `ArtifactGraph`
 *  is also constructible via `fromSchema()` from an already-parsed `SchemaYaml` that
 *  skipped that check. `getBuildOrder()` must be self-defending regardless of entry
 *  point: it either returns the full order or throws, and NEVER silently returns a
 *  truncated one. */
export class ArtifactCycleError extends Error {
  /** Artifact ids that never reached zero in-degree — each is on a cycle, or
   *  transitively depends on one. Sorted for determinism. */
  readonly cycle: string[];

  constructor(cycle: string[]) {
    const sorted = [...cycle].sort();
    super(
      `Cyclic dependency detected in artifact graph: ${sorted.join(', ')} form (or depend on) a cycle`
    );
    this.name = 'ArtifactCycleError';
    this.cycle = sorted;
  }
}

export class ArtifactGraph {
  private artifacts: Map<string, Artifact>;
  private schema: SchemaYaml;

  private constructor(schema: SchemaYaml) {
    this.schema = schema;
    this.artifacts = new Map(schema.artifacts.map((a) => [a.id, a]));
  }

  static fromYaml(filePath: string): ArtifactGraph {
    return new ArtifactGraph(loadSchema(filePath));
  }

  static fromYamlContent(yamlContent: string): ArtifactGraph {
    return new ArtifactGraph(parseSchema(yamlContent));
  }

  static fromSchema(schema: SchemaYaml): ArtifactGraph {
    return new ArtifactGraph(schema);
  }

  getArtifact(id: string): Artifact | undefined {
    return this.artifacts.get(id);
  }

  getAllArtifacts(): Artifact[] {
    return Array.from(this.artifacts.values());
  }

  getName(): string {
    return this.schema.name;
  }

  getVersion(): number {
    return this.schema.version;
  }

  getSchema(): SchemaYaml {
    return this.schema;
  }

  /** Computes the topological build order using Kahn's algorithm (sorted for determinism). */
  getBuildOrder(): string[] {
    const inDegree = new Map<string, number>();
    const dependents = new Map<string, string[]>();

    for (const artifact of this.artifacts.values()) {
      inDegree.set(artifact.id, artifact.requires.length);
      dependents.set(artifact.id, []);
    }

    for (const artifact of this.artifacts.values()) {
      for (const req of artifact.requires) {
        dependents.get(req)!.push(artifact.id);
      }
    }

    const queue = [...this.artifacts.keys()]
      .filter((id) => inDegree.get(id) === 0)
      .sort();

    const result: string[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      result.push(current);

      const newlyReady: string[] = [];
      for (const dep of dependents.get(current)!) {
        const newDegree = inDegree.get(dep)! - 1;
        inDegree.set(dep, newDegree);
        if (newDegree === 0) {
          newlyReady.push(dep);
        }
      }
      queue.push(...newlyReady.sort());
    }

    // Kahn's algorithm emits a node only once its in-degree reaches zero. If the queue
    // drains before every artifact is emitted, whatever remains has a non-zero in-degree
    // forever — it is on a cycle, or depends (directly or transitively) on one. Name
    // those artifacts rather than silently handing back a truncated order.
    if (result.length < this.artifacts.size) {
      const emitted = new Set(result);
      const remaining = [...this.artifacts.keys()].filter((id) => !emitted.has(id));
      throw new ArtifactCycleError(remaining);
    }

    return result;
  }

  /** Artifacts whose dependencies are all completed and which are not themselves completed. */
  getNextArtifacts(completed: CompletedSet): string[] {
    const ready: string[] = [];
    for (const artifact of this.artifacts.values()) {
      if (completed.has(artifact.id)) continue;
      if (artifact.requires.every((req) => completed.has(req))) {
        ready.push(artifact.id);
      }
    }
    return ready.sort();
  }

  /** The downstream closure: the given ids plus every artifact that transitively
   *  requires one of them. Used by `spin invalidate` so editing an artifact cascades
   *  re-gating to everything that depends on it. */
  getDownstream(ids: string[]): string[] {
    const target = new Set(ids);
    let changed = true;
    while (changed) {
      changed = false;
      for (const a of this.artifacts.values()) {
        if (target.has(a.id)) continue;
        if (a.requires.some((r) => target.has(r))) {
          target.add(a.id);
          changed = true;
        }
      }
    }
    return [...target].sort();
  }

  /** Gate ids that must be recorded green in the ledger BEFORE this artifact may be
   *  completed, read from the schema's `gates:` lifecycle map (key `before_<id>`).
   *  Empty when the schema declares none. Makes the lifecycle gate map enforceable
   *  instead of prose-only. */
  getRequiredGatesBefore(artifactId: string): string[] {
    return gatesBeforeArtifact(this.schema, artifactId);
  }

  /** Gate ids anchored to the run's TERMINAL checkpoint — the `during` + `before_complete`
   *  hooks. They must be recorded green before the final artifact completes and before the
   *  run may be reported complete. Empty when the schema declares neither. This is what
   *  makes those hooks enforceable instead of prose-only (kb/brownfield used to rely on a
   *  command remembering to call them). */
  getTerminalGates(): string[] {
    return terminalGates(this.schema);
  }

  /** The last artifact in Kahn build order — the run's completion sink. Terminal gates are
   *  enforced against this one's completion. Null only for an empty graph (schema forbids).
   *  Propagates `ArtifactCycleError` (does not catch it) if the graph is cyclic — a
   *  terminal-gate check must never treat a cycle as "no final artifact". */
  getFinalArtifactId(): string | null {
    const order = this.getBuildOrder();
    return order.length > 0 ? order[order.length - 1] : null;
  }

  isComplete(completed: CompletedSet): boolean {
    for (const artifact of this.artifacts.values()) {
      if (!completed.has(artifact.id)) return false;
    }
    return true;
  }

  getBlocked(completed: CompletedSet): BlockedArtifacts {
    const blocked: BlockedArtifacts = {};
    for (const artifact of this.artifacts.values()) {
      if (completed.has(artifact.id)) continue;
      const unmetDeps = artifact.requires.filter((req) => !completed.has(req));
      if (unmetDeps.length > 0) {
        blocked[artifact.id] = unmetDeps.sort();
      }
    }
    return blocked;
  }
}
