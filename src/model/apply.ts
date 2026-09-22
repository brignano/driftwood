import { isMap, isSeq, parseDocument, YAMLSeq } from 'yaml'
import type { Document } from 'yaml'
import type { Drift } from '../reconcile/index.js'
import type { Edge, Entity } from './schema.js'

/**
 * Writes observed drift back into the committed model.
 *
 * The output's destination is a pull request, which sets every rule here. A
 * reviewer has to be able to read the diff and see only what reality changed —
 * so this edits the YAML document in place rather than re-serializing a parsed
 * `Model`. `dumpModel` would produce a semantically identical file that drops
 * every comment and reflows every block, burying three real changes in a
 * six-hundred-line diff. The comments in `architecture.yaml` sit above exactly
 * the blocks no importer can infer — the views, the ignore list, the aliases,
 * the declared blind spots — and are the reasoning a reviewer needs most.
 *
 * Nothing outside `entities` and `edges` is touched.
 */

export interface ApplySummary {
  entitiesAdded: number
  entitiesRemoved: number
  fieldsChanged: number
  edgesAdded: number
  edgesRemoved: number
  /**
   * Declared facts deliberately left in place because no provider could see
   * them. Reported so the pull request can say why the model still carries
   * something the observation did not return.
   */
  leftUnverified: number
}

const edgeKey = (e: Pick<Edge, 'from' | 'to'>) => `${e.from} ${e.to}`

/**
 * Field order follows the schema, matching what `importTerraformState` emits.
 * A re-import must not reshuffle an entity this writer added, or the next
 * import produces a diff that is pure noise.
 */
function entityFields(e: Entity): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = [
    ['id', e.id],
    ['kind', e.kind],
    ['name', e.name],
    ['group', e.group],
    ['platform', e.platform],
    ['source', e.source],
    ['level', e.level],
    ['tags', e.tags],
  ]
  return pairs.filter(([, v]) => v !== undefined)
}

function edgeFields(e: Edge): Array<[string, unknown]> {
  const pairs: Array<[string, unknown]> = [
    ['from', e.from],
    ['to', e.to],
    ['kind', e.kind],
    ['label', e.label],
  ]
  return pairs.filter(([, v]) => v !== undefined)
}

/** The sequence under `key`, created empty if the model does not have one yet. */
function sequence(doc: Document, key: string): YAMLSeq {
  const existing = doc.get(key)
  if (isSeq(existing)) return existing
  const seq = new YAMLSeq()
  doc.set(key, seq)
  return seq
}

function scalarAt(seq: YAMLSeq, index: number, field: string): string | undefined {
  const item = seq.items[index]
  if (!isMap(item)) return undefined
  const value = item.get(field)
  return typeof value === 'string' ? value : undefined
}

/**
 * Inserts in sorted position rather than appending.
 *
 * `importTerraformState` sorts, so the committed model is sorted, so a sorted
 * insertion puts a new resource next to its neighbours and keeps the diff to
 * the lines that changed. Appending would leave the file in an order no
 * re-import reproduces — and `AGENTS.md` warns that a model the importer would
 * not produce shows up as permanent drift.
 *
 * The comparison must be `localeCompare`, the same one the importer sorts
 * with, because it disagrees with `<` on exactly the characters Terraform
 * addresses are built from: `localeCompare` orders `aws_iam_role_policy.x`
 * before `aws_iam_role.y`, and a raw comparison of code units does the
 * opposite. Sorting one way and inserting the other puts every new entity
 * near, but not at, the position a re-import would give it.
 */
function insertSorted(seq: YAMLSeq, node: unknown, sortKey: string, keyOf: (i: number) => string): void {
  const at = seq.items.findIndex((_, i) => keyOf(i).localeCompare(sortKey) > 0)
  if (at === -1) seq.items.push(node)
  else seq.items.splice(at, 0, node)
}

/**
 * Applies `drift` to the YAML source of the declared model.
 *
 * Only the fields the drift policy compares are written. An entity carries
 * hand-added `tags` or a hand-set `level` that no provider knows about, and a
 * field the policy does not treat as drift is not this writer's to overwrite —
 * the same boundary, enforced on the way out as well as the way in.
 */
export function applyDrift(source: string, drift: Drift): { yaml: string; summary: ApplySummary } {
  const doc = parseDocument(source)

  const entities = sequence(doc, 'entities')
  const entityKey = (i: number) => scalarAt(entities, i, 'id') ?? ''

  const removedIds = new Set(drift.entities.removed.map((e) => e.id))
  if (removedIds.size) {
    entities.items = entities.items.filter((_, i) => !removedIds.has(entityKey(i)))
  }

  for (const change of drift.entities.changed) {
    const index = entities.items.findIndex((_, i) => entityKey(i) === change.id)
    if (index === -1) continue
    const item = entities.items[index]
    if (!isMap(item)) continue
    if (change.observed === undefined) item.delete(change.field)
    else item.set(change.field, change.observed)
  }

  for (const entity of [...drift.entities.added].sort((a, b) => a.id.localeCompare(b.id))) {
    insertSorted(entities, doc.createNode(Object.fromEntries(entityFields(entity))), entity.id, entityKey)
  }

  const edges = sequence(doc, 'edges')
  const edgeKeyAt = (i: number) => `${scalarAt(edges, i, 'from') ?? ''} ${scalarAt(edges, i, 'to') ?? ''}`

  const removedEdges = new Set(drift.edges.removed.map(edgeKey))
  if (removedEdges.size) {
    edges.items = edges.items.filter((_, i) => !removedEdges.has(edgeKeyAt(i)))
  }

  for (const edge of [...drift.edges.added].sort((a, b) => edgeKey(a).localeCompare(edgeKey(b)))) {
    insertSorted(edges, doc.createNode(Object.fromEntries(edgeFields(edge))), edgeKey(edge), edgeKeyAt)
  }

  // `toString` drops the document's trailing newline. Reinstate whatever the
  // source had rather than a normalized single one: imposing a convention the
  // file did not use puts a line in the diff that has nothing to do with
  // infrastructure. A source with no trailing newline still gets one, since
  // that shows up as a "\ No newline at end of file" marker instead.
  const trailing = /\n*$/.exec(source)?.[0] || '\n'
  const yaml = doc.toString({ lineWidth: 0 }).replace(/\n*$/, trailing)

  return {
    yaml,
    summary: {
      entitiesAdded: drift.entities.added.length,
      entitiesRemoved: drift.entities.removed.length,
      fieldsChanged: drift.entities.changed.length,
      edgesAdded: drift.edges.added.length,
      edgesRemoved: drift.edges.removed.length,
      leftUnverified: drift.unverifiable.entities.length + drift.unverifiable.edges.length,
    },
  }
}

/** One line for a pull request body or a CI log. */
export function formatApplySummary(s: ApplySummary): string {
  const parts = [
    `${s.entitiesAdded} added`,
    `${s.entitiesRemoved} removed`,
    `${s.fieldsChanged} field${s.fieldsChanged === 1 ? '' : 's'} updated`,
    `${s.edgesAdded + s.edgesRemoved} edge${s.edgesAdded + s.edgesRemoved === 1 ? '' : 's'} changed`,
  ]
  const line = `Model updated: ${parts.join(', ')}.`
  if (!s.leftUnverified) return line
  return `${line} ${s.leftUnverified} declared fact${s.leftUnverified === 1 ? '' : 's'} left in place — inside a declared blind spot, so absence is unknown, not absent.`
}
