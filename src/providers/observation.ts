import { readFileSync } from 'node:fs'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { ageInMinutes, parseObservation } from '../model/observation.js'
import { defineProvider } from './types.js'

/**
 * Reads an observation captured elsewhere.
 *
 * The counterpart to `driftwood observe`. Where the Terraform provider needs to
 * run beside the state file, this one needs only an artifact — so the repository
 * holding the model can reconcile against what a pipeline saw without holding
 * any infrastructure credentials, and without the cloud account needing to be
 * reachable from it at all.
 *
 * `kind` is taken from the artifact rather than fixed here. The envelope records
 * what each upstream provider was, and flattening a Terraform observation to
 * 'runtime' would invert the merge precedence that makes IaC names win.
 */

export const observationConfigSchema = z.object({
  /** Path to the artifact `driftwood observe` wrote. YAML or JSON. */
  path: z.string(),
  /**
   * Refuse an artifact older than this.
   *
   * The push pattern's real failure mode: a pipeline stops publishing, the
   * consumer keeps reading the last artifact, and every resource deployed since
   * reads as a deletion. Unset means "trust whatever is there", which is fine
   * for a one-off run and wrong for anything on a schedule.
   */
  maxAgeMinutes: z.number().int().positive().optional(),
})

export const observationProvider = defineProvider({
  name: 'observation',
  description: 'An observation captured elsewhere by `driftwood observe` (YAML or JSON)',
  // The artifact may carry declarative sources, runtime sources or both. This
  // label describes the transport, not the facts; per-entity provenance is
  // already on `source` from the merge that produced the artifact.
  kind: 'declarative',
  platforms: ['*'],
  configSchema: observationConfigSchema,
  observe(config, ctx) {
    const path = ctx.resolvePath(config.path)
    const result = parseObservation(parseYaml(readFileSync(path, 'utf8')))
    if (!result.ok || !result.observation) {
      throw new Error(`${path} is not a valid observation:\n${result.issues.map((i) => `  ${i}`).join('\n')}`)
    }

    const observation = result.observation
    const age = ageInMinutes(observation)

    // Throwing rather than returning what we have is deliberate, and matches
    // `observeAll`: a provider that cannot answer must abort the run, because a
    // half-answer reaches the reconciler as mass deletion.
    if (config.maxAgeMinutes !== undefined && age > config.maxAgeMinutes) {
      throw new Error(
        `${path} was observed ${age} minutes ago, older than the ${config.maxAgeMinutes}-minute limit. ` +
          'Reconciling against a stale observation would report everything deployed since as removed. ' +
          'Check that the pipeline publishing it is still running.',
      )
    }
    if (age < 0) {
      throw new Error(
        `${path} is dated ${observation.observedAt}, which is in the future — ` +
          'refusing it rather than treating a clock skew as fact.',
      )
    }

    const origin = Object.entries(observation.origin).map(([k, v]) => `${k}=${v}`)
    ctx.log(`observation: taken ${age} minutes ago${origin.length ? ` (${origin.join(', ')})` : ''}`)

    return observation.model
  },
})
