import type { Edge, Entity, Model } from '../model/schema.js'
import { matches } from '../model/validate.js'

/**
 * Declared (the model in git) vs observed (what a provider found).
 *
 * The drift policy is the thing most likely to sink this in practice: report
 * too much and every run becomes noise that gets muted, report too little and
 * the model rots anyway. Default: structural facts count, metadata doesn't.
 * A new tag is not drift. A new resource, a removed edge, or a changed kind is.
 */
export const COMPARED_FIELDS = ['kind', 'name', 'group'] as const
export type ComparedField = (typeof COMPARED_FIELDS)[number]

export interface FieldChange {
  id: string
  field: ComparedField
  declared: string | undefined
  observed: string | undefined
}

export type CoverageGap = Model['coverage'][number]

/**
 * Declared, not observed, and inside a declared blind spot — so its absence
 * from the observation says nothing about its absence in reality. Reported
 * apart from `removed` and deliberately excluded from `hasDrift`.
 */
export interface UnverifiableEntity extends CoverageGap {
  entity: Entity
}

export interface UnverifiableEdge extends CoverageGap {
  edge: Edge
}

export interface Drift {
  entities: { added: Entity[]; removed: Entity[]; changed: FieldChange[] }
  edges: { added: Edge[]; removed: Edge[] }
  unverifiable: { entities: UnverifiableEntity[]; edges: UnverifiableEdge[] }
  ignored: { entities: number; edges: number }
  coverage: CoverageGap[]
  hasDrift: boolean
}

const edgeKey = (e: Edge) => `${e.from} ${e.to}`

function isIgnoredEntity(model: Model, e: Entity): boolean {
  if (model.ignore.kinds.some((k) => matches(k, e.kind))) return true
  return model.ignore.entities.some((p) => matches(p, e.id))
}

function isIgnoredEdge(model: Model, edge: Edge): boolean {
  if (model.ignore.edges.some((i) => matches(i.from, edge.from) && matches(i.to, edge.to))) return true
  // An edge touching an ignored entity is ignored by implication, otherwise
  // ignoring a resource would still surface all of its edges as drift.
  const ignoredId = (id: string) => model.ignore.entities.some((p) => matches(p, id))
  return ignoredId(edge.from) || ignoredId(edge.to)
}

/**
 * The declared blind spot covering an entity, or undefined when the observing
 * providers were genuinely able to see it.
 *
 * A scope matches an entity's id *or* its kind, so a gap can be declared as a
 * class of resource (`aws_secretsmanager_*`, matching the kind) or as a set of
 * addresses (`aws_route53_record.*`, matching the id).
 */
function coverageGapFor(model: Model, e: Entity): CoverageGap | undefined {
  return model.coverage.find((c) => matches(c.scope, e.id) || matches(c.scope, e.kind))
}

/**
 * A provider that cannot see an entity cannot see its relationships either, so
 * an edge inherits the blind spot of either endpoint — the same implication
 * that makes an edge touching an ignored entity ignored.
 */
function edgeCoverageGap(model: Model, byId: Map<string, Entity>, edge: Edge): CoverageGap | undefined {
  for (const id of [edge.from, edge.to]) {
    const entity = byId.get(id)
    const gap = entity
      ? coverageGapFor(model, entity)
      : model.coverage.find((c) => matches(c.scope, id))
    if (gap) return gap
  }
  return undefined
}

export function reconcile(declared: Model, observed: Model): Drift {
  const declaredById = new Map(declared.entities.map((e) => [e.id, e]))
  const observedById = new Map(observed.entities.map((e) => [e.id, e]))

  const added: Entity[] = []
  const removed: Entity[] = []
  const changed: FieldChange[] = []
  const unverifiableEntities: UnverifiableEntity[] = []
  let ignoredEntities = 0

  // Coverage deliberately does not suppress additions. A blind spot means
  // "might not be seen", never "must not be reported" — something appearing
  // inside one is newly visible, and hiding it would lose a real resource.
  for (const [id, obs] of observedById) {
    if (declaredById.has(id)) continue
    if (isIgnoredEntity(declared, obs)) {
      ignoredEntities++
      continue
    }
    added.push(obs)
  }

  for (const [id, dec] of declaredById) {
    if (observedById.has(id)) continue
    if (isIgnoredEntity(declared, dec)) {
      ignoredEntities++
      continue
    }
    // Unknown is not absent. Reporting this as removed would invite a fix
    // that deletes an entity nobody deleted.
    const gap = coverageGapFor(declared, dec)
    if (gap) {
      unverifiableEntities.push({ entity: dec, ...gap })
      continue
    }
    removed.push(dec)
  }

  for (const [id, dec] of declaredById) {
    const obs = observedById.get(id)
    if (!obs) continue
    if (isIgnoredEntity(declared, dec)) continue
    for (const field of COMPARED_FIELDS) {
      if (dec[field] !== obs[field]) {
        changed.push({ id, field, declared: dec[field], observed: obs[field] })
      }
    }
  }

  const declaredEdges = new Map(declared.edges.map((e) => [edgeKey(e), e]))
  const observedEdges = new Map(observed.edges.map((e) => [edgeKey(e), e]))
  const addedEdges: Edge[] = []
  const removedEdges: Edge[] = []
  const unverifiableEdges: UnverifiableEdge[] = []
  let ignoredEdges = 0

  for (const [key, obs] of observedEdges) {
    if (declaredEdges.has(key)) continue
    if (isIgnoredEdge(declared, obs)) {
      ignoredEdges++
      continue
    }
    addedEdges.push(obs)
  }
  for (const [key, dec] of declaredEdges) {
    if (observedEdges.has(key)) continue
    if (isIgnoredEdge(declared, dec)) {
      ignoredEdges++
      continue
    }
    const gap = edgeCoverageGap(declared, declaredById, dec)
    if (gap) {
      unverifiableEdges.push({ edge: dec, ...gap })
      continue
    }
    removedEdges.push(dec)
  }

  const hasDrift =
    added.length > 0 ||
    removed.length > 0 ||
    changed.length > 0 ||
    addedEdges.length > 0 ||
    removedEdges.length > 0

  return {
    entities: { added, removed, changed },
    edges: { added: addedEdges, removed: removedEdges },
    // Not folded into hasDrift: a blind spot must never turn the CI gate red,
    // or every run with read-only credentials fails and the gate gets muted.
    unverifiable: { entities: unverifiableEntities, edges: unverifiableEdges },
    ignored: { entities: ignoredEntities, edges: ignoredEdges },
    coverage: declared.coverage,
    hasDrift,
  }
}

/**
 * The declared-but-unobserved section, emitted whether or not there is drift —
 * "no drift" alongside a dozen entities nobody could look at would be a claim
 * the observation does not support.
 */
function formatUnverifiable(drift: Drift): string[] {
  const { entities, edges } = drift.unverifiable
  if (!entities.length && !edges.length) return []

  const out = [
    `### Declared, but not verifiable (${entities.length + edges.length})`,
    '',
    '_Inside a declared blind spot, so absence from the observation is unknown, not absent. Kept in the model rather than reported as removed._',
    '',
  ]
  if (entities.length) {
    out.push('| Entity | Blind spot | Why |', '|---|---|---|')
    for (const u of entities) {
      out.push(`| \`${u.entity.id}\` | \`${u.scope}\` | ${u.reason} |`)
    }
    out.push('')
  }
  for (const u of edges) {
    out.push(`- \`${u.edge.from}\` -> \`${u.edge.to}\` - within \`${u.scope}\``)
  }
  if (edges.length) out.push('')
  return out
}

/** Markdown, because the output's destination is a pull request body. */
export function formatDrift(drift: Drift): string {
  if (!drift.hasDrift) {
    const parts = ['No drift. The model matches observed infrastructure.']
    if (drift.ignored.entities || drift.ignored.edges) {
      parts.push(`\n_Ignored: ${drift.ignored.entities} entities, ${drift.ignored.edges} edges._`)
    }
    const unverifiable = formatUnverifiable(drift)
    if (unverifiable.length) parts.push('', ...unverifiable)
    return parts.join('\n')
  }

  const out: string[] = ['## Architecture drift detected', '']
  const { added, removed, changed } = drift.entities

  if (added.length) {
    out.push(`### Present in infrastructure, missing from the model (${added.length})`, '')
    for (const e of added) out.push(`- \`${e.id}\` - ${e.kind}${e.name ? ` (${e.name})` : ''}`)
    out.push('')
  }
  if (removed.length) {
    out.push(`### Declared in the model, not found in infrastructure (${removed.length})`, '')
    for (const e of removed) out.push(`- \`${e.id}\` - ${e.kind}${e.name ? ` (${e.name})` : ''}`)
    out.push('')
  }
  if (changed.length) {
    out.push(`### Changed (${changed.length})`, '', '| Entity | Field | Declared | Observed |', '|---|---|---|---|')
    for (const c of changed) {
      out.push(`| \`${c.id}\` | ${c.field} | ${c.declared ?? '-'} | ${c.observed ?? '-'} |`)
    }
    out.push('')
  }
  if (drift.edges.added.length || drift.edges.removed.length) {
    out.push('### Relationships', '')
    for (const e of drift.edges.added) out.push(`- **added** \`${e.from}\` -> \`${e.to}\``)
    for (const e of drift.edges.removed) out.push(`- **removed** \`${e.from}\` -> \`${e.to}\``)
    out.push('')
  }
  out.push(...formatUnverifiable(drift))
  if (drift.ignored.entities || drift.ignored.edges) {
    out.push(`_Ignored by policy: ${drift.ignored.entities} entities, ${drift.ignored.edges} edges._`, '')
  }
  if (drift.coverage.length) {
    out.push(
      '### Known coverage gaps',
      '',
      '_These are declared blind spots - absence here does not mean absence in reality._',
      '',
    )
    for (const c of drift.coverage) out.push(`- \`${c.scope}\` - ${c.reason}`)
    out.push('')
  }
  return out.join('\n')
}
