import type { Edge, Entity, Model } from './schema.js'
import { emptyModel } from './schema.js'

/**
 * Combining what several providers observed into one model.
 *
 * The genuinely hard part is identity: Terraform calls it
 * `aws_lambda_function.forwarder`, Dynatrace calls it `SERVICE-A1B2`, and
 * nothing in either payload proves they're the same thing. This module does
 * NOT guess. It applies the explicit `aliases` map from the committed model
 * and otherwise keeps ids separate — a duplicated node is a visible, fixable
 * problem, whereas a wrongly merged node silently corrupts the graph.
 */

export interface SourcedModel {
  provider: string
  kind: 'declarative' | 'runtime'
  model: Model
}

export interface MergeConflict {
  id: string
  field: 'kind' | 'name' | 'group' | 'platform'
  values: Array<{ provider: string; value: string | undefined }>
  /** The value that won, and why. */
  resolved: string | undefined
}

export interface MergeResult {
  model: Model
  conflicts: MergeConflict[]
}

const CONFLICT_FIELDS = ['kind', 'name', 'group', 'platform'] as const

/**
 * Declarative sources describe intent and own naming and grouping; runtime
 * sources describe what's actually live. When both saw the same entity, the
 * declarative value wins on these descriptive fields — a monitoring agent's
 * display name is usually noisier than the IaC resource name.
 */
function preferred(
  candidates: Array<{ provider: string; kind: 'declarative' | 'runtime'; value: string | undefined }>,
): string | undefined {
  const withValue = candidates.filter((c) => c.value !== undefined)
  if (withValue.length === 0) return undefined
  return (withValue.find((c) => c.kind === 'declarative') ?? withValue[0])!.value
}

export function mergeModels(sources: SourcedModel[], aliases: Record<string, string> = {}): MergeResult {
  const resolveId = (id: string) => aliases[id] ?? id

  const byId = new Map<string, Array<{ provider: string; kind: SourcedModel['kind']; entity: Entity }>>()
  for (const src of sources) {
    for (const entity of src.model.entities) {
      const id = resolveId(entity.id)
      const list = byId.get(id) ?? []
      list.push({ provider: src.provider, kind: src.kind, entity })
      byId.set(id, list)
    }
  }

  const entities: Entity[] = []
  const conflicts: MergeConflict[] = []

  for (const [id, observations] of byId) {
    const first = observations[0]!.entity
    const merged: Entity = { ...first, id, level: first.level }

    for (const field of CONFLICT_FIELDS) {
      const candidates = observations.map((o) => ({
        provider: o.provider,
        kind: o.kind,
        value: o.entity[field],
      }))
      const distinct = [...new Set(candidates.map((c) => c.value).filter((v) => v !== undefined))]
      const winner = preferred(candidates)
      if (field === 'kind') {
        merged.kind = winner ?? first.kind
      } else {
        merged[field] = winner
      }
      if (distinct.length > 1) {
        conflicts.push({
          id,
          field,
          values: candidates.map((c) => ({ provider: c.provider, value: c.value })),
          resolved: winner,
        })
      }
    }

    // Provenance: every provider that saw this entity, so a drift report can
    // say "Terraform knows about it, Dynatrace has never seen it run".
    merged.source = [...new Set(observations.map((o) => o.provider))].sort().join('+')

    const tags: Record<string, string> = {}
    for (const o of observations) Object.assign(tags, o.entity.tags ?? {})
    if (Object.keys(tags).length > 0) merged.tags = tags

    entities.push(merged)
  }

  const known = new Set(entities.map((e) => e.id))
  const edgeMap = new Map<string, Edge>()
  for (const src of sources) {
    for (const edge of src.model.edges) {
      const from = resolveId(edge.from)
      const to = resolveId(edge.to)
      // Aliasing can collapse two ids into one and turn an edge into a loop.
      if (from === to) continue
      if (!known.has(from) || !known.has(to)) continue
      const key = `${from} ${to}`
      if (!edgeMap.has(key)) edgeMap.set(key, { ...edge, from, to })
    }
  }

  const model = emptyModel(sources[0]?.model.name ?? 'merged')
  model.entities = entities.sort((a, b) => a.id.localeCompare(b.id))
  model.edges = [...edgeMap.values()].sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))
  model.aliases = aliases
  return { model, conflicts }
}

export function formatConflicts(conflicts: MergeConflict[]): string {
  if (conflicts.length === 0) return ''
  const out = [`### Provider disagreements (${conflicts.length})`, '', '| Entity | Field | Values | Resolved |', '|---|---|---|---|']
  for (const c of conflicts) {
    const values = c.values.map((v) => `${v.provider}=${v.value ?? '-'}`).join(', ')
    out.push(`| \`${c.id}\` | ${c.field} | ${values} | ${c.resolved ?? '-'} |`)
  }
  out.push('')
  return out.join('\n')
}
