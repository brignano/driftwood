import type { Edge, Entity, Model } from '../model/schema.js'
import { emptyModel } from '../model/schema.js'

/**
 * Terraform state (format v4) as the first provider.
 *
 * Rationale from the brief: it's already a graph, already declarative, and it
 * carries real cloud resource IDs — which sidesteps the identity-resolution
 * problem that kills CMDBs. Entity id is the Terraform address, which is
 * stable across plans and human-readable in a diff.
 */

interface TfInstance {
  attributes?: Record<string, unknown>
  dependencies?: string[]
}

interface TfResource {
  mode?: string
  type?: string
  name?: string
  module?: string
  provider?: string
  instances?: TfInstance[]
}

interface TfState {
  version?: number
  resources?: TfResource[]
}

export interface ImportOptions {
  /** Data sources describe things Terraform reads but doesn't own. */
  includeDataSources?: boolean
  modelName?: string
}

function address(r: TfResource): string {
  const base = `${r.type}.${r.name}`
  return r.module ? `${r.module}.${base}` : base
}

/** `provider["registry.terraform.io/hashicorp/aws"]` -> `aws` */
function providerName(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const m = raw.match(/([^/"\]]+)"?\]?$/)
  return m?.[1]
}

/**
 * Terraform resource types are prefixed by provider (`aws_s3_bucket`), and the
 * segment after that prefix is a good-enough grouping for a first diagram
 * (`s3`, `lambda`, `route53`). Not clever, but stable and predictable.
 */
function groupFor(type: string | undefined): string | undefined {
  if (!type) return undefined
  const parts = type.split('_')
  if (parts.length < 2) return type
  return parts[1]
}

/**
 * Human label. Terraform has no universal "name" attribute, so try the
 * conventional ones in order of specificity before falling back to the
 * resource's local name.
 */
function displayName(r: TfResource, attrs: Record<string, unknown> | undefined): string {
  const candidates = ['name', 'bucket', 'domain_name', 'function_name', 'identifier']
  for (const key of candidates) {
    const v = attrs?.[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  const tags = attrs?.['tags']
  if (tags && typeof tags === 'object' && 'Name' in tags) {
    const n = (tags as Record<string, unknown>)['Name']
    if (typeof n === 'string' && n.length > 0) return n
  }
  return r.name ?? address(r)
}

export function importTerraformState(state: TfState, opts: ImportOptions = {}): Model {
  const model = emptyModel(opts.modelName ?? 'terraform')
  const entities: Entity[] = []
  const edges: Edge[] = []
  const known = new Set<string>()

  const resources = state.resources ?? []
  for (const r of resources) {
    if (!r.type || !r.name) continue
    const isData = r.mode === 'data'
    if (isData && !opts.includeDataSources) continue

    const id = address(r)
    if (known.has(id)) continue
    known.add(id)

    const attrs = r.instances?.[0]?.attributes
    entities.push({
      id,
      kind: r.type,
      name: displayName(r, attrs),
      group: groupFor(r.type),
      platform: providerName(r.provider),
      source: 'terraform',
      level: 'container',
      ...(isData ? { tags: { mode: 'data' } } : {}),
    })
  }

  for (const r of resources) {
    if (!r.type || !r.name) continue
    const from = address(r)
    if (!known.has(from)) continue
    for (const inst of r.instances ?? []) {
      for (const dep of inst.dependencies ?? []) {
        // Dependencies on filtered-out resources (e.g. data sources) would
        // produce dangling edges, which the validator rightly rejects.
        if (!known.has(dep)) continue
        if (dep === from) continue
        if (edges.some((e) => e.from === from && e.to === dep)) continue
        edges.push({ from, to: dep, kind: 'depends-on' })
      }
    }
  }

  model.entities = entities.sort((a, b) => a.id.localeCompare(b.id))
  model.edges = edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))
  return model
}

export function parseTerraformState(source: string): TfState {
  const parsed = JSON.parse(source) as TfState
  if (parsed.version !== undefined && parsed.version !== 4) {
    throw new Error(`unsupported Terraform state version ${parsed.version} (expected 4)`)
  }
  return parsed
}


// ---------------------------------------------------------------------------
// Provider interface binding
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { z } from 'zod'
import { defineProvider } from './types.js'

export const terraformConfigSchema = z.object({
  /** Path to terraform.tfstate, or the output of `terraform show -json`. */
  statePath: z.string(),
  includeDataSources: z.boolean().default(false),
})

/**
 * Terraform is platform-agnostic on purpose: the same provider covers AWS,
 * GCP, Azure, vSphere, and on-prem, because the platform is simply whatever
 * the state file declares. One provider, every target.
 */
export const terraformProvider = defineProvider({
  name: 'terraform',
  description: 'Terraform state (format v4) — any platform Terraform manages',
  kind: 'declarative',
  platforms: ['*'],
  configSchema: terraformConfigSchema,
  observe(config, ctx) {
    const path = ctx.resolvePath(config.statePath)
    const state = parseTerraformState(readFileSync(path, 'utf8'))
    return importTerraformState(state, { includeDataSources: config.includeDataSources })
  },
})
