import { z } from 'zod';

// Ported from OpenSpec (MIT) and extended with the four fields the SDD/KB
// workflow needs that OpenSpec lacks: model, handoff, parallel_group, validate.

export const ModelTier = z.enum(['opus', 'sonnet', 'haiku']);
export type ModelTier = z.infer<typeof ModelTier>;

// Declarative structural checks run by `spin validate`.
export const ValidateSpec = z
  .object({
    md_sections: z.array(z.string()).optional(),
    criteria_ids_prefix: z.string().optional(),
    manifest_table: z.boolean().optional(),
  })
  .optional();
export type ValidateSpec = z.infer<typeof ValidateSpec>;

// Artifact definition. `requires` drives the dependency graph (Kahn topo-sort).
export const ArtifactSchema = z.object({
  id: z.string().min(1, 'Artifact ID is required'),
  generates: z.string().min(1, 'generates field is required'),
  description: z.string().default(''),
  template: z.string().optional(),
  instruction: z.string().optional(),
  requires: z.array(z.string()).default([]),
  // --- spin extensions ---
  model: ModelTier.optional(),
  handoff: z.string().optional(),
  parallel_group: z.string().optional(),
  validate: ValidateSpec,
});

// Gates map: lifecycle hook -> gate id (or list of gate ids) to run.
export const GatesMap = z.record(z.string(), z.union([z.string(), z.array(z.string())]));

export const ConfigBlock = z
  .object({
    build_retry_cap: z.number().int().positive().default(3),
    kb_min_test_cases: z.number().int().nonnegative().default(1),
  })
  .partial()
  .optional();

export const SchemaYamlSchema = z.object({
  name: z.string().min(1, 'Schema name is required'),
  version: z.number().int().positive('Version must be a positive integer'),
  description: z.string().optional(),
  artifacts: z.array(ArtifactSchema).min(1, 'At least one artifact required'),
  config: ConfigBlock,
  gates: GatesMap.optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;
export type SchemaYaml = z.infer<typeof SchemaYamlSchema>;

// Runtime state types (not Zod - internal only)
export type CompletedSet = Set<string>;

export interface BlockedArtifacts {
  [artifactId: string]: string[];
}
