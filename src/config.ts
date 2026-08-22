import { dirname, isAbsolute, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { z } from 'zod'
import { providers } from './providers/index.js'
import type { ProviderContext } from './providers/types.js'
import type { Model } from './model/schema.js'
import { mergeModels } from './model/merge.js'
import type { MergeResult, SourcedModel } from './model/merge.js'

/**
 * `driftwood.config.yaml` — the plug-and-play surface.
 *
 * Which providers to observe with and which renderers to emit are both
 * declared here, so adding Dynatrace alongside Terraform, or switching from
 * Mermaid to Graphviz, is a config edit rather than a code change.
 */

export const ProviderUse = z.object({
  use: z.string(),
  /** Optional instance label, so the same provider can appear twice. */
  as: z.string().optional(),
  with: z.record(z.unknown()).default({}),
})

export const RenderTarget = z.object({
  view: z.string().optional(),
  to: z.string(),
  engine: z.string().default('auto'),
  direction: z.enum(['LR', 'TD']).default('LR'),
})

export const Config = z.object({
  model: z.string().default('architecture.yaml'),
  providers: z.array(ProviderUse).default([]),
  render: z.array(RenderTarget).default([]),
})
export type Config = z.infer<typeof Config>

export interface LoadedConfig {
  config: Config
  /** Directory of the config file; all relative paths resolve against it. */
  baseDir: string
}

export function loadConfig(source: string, path: string): LoadedConfig {
  const raw = parseYaml(source)
  const parsed = Config.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
    throw new Error(`invalid config at ${path}:\n${detail}`)
  }
  return { config: parsed.data, baseDir: dirname(resolve(path)) }
}

export function makeContext(baseDir: string, log: (m: string) => void = () => {}): ProviderContext {
  return {
    secret: (name) => process.env[name],
    resolvePath: (p) => (isAbsolute(p) ? p : resolve(baseDir, p)),
    log,
  }
}

/**
 * Runs every configured provider and merges the results.
 *
 * Providers run concurrently because they're independent network/disk reads,
 * but a single provider failing must not silently produce a half-empty model
 * that the reconciler would then report as mass deletion — so any failure
 * aborts the whole observation.
 */
export async function observeAll(
  loaded: LoadedConfig,
  declared: Model,
  log: (m: string) => void = () => {},
): Promise<MergeResult> {
  const ctx = makeContext(loaded.baseDir, log)

  const results = await Promise.all(
    loaded.config.providers.map(async (use): Promise<SourcedModel> => {
      const provider = providers.get(use.use)
      const parsed = provider.configSchema.safeParse(use.with)
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `  ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n')
        throw new Error(`invalid config for provider '${use.use}':\n${detail}`)
      }
      const model = await provider.observe(parsed.data, ctx)
      const label = use.as ?? use.use
      log(`${label}: ${model.entities.length} entities, ${model.edges.length} edges`)
      return { provider: label, kind: provider.kind, model }
    }),
  )

  if (results.length === 0) {
    throw new Error('no providers configured — add at least one entry under `providers:`')
  }

  return mergeModels(results, declared.aliases)
}
