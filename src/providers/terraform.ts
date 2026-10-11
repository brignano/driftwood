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

/**
 * A resource in the "values representation" Terraform's JSON output uses:
 * `terraform show -json` on a state, and a plan's `prior_state` and
 * `planned_values`. One entry per instance, so `count` and `for_each` repeat
 * the resource with an `index`.
 */
export interface TfValuesResource {
  address?: string
  mode?: string
  type?: string
  name?: string
  index?: unknown
  provider_name?: string
  values?: Record<string, unknown>
  depends_on?: string[]
}

export interface TfValuesModule {
  address?: string
  resources?: TfValuesResource[]
  child_modules?: TfValuesModule[]
}

export interface TfValues {
  root_module?: TfValuesModule
}

/** What `terraform show -json` prints for a state. */
interface TfShowJson {
  format_version?: string
  values?: TfValues
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
  const candidates = [
    'name',
    'bucket',
    'domain_name',
    'function_name',
    'identifier',
    'cluster_id',
    'replication_group_id',
    'alarm_name',
    'family',
  ]
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

/**
 * `aws_subnet.private[0]` and `aws_subnet.private["a"]` are one entity,
 * `aws_subnet.private`: the raw state keys instances by resource the same way,
 * and a diagram with one node per `count` index is a diagram of nothing. Only
 * the trailing index goes; `module.zone["eu"].aws_vpc.main` keeps its module
 * key because two module instances really are two things.
 */
export function resourceAddress(address: string): string {
  return address.replace(/\[[^\]]*\]$/, '')
}

/**
 * Converts the values representation into the raw state's shape, so both
 * formats go through one importer and cannot disagree about ids, names or
 * groups.
 */
export function stateFromValues(values: TfValues | undefined): TfState {
  const byAddress = new Map<string, TfResource>()
  const visit = (module: TfValuesModule | undefined) => {
    if (!module) return
    for (const r of module.resources ?? []) {
      if (!r.address || !r.type || !r.name) continue
      const key = resourceAddress(r.address)
      // The module is whatever precedes the resource's own `type.name` in its
      // address, which holds whether or not the module objects are nested.
      const local = `${r.mode === 'data' ? 'data.' : ''}${r.type}.${r.name}`
      const owner = key.endsWith(`.${local}`) ? key.slice(0, -(local.length + 1)) : module.address
      let resource = byAddress.get(key)
      if (!resource) {
        resource = {
          mode: r.mode,
          type: r.type,
          name: r.name,
          module: owner,
          provider: r.provider_name,
          instances: [],
        }
        byAddress.set(key, resource)
      }
      resource.instances?.push({ attributes: r.values, dependencies: r.depends_on })
    }
    for (const child of module.child_modules ?? []) visit(child)
  }
  visit(values?.root_module)
  return { version: 4, resources: [...byAddress.values()] }
}

/**
 * Accepts the raw state file (`terraform state pull`, a backend object) and
 * `terraform show -json`, which documentation and pipelines reach for first.
 * A plan is refused by name: it describes two states at once, and reading
 * either one silently would answer a question nobody asked.
 */
function normalizeState(input: TfState | TfShowJson): TfState {
  if ('resource_changes' in input || 'planned_values' in input) {
    throw new Error(
      'this is a Terraform plan, not a state. Use `driftwood preview --plan <file>` to show what a plan changes.',
    )
  }
  if ('resources' in input) return input as TfState
  if ('values' in input || 'format_version' in input) return stateFromValues((input as TfShowJson).values)
  return input as TfState
}

export function importTerraformState(input: TfState | TfShowJson, opts: ImportOptions = {}): Model {
  const state = normalizeState(input)
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
      for (const raw of inst.dependencies ?? []) {
        const dep = resourceAddress(raw)
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

export function parseTerraformState(source: string): TfState | TfShowJson {
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
