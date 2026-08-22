import type { ZodTypeAny, z } from 'zod'
import type { Model } from '../model/schema.js'

/**
 * Where a provider gets its facts. This drives how conflicts are resolved when
 * two providers describe the same entity: declarative sources describe intent,
 * runtime sources describe what is actually running, and runtime wins on
 * liveness while declarative wins on ownership and naming.
 */
export type ProviderKind = 'declarative' | 'runtime'

export interface ProviderContext {
  /** Resolves a secret by name. Never read process.env directly in a provider. */
  secret(name: string): string | undefined
  /** Resolves a path relative to the config file's directory. */
  resolvePath(p: string): string
  log(message: string): void
}

/**
 * The provider extension point.
 *
 * A provider observes some system and returns a `Model`. It never reads the
 * committed model, never writes files, and never mutates infrastructure — it
 * answers one question: "what is actually out there right now?"
 *
 * `configSchema` is a Zod schema so a config file can be validated with a
 * useful error message before any network call is attempted.
 */
export interface Provider<S extends ZodTypeAny = ZodTypeAny> {
  name: string
  description: string
  kind: ProviderKind
  /**
   * Platforms this provider can describe: 'aws', 'gcp', 'azure', 'onprem',
   * 'kubernetes', or '*' when it is platform-agnostic (Terraform is, because
   * the platform is whatever the state file happens to contain).
   */
  platforms: string[]
  configSchema: S
  observe(config: z.infer<S>, ctx: ProviderContext): Promise<Model> | Model
}

/** Helper that preserves the config type through registration. */
export function defineProvider<S extends ZodTypeAny>(p: Provider<S>): Provider<S> {
  return p
}
