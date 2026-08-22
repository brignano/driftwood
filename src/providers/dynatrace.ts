import { z } from 'zod'
import type { Edge, Entity, Model } from '../model/schema.js'
import { emptyModel } from '../model/schema.js'
import { defineProvider } from './types.js'

/**
 * Dynatrace Smartscape as a runtime provider.
 *
 * This is the counterpart to Terraform: Terraform says what is *supposed* to
 * exist, Dynatrace says what is *actually running*. Reconciling the two is the
 * point of the tool — a service Terraform declares but Dynatrace has never
 * seen is a very different finding from one neither knows about.
 *
 * Read-only: this hits the Entities API v2 with a token that only needs
 * `entities.read`. Nothing here mutates anything.
 */

export const dynatraceConfigSchema = z.object({
  /** Environment URL, e.g. https://abc12345.live.dynatrace.com */
  url: z.string().url(),
  /** Name of the env var holding the API token. Never the token itself. */
  tokenEnv: z.string().default('DYNATRACE_API_TOKEN'),
  /** Entity selectors to pull. Defaults cover the common topology types. */
  entitySelectors: z
    .array(z.string())
    .default(['type("SERVICE")', 'type("HOST")', 'type("PROCESS_GROUP")']),
  platform: z.string().default('dynatrace'),
  /** Guards against pulling an enormous environment by accident. */
  pageSize: z.number().int().min(1).max(4000).default(500),
})

export type DynatraceConfig = z.infer<typeof dynatraceConfigSchema>

interface DtEntity {
  entityId?: string
  displayName?: string
  type?: string
  fromRelationships?: Record<string, Array<{ id?: string }>>
}

interface DtResponse {
  entities?: DtEntity[]
  nextPageKey?: string | null
}

/** Maps a Dynatrace entity type to a group label. */
function groupFor(type: string | undefined): string | undefined {
  if (!type) return undefined
  return type.toLowerCase().replace(/_/g, '-')
}

export function toModel(entities: DtEntity[], platform: string): Model {
  const model = emptyModel('dynatrace')
  const out: Entity[] = []
  const edges: Edge[] = []
  const known = new Set<string>()

  for (const e of entities) {
    if (!e.entityId) continue
    if (known.has(e.entityId)) continue
    known.add(e.entityId)
    out.push({
      id: e.entityId,
      kind: e.type ?? 'UNKNOWN',
      name: e.displayName ?? e.entityId,
      group: groupFor(e.type),
      platform,
      source: 'dynatrace',
      level: 'container',
    })
  }

  for (const e of entities) {
    if (!e.entityId) continue
    for (const [relation, targets] of Object.entries(e.fromRelationships ?? {})) {
      for (const t of targets ?? []) {
        // Relationships routinely point at entity types outside the selector,
        // which would otherwise produce dangling edges the validator rejects.
        if (!t.id || !known.has(t.id) || t.id === e.entityId) continue
        if (edges.some((x) => x.from === e.entityId && x.to === t.id)) continue
        edges.push({ from: e.entityId, to: t.id, kind: relation })
      }
    }
  }

  model.entities = out.sort((a, b) => a.id.localeCompare(b.id))
  model.edges = edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))
  return model
}

async function fetchAll(config: DynatraceConfig, token: string): Promise<DtEntity[]> {
  const collected: DtEntity[] = []
  for (const selector of config.entitySelectors) {
    let pageKey: string | null | undefined
    do {
      const url = new URL('/api/v2/entities', config.url)
      if (pageKey) {
        url.searchParams.set('nextPageKey', pageKey)
      } else {
        url.searchParams.set('entitySelector', selector)
        url.searchParams.set('pageSize', String(config.pageSize))
        url.searchParams.set('fields', '+fromRelationships')
      }
      const res = await fetch(url, {
        headers: { Authorization: `Api-Token ${token}`, Accept: 'application/json' },
      })
      if (!res.ok) {
        throw new Error(`Dynatrace API ${res.status} ${res.statusText} for selector ${selector}`)
      }
      const body = (await res.json()) as DtResponse
      collected.push(...(body.entities ?? []))
      pageKey = body.nextPageKey
    } while (pageKey)
  }
  return collected
}

export const dynatraceProvider = defineProvider({
  name: 'dynatrace',
  description: 'Dynatrace Smartscape topology (Entities API v2, read-only)',
  kind: 'runtime',
  platforms: ['aws', 'gcp', 'azure', 'onprem', 'kubernetes'],
  configSchema: dynatraceConfigSchema,
  async observe(config, ctx) {
    const token = ctx.secret(config.tokenEnv)
    if (!token) {
      throw new Error(
        `Dynatrace token not found. Set $${config.tokenEnv} to a token with the 'entities.read' scope.`,
      )
    }
    ctx.log(`dynatrace: querying ${config.entitySelectors.length} selector(s)`)
    const entities = await fetchAll(config, token)
    ctx.log(`dynatrace: ${entities.length} entities`)
    return toModel(entities, config.platform)
  },
})
