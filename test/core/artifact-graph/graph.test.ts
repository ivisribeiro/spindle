import { describe, it, expect } from 'vitest';
import { ArtifactGraph, ArtifactCycleError } from '../../../src/core/artifact-graph/graph.js';
import { parseSchema, SchemaValidationError } from '../../../src/core/artifact-graph/schema.js';
import type { SchemaYaml } from '../../../src/core/artifact-graph/types.js';

const SDD_YAML = `
name: sdd
version: 1
artifacts:
  - id: define
    generates: DEFINE.md
    requires: []
  - id: design
    generates: DESIGN.md
    requires: [define]
  - id: build
    generates: BUILD_REPORT.md
    requires: [design]
  - id: ship
    generates: SHIPPED.md
    requires: [build]
`;

describe('ArtifactGraph (ported OpenSpec spine)', () => {
  it('computes a deterministic Kahn build order', () => {
    const g = ArtifactGraph.fromYamlContent(SDD_YAML);
    expect(g.getBuildOrder()).toEqual(['define', 'design', 'build', 'ship']);
  });

  it('computes the downstream closure (getDownstream) for the iterate cascade', () => {
    const g = ArtifactGraph.fromYamlContent(SDD_YAML);
    expect(g.getDownstream(['design'])).toEqual(['build', 'design', 'ship']);
    expect(g.getDownstream(['ship'])).toEqual(['ship']);
    expect(g.getDownstream(['define'])).toEqual(['build', 'define', 'design', 'ship']);
  });

  it('returns only the ready artifacts given completed set', () => {
    const g = ArtifactGraph.fromYamlContent(SDD_YAML);
    expect(g.getNextArtifacts(new Set())).toEqual(['define']);
    expect(g.getNextArtifacts(new Set(['define']))).toEqual(['design']);
    expect(g.getNextArtifacts(new Set(['define', 'design']))).toEqual(['build']);
  });

  it('reports blocked artifacts with unmet deps', () => {
    const g = ArtifactGraph.fromYamlContent(SDD_YAML);
    const blocked = g.getBlocked(new Set());
    expect(blocked.design).toEqual(['define']);
    expect(blocked.build).toEqual(['design']);
  });

  it('detects completion of the whole graph', () => {
    const g = ArtifactGraph.fromYamlContent(SDD_YAML);
    expect(g.isComplete(new Set(['define', 'design', 'build', 'ship']))).toBe(true);
    expect(g.isComplete(new Set(['define']))).toBe(false);
  });

  it('parallel siblings both appear in the ready wave', () => {
    const g = ArtifactGraph.fromYamlContent(`
name: fan
version: 1
artifacts:
  - id: root
    generates: root.md
    requires: []
  - id: a
    generates: a.md
    requires: [root]
  - id: b
    generates: b.md
    requires: [root]
`);
    expect(g.getNextArtifacts(new Set(['root']))).toEqual(['a', 'b']);
  });

  it('rejects a schema with a dependency cycle', () => {
    expect(() =>
      parseSchema(`
name: cyclic
version: 1
artifacts:
  - id: a
    generates: a.md
    requires: [b]
  - id: b
    generates: b.md
    requires: [a]
`)
    ).toThrow(SchemaValidationError);
  });

  it('rejects a dangling requires reference', () => {
    expect(() =>
      parseSchema(`
name: dangling
version: 1
artifacts:
  - id: a
    generates: a.md
    requires: [ghost]
`)
    ).toThrow(SchemaValidationError);
  });

  it('rejects duplicate artifact ids', () => {
    expect(() =>
      parseSchema(`
name: dup
version: 1
artifacts:
  - id: a
    generates: a.md
  - id: a
    generates: a2.md
`)
    ).toThrow(SchemaValidationError);
  });
});

describe('ArtifactGraph cycle detection (Kahn self-defense)', () => {
  // parseSchema's DFS rejects cycles at YAML load, so a cyclic graph can only be built
  // through fromSchema() (already-parsed SchemaYaml). getBuildOrder must throw a typed
  // error naming the cycle members — never silently return a truncated order.
  const cyclicSchema = (): SchemaYaml =>
    ({
      name: 'cyclic',
      version: 1,
      artifacts: [
        { id: 'root', generates: 'root.md', description: '', requires: [] },
        { id: 'a', generates: 'a.md', description: '', requires: ['b', 'root'] },
        { id: 'b', generates: 'b.md', description: '', requires: ['a'] },
        { id: 'tail', generates: 'tail.md', description: '', requires: ['b'] },
      ],
    }) as SchemaYaml;

  it('getBuildOrder throws ArtifactCycleError instead of returning a truncated order', () => {
    const g = ArtifactGraph.fromSchema(cyclicSchema());
    expect(() => g.getBuildOrder()).toThrow(ArtifactCycleError);
  });

  it('the error names the artifacts stuck on (or downstream of) the cycle', () => {
    const g = ArtifactGraph.fromSchema(cyclicSchema());
    try {
      g.getBuildOrder();
      expect.unreachable('getBuildOrder must throw on a cyclic graph');
    } catch (e) {
      const err = e as ArtifactCycleError;
      expect(err).toBeInstanceOf(ArtifactCycleError);
      // 'root' was emitted; a<->b form the cycle and tail depends on it.
      expect(err.cycle).toEqual(['a', 'b', 'tail']);
      expect(err.message).toContain('Cyclic dependency');
      expect(err.message).toContain('a');
      expect(err.message).toContain('b');
    }
  });

  it('getFinalArtifactId propagates the cycle error (terminal-gate path stays sane)', () => {
    const g = ArtifactGraph.fromSchema(cyclicSchema());
    expect(() => g.getFinalArtifactId()).toThrow(ArtifactCycleError);
  });

  it('an acyclic graph still returns the full order (no false positives)', () => {
    const g = ArtifactGraph.fromYamlContent(SDD_YAML);
    expect(g.getBuildOrder()).toHaveLength(4);
  });
});
