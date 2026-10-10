import { stringify as stringifyYaml } from 'yaml'
import { z } from 'zod'
import { Model } from './schema.js'
import type { SourcedModel } from './merge.js'

/**
 * An observation, captured somewhere and consumed somewhere else.
 *
 * This exists because the machine that deploys infrastructure is usually not
 * the machine that holds the architecture model. A pipeline (Harness, Jenkins,
 * a Terraform Cloud run) already has the state and already has credentials, so
 * the cheapest integration is for it to emit what it saw and hand that to the
 * repository where the model lives — which then needs no infrastructure
 * credentials at all.
 *
 * It is an envelope around a `Model` rather than a bare model, for one reason:
 * **staleness**. A bare model carries no indication of when it was true. Read a
 * week-old artifact and the reconciler cannot distinguish it from reality, so
 * every resource deployed since looks like a deletion — the exact failure the
 * coverage rule exists to prevent, arriving by a different route. `observedAt`
 * is what lets a consumer refuse rather than guess.
 */

export const ObservationSource = z.object({
  provider: z.string(),
  kind: z.enum(['declarative', 'runtime']),
  entities: z.number().int().nonnegative(),
  edges: z.number().int().nonnegative(),
})
export type ObservationSource = z.infer<typeof ObservationSource>

export const Observation = z.object({
  /** Envelope format version, independent of the model's own `version`. */
  observation: z.literal(1),
  /** When the providers ran, ISO 8601. A consumer's only defence against a stale artifact. */
  observedAt: z.string().datetime(),
  /**
   * Free-form provenance — which workspace, which commit, which pipeline run.
   * Deliberately untyped: every CI system names these differently, and a
   * reviewer reading a drift pull request needs to know where the facts came
   * from more than they need a schema for it.
   */
  origin: z.record(z.string()).default({}),
  /** What each provider contributed, so a thin observation is visible as thin. */
  sources: z.array(ObservationSource).default([]),
  model: Model,
})
export type Observation = z.infer<typeof Observation>

/**
 * Provider disagreements are deliberately not carried in the envelope. They are
 * a report about the observing run, printed where that run can be read, and
 * putting them here would mean a second hand-written copy of `MergeConflict`'s
 * shape — which the conventions forbid, since Zod schemas are the source of
 * truth for types.
 */
export function toObservation(
  model: Model,
  sources: SourcedModel[],
  origin: Record<string, string> = {},
  now: Date = new Date(),
): Observation {
  return Observation.parse({
    observation: 1,
    observedAt: now.toISOString(),
    origin,
    sources: sources.map((s) => ({
      provider: s.provider,
      kind: s.kind,
      entities: s.model.entities.length,
      edges: s.model.edges.length,
    })),
    model,
  })
}

export interface ObservationResult {
  ok: boolean
  observation?: Observation
  issues: string[]
}

export function parseObservation(raw: unknown): ObservationResult {
  const parsed = Observation.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  return { ok: true, observation: parsed.data, issues: [] }
}

/**
 * YAML by default, JSON on request. Both parse back through `parseObservation`,
 * since YAML is a superset of JSON — so a pipeline can emit whichever its
 * artifact store handles better without the consumer caring.
 */
export function dumpObservation(observation: Observation, format: 'yaml' | 'json' = 'yaml'): string {
  if (format === 'json') return `${JSON.stringify(observation, null, 2)}\n`
  return stringifyYaml(observation, { lineWidth: 0 })
}

/** Whole minutes since the observation was taken. Negative when it is in the future. */
export function ageInMinutes(observation: Observation, now: Date = new Date()): number {
  return Math.floor((now.getTime() - Date.parse(observation.observedAt)) / 60_000)
}

/** One line for a CI log or a pull request body. */
export function formatObservation(observation: Observation, now: Date = new Date()): string {
  const parts = observation.sources.map((s) => `${s.provider} (${s.entities}/${s.edges})`)
  const origin = Object.entries(observation.origin).map(([k, v]) => `${k}=${v}`)
  const line = [
    `Observed ${observation.model.entities.length} entities, ${observation.model.edges.length} edges`,
    `${ageInMinutes(observation, now)} minutes ago`,
    parts.length ? `via ${parts.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return origin.length ? `${line}\n${origin.join(' · ')}` : line
}
