import { describe, it, expect } from 'vitest';
import { ArtifactGraph } from '../../../src/core/artifact-graph/graph.js';
import { parseSchema } from '../../../src/core/artifact-graph/schema.js';
import {
  gatesBeforeArtifact,
  terminalGates,
  unenforceableHookKeys,
} from '../../../src/core/artifact-graph/gate-hooks.js';

// Unit coverage for the enforceable lifecycle-hook resolution — the logic that turns
// a schema's `gates:` map from prose-only into checkpoints the engine enforces.

const KB_LIKE = `
name: kb
version: 1
gates:
  during: G_KB_STRUCTURE
  before_complete: G_KB_COVERAGE
artifacts:
  - id: manifest
    generates: manifest.json
    requires: []
  - id: concepts
    generates: concept-*.md
    requires: [manifest]
  - id: index
    generates: index.md
    requires: [concepts]
`;

const SDD_LIKE = `
name: sdd
version: 1
gates:
  before_design: G_DEFINE
  before_ship: [G_BUILD, G_SHIP]
artifacts:
  - id: define
    generates: DEFINE.md
    requires: []
  - id: design
    generates: DESIGN.md
    requires: [define]
  - id: ship
    generates: SHIPPED.md
    requires: [design]
`;

describe('gate-hooks: enforceable lifecycle hook resolution', () => {
  it('before_<id> resolves to that artifact prerequisite gate(s)', () => {
    const s = parseSchema(SDD_LIKE);
    expect(gatesBeforeArtifact(s, 'design')).toEqual(['G_DEFINE']);
    expect(gatesBeforeArtifact(s, 'ship')).toEqual(['G_BUILD', 'G_SHIP']);
    expect(gatesBeforeArtifact(s, 'define')).toEqual([]);
  });

  it('during + before_complete both resolve to terminal gates (deduped)', () => {
    expect(terminalGates(parseSchema(KB_LIKE)).sort()).toEqual([
      'G_KB_COVERAGE',
      'G_KB_STRUCTURE',
    ]);
    // sdd declares no terminal hooks
    expect(terminalGates(parseSchema(SDD_LIKE))).toEqual([]);
  });

  it('dedupes when during and before_complete name the same gate', () => {
    const s = parseSchema(`
name: t
version: 1
gates:
  during: G_AUDIT
  before_complete: G_AUDIT
artifacts:
  - id: a
    generates: A.md
    requires: []
`);
    expect(terminalGates(s)).toEqual(['G_AUDIT']);
  });

  it('the graph exposes terminal gates and the final (sink) artifact', () => {
    const kb = ArtifactGraph.fromYamlContent(KB_LIKE);
    expect(kb.getTerminalGates().sort()).toEqual(['G_KB_COVERAGE', 'G_KB_STRUCTURE']);
    expect(kb.getFinalArtifactId()).toBe('index');
    expect(ArtifactGraph.fromYamlContent(SDD_LIKE).getFinalArtifactId()).toBe('ship');
  });

  it('flags unknown hook forms and before_<non-artifact> as unenforceable', () => {
    const bad = parseSchema(`
name: t
version: 1
gates:
  before_design: G_DEFINE
  before_ghost: G_DEFINE
  after_build: G_BUILD
  during: G_AUDIT
  before_complete: G_SHIP
  bogus: G_BUILD
artifacts:
  - id: define
    generates: DEFINE.md
    requires: []
  - id: design
    generates: DESIGN.md
    requires: [define]
`);
    // before_design/during/before_complete are enforceable; the rest are not
    expect(unenforceableHookKeys(bad).sort()).toEqual(['after_build', 'before_ghost', 'bogus']);
  });

  it('accepts a schema whose hook keys are all enforceable', () => {
    expect(unenforceableHookKeys(parseSchema(KB_LIKE))).toEqual([]);
    expect(unenforceableHookKeys(parseSchema(SDD_LIKE))).toEqual([]);
  });
});
