import type { Edge, Entity, Model } from '../model/schema.js'
import { matches } from '../model/validate.js'
import { formatModules, modulePath, moduleOf, parseAddress } from '../model/terraform-address.js'
import type { HealthStatus } from '../health.js'
import { selectEntities } from './select.js'
import type { ChangeMark, EdgeMark, GroupBy, RenderContext } from './types.js'

/**
 * Scoping, grouping and collapsing, done once before any renderer draws, so
 * every engine draws the same nodes in the same boxes.
 *
 * Grouping by module and collapsing modules exist for estates built from
 * modules nobody in the room can change: an ECS wrapper module with fifteen
 * resources is one thing to the team that calls it, and fifteen boxes sorted
 * by resource type is not how they think about it. Both are render-time only.
 * `group` stays a compared field holding what the importer put there, so
 * switching a picture to modules never shows up as drift.
 *
 * Modules are read from Terraform addresses, which is what a Terraform
 * entity's id is. Ids from any other provider contain no `module.` path and
 * are left alone, so a merged model keeps its runtime entities where they were.
 */

export interface Arranged {
  /** Only the entities and edges to draw, already grouped; `views` is empty. */
  model: Model
  /** The context to draw it with: no view, and overlays keyed by the ids drawn. */
  ctx: RenderContext
  /** Each collapsed module's node id, and the entity ids it stands for. */
  members: Record<string, string[]>
}

const HEALTH_RANK: Record<HealthStatus, number> = { healthy: 0, degraded: 1, down: 2 }

export function arrange(model: Model, ctx: RenderContext = {}): Arranged {
  const view = ctx.view ? model.views.find((v) => v.id === ctx.view) : undefined
  if (ctx.view && !view) {
    throw new Error(`unknown view: ${ctx.view} (have: ${model.views.map((v) => v.id).join(', ') || 'none'})`)
  }
  const groupBy: GroupBy = view?.groupBy ?? ctx.groupBy ?? 'group'
  const collapse = view?.collapse ?? ctx.collapse ?? []

  const selected = selectEntities(model, view)
  const visible = new Set(selected.map((e) => e.id))
  const edges = model.edges.filter((e) => visible.has(e.from) && visible.has(e.to))
  const base: RenderContext = { ...ctx, view: undefined, groupBy: 'group', collapse: [] }

  if (groupBy === 'group' && collapse.length === 0) {
    return { model: { ...model, entities: selected, edges, views: [] }, ctx: base, members: {} }
  }

  // The outermost module a pattern names. `*` collapses every top-level
  // module; `module.svc` names every instance of a counted module, and
  // `module.svc["api"]` just the one.
  const ownerOf = (id: string): string | undefined => {
    if (!collapse.length) return undefined
    return modulePath(id).find((m) => {
      const unkeyed = parseAddress(m).modules.map((s) => `module.${s.name}`).join('.')
      return collapse.some((p) => matches(p, m) || matches(p, unkeyed))
    })
  }

  const owner = new Map<string, string>()
  const members = new Map<string, Entity[]>()
  const entities: Entity[] = []
  for (const e of selected) {
    const m = ownerOf(e.id)
    if (m) {
      owner.set(e.id, m)
      members.set(m, [...(members.get(m) ?? []), e])
    } else {
      entities.push(groupBy === 'module' ? { ...e, group: moduleOf(e.id) } : e)
    }
  }
  for (const [id, list] of members) {
    const steps = parseAddress(id).modules
    const groups = new Set(list.map((e) => e.group))
    const [only] = groups
    entities.push({
      id,
      // The name a module call is known by: `ecs_service`, `svc["api"]`, or
      // `platform.ecs_service` when nested.
      name: steps.map((s) => `${s.name}${s.key ?? ''}`).join('.'),
      // `kind` is the muted second line in every renderer, so it carries the
      // count. This entity only exists inside a picture; it is never stored.
      kind: `module · ${list.length} ${list.length === 1 ? 'resource' : 'resources'}`,
      // Boxed by the module that called it, or not at all from the root.
      group: groupBy === 'module' ? formatModules(steps.slice(0, -1)) || undefined : groups.size === 1 ? only : undefined,
      level: 'container',
    })
  }
  entities.sort((a, b) => a.id.localeCompare(b.id))

  const drawn = (id: string) => owner.get(id) ?? id
  const merged = new Map<string, { edge: Edge; marks: Array<EdgeMark['mark'] | undefined> }>()
  const edgeMarks = new Map((ctx.edgeMarks ?? []).map((m) => [`${m.from}\u0000${m.to}`, m.mark]))
  for (const e of edges) {
    const from = drawn(e.from)
    const to = drawn(e.to)
    if (from === to) continue
    const key = `${from}\u0000${to}`
    const mark = edgeMarks.get(`${e.from}\u0000${e.to}`)
    const existing = merged.get(key)
    if (existing) existing.marks.push(mark)
    else merged.set(key, { edge: { ...e, from, to }, marks: [mark] })
  }
  // A relationship between two modules is new, or going away, only if every
  // relationship it stands for is; otherwise it was there before and stays.
  const remappedEdgeMarks: EdgeMark[] = []
  for (const { edge, marks } of merged.values()) {
    const [first] = marks
    if (first && marks.every((m) => m === first)) remappedEdgeMarks.push({ from: edge.from, to: edge.to, mark: first })
  }

  let health = ctx.health
  if (health && owner.size) {
    health = { ...health }
    for (const [id, list] of members) {
      // The worst state inside a module is the module's state: one task down
      // is what someone looking at the collapsed box needs to know.
      let worst: HealthStatus | undefined
      for (const e of list) {
        const h = ctx.health?.[e.id]
        if (h && (worst === undefined || HEALTH_RANK[h] > HEALTH_RANK[worst])) worst = h
      }
      if (worst) health[id] = worst
    }
  }

  let marks = ctx.marks
  if (marks && owner.size) {
    marks = { ...marks }
    for (const [id, list] of members) {
      const inside = list.map((e) => ctx.marks?.[e.id])
      const changed = inside.filter((m): m is ChangeMark => m !== undefined)
      if (!changed.length) continue
      // Created or destroyed as a whole reads as such. Anything less is a
      // module being changed, and a replace inside it is still called out,
      // because a replace is the change that loses data.
      if (changed.length === inside.length && changed.every((m) => m === changed[0])) marks[id] = changed[0]!
      else marks[id] = changed.includes('replace') ? 'replace' : 'update'
    }
  }

  return {
    model: {
      ...model,
      entities,
      edges: [...merged.values()].map((m) => m.edge),
      views: [],
    },
    ctx: { ...base, health, marks, edgeMarks: ctx.edgeMarks ? remappedEdgeMarks : undefined },
    members: Object.fromEntries([...members].map(([id, list]) => [id, list.map((e) => e.id).sort()])),
  }
}
