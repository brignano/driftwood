import { z } from 'zod'

/**
 * The model is the only thing that lives in git. Providers write into it,
 * renderers read from it, and the reconciler diffs it against reality.
 *
 * `kind` is deliberately an open string rather than an enum — any provider
 * must be able to emit its own vocabulary (`aws_s3_bucket`, `service`,
 * `k8s_deployment`) without a schema change. Renderers map known kinds to
 * shapes and fall back gracefully for the rest.
 */

export const Level = z.enum(['context', 'container', 'component'])
export type Level = z.infer<typeof Level>

export const Entity = z.object({
  /** Stable identity. For Terraform this is the resource address. */
  id: z.string().min(1),
  kind: z.string().min(1),
  name: z.string().optional(),
  /** Visual + logical grouping — becomes a subgraph when rendered. */
  group: z.string().optional(),
  /** Where it runs: aws, gcp, azure, onprem, kubernetes. */
  platform: z.string().optional(),
  /** Which provider observed it. Provenance, set by the merge step. */
  source: z.string().optional(),
  level: Level.default('container'),
  /** Free-form metadata. Excluded from drift comparison by default. */
  tags: z.record(z.string()).optional(),
})
export type Entity = z.infer<typeof Entity>

export const Edge = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.string().default('depends-on'),
  label: z.string().optional(),
})
export type Edge = z.infer<typeof Edge>

/**
 * A scoped slice of the model. Flat Mermaid becomes unreadable past roughly
 * 150 nodes, so views exist from v1 rather than being a later optimization.
 * Patterns match an entity's id or group, and support a trailing `*`.
 */
export const View = z.object({
  id: z.string().min(1),
  title: z.string().optional(),
  level: Level.default('container'),
  include: z.array(z.string()).default([]),
  exclude: z.array(z.string()).default([]),
})
export type View = z.infer<typeof View>

/** Intentional divergence, reviewed like code. */
export const Ignore = z.object({
  entities: z.array(z.string()).default([]),
  kinds: z.array(z.string()).default([]),
  edges: z.array(z.object({ from: z.string(), to: z.string() })).default([]),
})
export type Ignore = z.infer<typeof Ignore>

export const Model = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  entities: z.array(Entity).default([]),
  edges: z.array(Edge).default([]),
  views: z.array(View).default([]),
  ignore: Ignore.default({ entities: [], kinds: [], edges: [] }),
  /**
   * Cross-provider identity. Maps a provider's native id to the canonical
   * entity id, so Dynatrace's `SERVICE-A1B2` and Terraform's
   * `aws_lambda_function.forwarder` collapse into one node.
   *
   * This is deliberately manual. Automatic identity resolution across
   * declarative and runtime sources is the hard, unsolved part of this
   * problem, and guessing wrong silently corrupts the graph.
   */
  aliases: z.record(z.string()).default({}),
  /**
   * Declared blind spots. Read-only credentials never see everything, and
   * "unknown" must never be silently reported as "absent".
   */
  coverage: z
    .array(z.object({ scope: z.string(), reason: z.string() }))
    .default([]),
})
export type Model = z.infer<typeof Model>

export function emptyModel(name: string): Model {
  return Model.parse({ version: 1, name })
}
