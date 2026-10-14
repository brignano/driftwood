import { z } from 'zod'
import { Edge } from './model/schema.js'
import type { Entity, Model } from './model/schema.js'
import { matches } from './model/validate.js'
import { AddressIndex, configAddress } from './model/terraform-address.js'
import { importTerraformState, resourceAddress, stateFromValues } from './providers/terraform.js'
import type { TfValues } from './providers/terraform.js'
import { reconcile } from './reconcile/index.js'
import { renderMermaid } from './render/mermaid.js'
import type { ChangeMark, GroupBy } from './render/types.js'
import { SnapshotDrift, driftFrom } from './snapshot.js'

/**
 * A plan preview: what a Terraform plan will do to the architecture, drawn
 * for the pull request that proposes it.
 *
 * A snapshot answers "what did this deploy do" after the fact. The preview
 * answers the same question while it can still be changed, for the reviewer
 * deciding whether to approve. It reads the plan's own JSON and nothing else:
 * no credentials, no network, and no apply. The plan already holds the state
 * before (`prior_state`), the state after (`planned_values`) and what
 * Terraform intends to do to each resource (`resource_changes`).
 *
 * Like a snapshot it reports and never gates. A plan that moves away from the
 * committed design is worth saying so on the pull request; whether that blocks
 * the merge is the repository's decision, and `reconcile` is the gate.
 */

/** The subset of `terraform show -json <planfile>` the preview reads. */
export interface TfPlan {
  format_version?: string
  prior_state?: { values?: TfValues }
  planned_values?: TfValues
  resource_changes?: TfResourceChange[]
  configuration?: { root_module?: TfConfigModule }
}

export interface TfResourceChange {
  address?: string
  mode?: string
  change?: { actions?: string[] }
}

interface TfConfigResource {
  mode?: string
  type?: string
  name?: string
  expressions?: unknown
  depends_on?: string[]
}

interface TfConfigModuleCall {
  /** The call's arguments, which are the called module's `var.`s. */
  expressions?: Record<string, unknown>
  module?: TfConfigModule
}

interface TfConfigModule {
  resources?: TfConfigResource[]
  module_calls?: Record<string, TfConfigModuleCall>
  outputs?: Record<string, { expression?: unknown }>
}

export const PlanChanges = z.object({
  create: z.array(z.string()),
  update: z.array(z.string()),
  replace: z.array(z.string()),
  destroy: z.array(z.string()),
  edges: z.object({ added: z.array(Edge), removed: z.array(Edge) }),
})
export type PlanChanges = z.infer<typeof PlanChanges>

/**
 * The plan against the committed model. Only what this plan causes is listed
 * by name: drift that was already there is not the reviewer's to fix in this
 * pull request, so it is counted, not itemised.
 */
export const PlanDesign = z.object({
  /** Created by this plan, and not in the model. */
  createdNotDeclared: z.array(z.string()),
  /** In the model, and destroyed by this plan. */
  destroyedButDeclared: z.array(z.string()),
  /** The distance from the model before this plan, which the pull request did not cause. */
  beforePlan: SnapshotDrift,
  /** The whole distance from the model once the plan is applied. */
  afterApply: SnapshotDrift,
})
export type PlanDesign = z.infer<typeof PlanDesign>

export const PlanPreview = z.object({
  preview: z.literal(1),
  title: z.string(),
  changes: PlanChanges,
  design: PlanDesign.optional(),
})
export type PlanPreview = z.infer<typeof PlanPreview>

export interface PreviewOptions {
  /** The committed model, to say whether the plan moves toward it or away. */
  declared?: Model
  includeDataSources?: boolean
  /** Names the preview, usually the workspace or root module. */
  title?: string
  /** Box the diagram's nodes by Terraform module rather than by `group`. */
  groupBy?: GroupBy
  /** Modules to draw as one node each; see `View.collapse`. */
  collapse?: string[]
}

export interface PreviewResult {
  preview: PlanPreview
  /** Markdown for a pull request comment, starting with {@link PREVIEW_MARKER}. */
  comment: string
  /** The Mermaid source drawn in the comment, when anything changed. */
  diagram?: string
}

/**
 * The first line of every comment, so a workflow can find its earlier comment
 * and edit it rather than adding one per push.
 */
export const PREVIEW_MARKER = '<!-- driftwood:plan-preview -->'
export const COMMENT_FILE = 'comment.md'
export const PREVIEW_FILE = 'preview.json'

/** Past this many nodes a diagram in a comment stops being read. */
const MAX_DIAGRAM_NODES = 40

export function parseTerraformPlan(source: string): TfPlan {
  const parsed = JSON.parse(source) as TfPlan
  if (!parsed || typeof parsed !== 'object' || !('resource_changes' in parsed || 'planned_values' in parsed)) {
    throw new Error(
      'not a Terraform plan. Save one with `terraform plan -out=tfplan`, then pass the output of `terraform show -json tfplan`.',
    )
  }
  const major = parsed.format_version?.split('.')[0]
  if (major !== undefined && major !== '1') {
    throw new Error(`unsupported plan format_version ${parsed.format_version} (expected 1.x)`)
  }
  return parsed
}

/**
 * One verb per entity, from the verbs Terraform reports per instance. A
 * resource whose `count` grows is still one entity, and it is being updated,
 * not created. Replace wins over update because it is the one that loses data.
 */
function actionsByEntity(plan: TfPlan, includeDataSources: boolean): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  for (const rc of plan.resource_changes ?? []) {
    if (!rc.address) continue
    if (rc.mode === 'data' && !includeDataSources) continue
    const actions = rc.change?.actions ?? []
    const verb =
      actions.includes('create') && actions.includes('delete')
        ? 'replace'
        : // `forget` (a `removed` block) stops managing a resource without
          // destroying it, so it is not a change to what exists.
          actions.find((a) => a === 'create' || a === 'delete' || a === 'update')
    if (!verb) continue
    const id = entityId(rc.address)
    const set = out.get(id) ?? new Set<string>()
    set.add(verb)
    out.set(id, set)
  }
  return out
}

/** Values-representation addresses carry `data.` for data sources; entity ids do not. */
function entityId(address: string): string {
  // Only the `data.` right before `type.name`: a module may itself be called `data`.
  return resourceAddress(address).replace(/^((?:module\.[^.]+\.)*)data\.([^.]+\.[^.]+)$/, '$1$2')
}

/** Every `references` array anywhere in a resource's expressions, nested blocks included. */
function collectReferences(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectReferences(item, into)
    return
  }
  if (!node || typeof node !== 'object') return
  for (const [key, value] of Object.entries(node)) {
    if (key === 'references' && Array.isArray(value)) {
      for (const ref of value) if (typeof ref === 'string') into.push(ref)
    } else {
      collectReferences(value, into)
    }
  }
}

/**
 * Where a reference is read: the module it is written in, the address prefix
 * of that module, and how its `var.`s resolve, which is through the arguments
 * of the call that instantiated it.
 */
interface Scope {
  module: TfConfigModule
  prefix: string
  vars?: (name: string, depth: number) => string[]
}

const MODULE_REF = /^module\.([A-Za-z_][A-Za-z0-9_-]*)(\[(?:"(?:[^"\\]|\\.)*"|[0-9]+)\])?(?:\.([A-Za-z_][A-Za-z0-9_-]*))?/

// Outputs feeding outputs feeding arguments cannot loop in a valid
// configuration, but a plan is input, and input does not get to hang the tool.
const MAX_DEPTH = 32

function referencesIn(node: unknown): string[] {
  const refs: string[] = []
  collectReferences(node, refs)
  return refs
}

/**
 * The resources a reference reaches, as addresses that may leave module keys
 * out (an `AddressIndex` resolves them). `aws_sqs_queue.orders.arn` and
 * `data.aws_iam_policy_document.p.json` name the resources
 * `aws_sqs_queue.orders` and `aws_iam_policy_document.p`. A module output,
 * `module.svc["api"].service_arn`, names whatever that output reads inside
 * that instance of the module, and `var.vpc_id` inside a module names
 * whatever its caller passed in. Without following those two, every arrow
 * across a module boundary is lost, and an ECS service built by a wrapper
 * module depends on nothing. `local.`, `each.`, `count.` and the rest name no
 * resource and resolve to nothing.
 */
function resolveReference(ref: string, scope: Scope, depth: number): string[] {
  if (depth > MAX_DEPTH) return []
  if (ref.startsWith('var.')) return scope.vars?.(ref.split('.')[1] ?? '', depth + 1) ?? []
  const call = MODULE_REF.exec(ref)
  if (call) {
    const [, name, key = '', output] = call
    const target = scope.module.module_calls?.[name!]
    if (!target?.module) return []
    const child: Scope = {
      module: target.module,
      prefix: `${scope.prefix}module.${name}${key}.`,
      vars: (v, d) => referencesIn(target.expressions?.[v]).flatMap((r) => resolveReference(r, scope, d + 1)),
    }
    // `module.svc` alone, say inside `values(module.svc)`, reads every output.
    const outputs = output ? [output] : Object.keys(target.module.outputs ?? {})
    return outputs.flatMap((o) =>
      referencesIn(target.module?.outputs?.[o]?.expression).flatMap((r) => resolveReference(r, child, depth + 1)),
    )
  }
  const parts = ref.split('.')
  if (parts[0] === 'data') parts.shift()
  const [type, name] = parts
  if (!type || !name || ['local', 'each', 'count', 'path', 'terraform', 'self'].includes(type)) return []
  return [scope.prefix + resourceAddress(`${type}.${name}`)]
}

/**
 * Terraform lists a module output reference twice, `module.svc["api"].arn`
 * and `module.svc["api"]`. The bare one would read every output of the
 * module, so it counts only when nothing more specific came with it.
 */
function withoutRedundantModuleRefs(refs: string[]): string[] {
  return refs.filter((ref) => {
    const m = MODULE_REF.exec(ref)
    if (!m || m[3] !== undefined) return true
    return !refs.some((other) => other !== ref && other.startsWith(`${ref}.`))
  })
}

/**
 * Dependencies as the configuration in the plan states them: what each
 * resource will depend on once applied, keyed by configuration address (no
 * module keys), because one resource block in a counted module is several
 * resources. State only knows what it depended on at the last apply, which is
 * stale for exactly the resources a plan touches.
 */
function configuredDependencies(plan: TfPlan): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()
  const visit = (scope: Scope) => {
    for (const r of scope.module.resources ?? []) {
      if (!r.type || !r.name) continue
      const from = `${scope.prefix}${r.type}.${r.name}`
      const refs = withoutRedundantModuleRefs([...referencesIn(r.expressions), ...(r.depends_on ?? [])])
      const deps = out.get(from) ?? new Set<string>()
      for (const ref of refs) {
        for (const to of resolveReference(ref, scope, 0)) if (to !== from) deps.add(to)
      }
      out.set(from, deps)
    }
    for (const [name, call] of Object.entries(scope.module.module_calls ?? {})) {
      if (!call.module) continue
      visit({
        module: call.module,
        prefix: `${scope.prefix}module.${name}.`,
        vars: (v, d) => referencesIn(call.expressions?.[v]).flatMap((r) => resolveReference(r, scope, d + 1)),
      })
    }
  }
  const root = plan.configuration?.root_module
  if (root) visit({ module: root, prefix: '' })
  return out
}

/**
 * The model once the plan is applied. Entities come from `planned_values`.
 * Edges of untouched resources come from the prior state, which recorded
 * them; edges of resources the plan touches come from the configuration,
 * because that is what they will depend on afterwards, plus any recorded edge
 * the new graph still reaches.
 */
function afterModel(plan: TfPlan, before: Model, touched: Set<string>, includeDataSources: boolean): Model {
  const after = importTerraformState(stateFromValues(plan.planned_values), {
    includeDataSources,
    modelName: before.name,
  })
  const known = new Set(after.entities.map((e) => e.id))
  const index = new AddressIndex(known)
  const configured = plan.configuration ? configuredDependencies(plan) : undefined
  const configuredFor = (id: string) => configured?.get(configAddress(id))
  const edges: Edge[] = []
  const seen = new Set<string>()
  const push = (from: string, to: string) => {
    const key = `${from}\u0000${to}`
    if (seen.has(key) || from === to || !known.has(from) || !known.has(to)) return
    seen.add(key)
    edges.push({ from, to, kind: 'depends-on' })
  }
  for (const e of before.edges) {
    if (touched.has(e.from) && configuredFor(e.from)) continue
    push(e.from, e.to)
  }
  if (configured) {
    for (const id of touched) {
      for (const to of configuredFor(id) ?? []) for (const resolved of index.resolve(to, id)) push(id, resolved)
    }
    // State records every dependency, transitive ones included, where the
    // configuration names only direct references. A touched resource's state
    // edge therefore still holds if its target is reachable through the new
    // graph; dropping it would draw `api -> vpc` going away when `api -> db ->
    // vpc` is untouched.
    const out = new Map<string, string[]>()
    for (const e of edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    const reachable = (from: string): Set<string> => {
      const seenFrom = new Set<string>()
      const queue = [...(out.get(from) ?? [])]
      while (queue.length) {
        const next = queue.shift()!
        if (seenFrom.has(next)) continue
        seenFrom.add(next)
        queue.push(...(out.get(next) ?? []))
      }
      return seenFrom
    }
    for (const id of touched) {
      if (!configuredFor(id)) continue
      // Compared without module keys: state recorded a dependency on
      // `module.svc` as one on every instance of it, so the configuration
      // naming only `module.svc["api"]` is the same fact, not a removal.
      const still = new Set([...reachable(id)].map(configAddress))
      for (const e of before.edges) if (e.from === id && still.has(configAddress(e.to))) push(e.from, e.to)
    }
  }
  after.edges = edges.sort((a, b) => (a.from + a.to).localeCompare(b.from + b.to))
  return after
}

function classify(before: Model, after: Model, actions: Map<string, Set<string>>): Map<string, ChangeMark> {
  const inBefore = new Set(before.entities.map((e) => e.id))
  const inAfter = new Set(after.entities.map((e) => e.id))
  const marks = new Map<string, ChangeMark>()
  for (const [id, verbs] of actions) {
    if (inBefore.has(id) && !inAfter.has(id)) marks.set(id, 'destroy')
    else if (!inBefore.has(id) && inAfter.has(id)) marks.set(id, 'create')
    else if (verbs.has('replace')) marks.set(id, 'replace')
    else if (inBefore.has(id) || inAfter.has(id)) marks.set(id, 'update')
  }
  return marks
}

function isIgnored(declared: Model | undefined, e: Entity): boolean {
  if (!declared) return false
  return (
    declared.ignore.entities.some((p) => matches(p, e.id)) || declared.ignore.kinds.some((p) => matches(p, e.kind))
  )
}

/**
 * The resources the plan touches, plus only the neighbours a reviewer needs:
 * the other end of every relationship the plan adds or removes, and whatever
 * depends on a resource the plan replaces or destroys, since that is what the
 * change can break. A replaced database's subnets and KMS key are not news;
 * the queue a new subscription feeds is. Neighbours the committed model
 * ignores (log groups, typically) are left out; changed entities never are.
 * A plan too large for one picture keeps only the changed entities.
 */
function diagramModel(
  before: Model,
  after: Model,
  marks: Map<string, ChangeMark>,
  changed: { added: Edge[]; removed: Edge[] },
  declared: Model | undefined,
): { model: Model; neighbours: boolean } | undefined {
  if (marks.size === 0 || marks.size > MAX_DIAGRAM_NODES) return undefined
  const byId = new Map<string, Entity>()
  for (const e of before.entities) byId.set(e.id, e)
  for (const e of after.entities) byId.set(e.id, e)

  const key = (e: Edge) => `${e.from}\u0000${e.to}`
  const moved = new Set([...changed.added, ...changed.removed].map(key))
  const lossy = (id: string) => marks.get(id) === 'destroy' || marks.get(id) === 'replace'
  // Removed relationships exist only in the prior state, so they are drawn from it.
  const edges = [...after.edges, ...changed.removed]
  const withNeighbours = new Set(marks.keys())
  const consider = (id: string) => {
    const other = byId.get(id)
    if (other && !isIgnored(declared, other)) withNeighbours.add(id)
  }
  for (const e of edges) {
    if (moved.has(key(e))) {
      if (marks.has(e.from)) consider(e.to)
      if (marks.has(e.to)) consider(e.from)
    } else if (lossy(e.to)) {
      consider(e.from)
    }
  }
  const neighbours = withNeighbours.size <= MAX_DIAGRAM_NODES
  const ids = neighbours ? withNeighbours : new Set(marks.keys())

  const entities = [...ids].map((id) => byId.get(id)).filter((e): e is Entity => e !== undefined)
  entities.sort((a, b) => a.id.localeCompare(b.id))
  const seen = new Set<string>()
  const kept: Edge[] = []
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to) || seen.has(key(e))) continue
    seen.add(key(e))
    kept.push(e)
  }
  return { model: { ...after, entities, edges: kept, views: [] }, neighbours }
}

/** Builds the preview in memory: no disk, no network. */
export function previewPlan(plan: TfPlan, opts: PreviewOptions = {}): PreviewResult {
  const includeDataSources = opts.includeDataSources ?? false
  const name = opts.declared?.name ?? 'terraform'
  const before = importTerraformState(stateFromValues(plan.prior_state?.values), { includeDataSources, modelName: name })
  const actions = actionsByEntity(plan, includeDataSources)
  const after = afterModel(plan, before, new Set(actions.keys()), includeDataSources)
  const marks = classify(before, after, actions)

  const byMark = (mark: ChangeMark) =>
    [...marks].filter(([, m]) => m === mark).map(([id]) => id).sort((a, b) => a.localeCompare(b))
  const edgeDiff = reconcile(before, after)
  const changes: PlanChanges = {
    create: byMark('create'),
    update: byMark('update'),
    replace: byMark('replace'),
    destroy: byMark('destroy'),
    edges: { added: edgeDiff.edges.added, removed: edgeDiff.edges.removed },
  }

  let design: PlanDesign | undefined
  if (opts.declared) {
    const afterApply = driftFrom(opts.declared, after)
    // Coverage is set aside here: a blind spot means the observer might not
    // see something, but a plan that destroys it is not guessing.
    const plainDeclared = { ...opts.declared, coverage: [] }
    const destroyedFromModel = new Set(reconcile(plainDeclared, after).entities.removed.map((e) => e.id))
    design = {
      createdNotDeclared: changes.create.filter((id) => afterApply.entities.added.includes(id)),
      destroyedButDeclared: changes.destroy.filter((id) => destroyedFromModel.has(id)),
      beforePlan: driftFrom(opts.declared, before),
      afterApply,
    }
  }

  const preview = PlanPreview.parse({
    preview: 1,
    title: opts.title ?? name,
    changes,
    design,
  })

  const picture = diagramModel(before, after, marks, changes.edges, opts.declared)
  const edgeMarks = [
    ...changes.edges.added.map((e) => ({ from: e.from, to: e.to, mark: 'added' as const })),
    ...changes.edges.removed.map((e) => ({ from: e.from, to: e.to, mark: 'removed' as const })),
  ]
  const diagram = picture
    ? renderMermaid(picture.model, {
        direction: 'LR',
        marks: Object.fromEntries(marks),
        edgeMarks,
        groupBy: opts.groupBy,
        collapse: opts.collapse,
      })
    : undefined
  const entities = new Map([...before.entities, ...after.entities].map((e) => [e.id, e]))
  const comment = formatPreviewComment(preview, { diagram, neighbours: picture?.neighbours ?? true, entities })
  return { preview, comment, diagram }
}

/** A code span that survives any backticks inside it. */
function code(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length))
  const fence = '`'.repeat(longest + 1)
  return `${fence}${longest ? ' ' : ''}${text}${longest ? ' ' : ''}${fence}`
}

/** Names come from infrastructure; in a table cell they must not start a column, a tag or a new row. */
function cell(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/\|/g, '\\|').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const resources = (n: number) => `${n} ${n === 1 ? 'resource' : 'resources'}`

const VERBS: [keyof Omit<PlanChanges, 'edges'>, string][] = [
  ['create', 'creates'],
  ['replace', 'replaces'],
  ['update', 'updates'],
  ['destroy', 'destroys'],
]

function listSentence(parts: string[]): string {
  if (parts.length <= 1) return parts.join('')
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`
}

export interface CommentContext {
  diagram?: string
  /** False when the diagram had to drop the changed entities' neighbours. */
  neighbours?: boolean
  entities?: Map<string, Entity>
}

/**
 * Markdown for the pull request. Leads with the count and with anything that
 * loses data, because a reviewer skimming a busy pull request reads one line;
 * the full list folds away below the picture.
 */
export function formatPreviewComment(preview: PlanPreview, ctx: CommentContext = {}): string {
  const { changes, design } = preview
  const out: string[] = [PREVIEW_MARKER, `### Architecture preview · ${cell(preview.title)}`, '']

  const counts = VERBS.filter(([key]) => changes[key].length > 0).map(
    ([key, verb]) => `${verb} ${changes[key].length}`,
  )
  const total = VERBS.reduce((n, [key]) => n + changes[key].length, 0)
  if (total === 0) {
    out.push('This plan changes no resources.', '')
  } else {
    const what = counts.length === 1 ? counts[0] : `changes ${resources(total)}: it ${listSentence(counts)}`
    out.push(`**This plan ${counts.length === 1 ? `${what} ${total === 1 ? 'resource' : 'resources'}` : what}.**`, '')
  }

  // Replace and destroy are the two verbs a reviewer cannot take back after
  // the merge, so they are named above the picture rather than inside it.
  const lossy = [
    ...changes.replace.map((id) => `${code(id)} is replaced: destroyed, then created again.`),
    ...changes.destroy.map((id) => `${code(id)} is destroyed.`),
  ]
  if (lossy.length) {
    out.push('> [!WARNING]', ...lossy.map((line) => `> - ${line}`), '>', '> Whatever these hold does not carry over unless it is backed up.', '')
  }

  if (ctx.diagram) {
    out.push('```mermaid', ctx.diagram.trimEnd(), '```', '')
    const legend =
      'Outlined green: create · blue: update · amber: replace · dashed red: destroy. Thick green arrows are new relationships; dashed red ones go away.'
    out.push(
      ctx.neighbours === false
        ? `${legend} Only the changed resources are drawn; with their neighbours the picture was too large to read.`
        : `${legend} Unmarked resources are drawn because this plan connects them to a change, or because they depend on something it replaces or destroys.`,
      '',
    )
  } else if (total > MAX_DIAGRAM_NODES) {
    out.push(`_${resources(total)} change, too many to draw in one picture. The full list is below._`, '')
  }

  if (design) {
    out.push('#### Against the committed design', '')
    const items = [
      ...design.createdNotDeclared.map((id) => `- ${code(id)} is created here but is not in the model.`),
      ...design.destroyedButDeclared.map((id) => `- ${code(id)} is in the model but this plan destroys it.`),
    ]
    if (items.length) {
      out.push(...items, '', 'If these are intended, update the model in this pull request so the design stays true.')
    } else {
      out.push('Nothing this plan creates or destroys departs from the model.')
    }
    const { entities, edges } = design.beforePlan
    const already = entities.added.length + entities.removed.length + entities.changed.length + edges.added + edges.removed
    if (already > 0) {
      out.push(
        '',
        `_${already} ${already === 1 ? 'difference' : 'differences'} from the model ${already === 1 ? 'was' : 'were'} already there before this plan. \`driftwood reconcile\` lists them._`,
      )
    }
    out.push('')
  }

  if (total > 0) {
    out.push(`<details><summary>Every change (${total})</summary>`, '', '| Action | Resource | Kind | Name |', '|---|---|---|---|')
    for (const [key] of VERBS) {
      for (const id of changes[key]) {
        const e = ctx.entities?.get(id)
        out.push(`| ${key} | ${cell(id)} | ${cell(e?.kind ?? '')} | ${cell(e?.name ?? '')} |`)
      }
    }
    const { added, removed } = changes.edges
    if (added.length || removed.length) {
      out.push('', `Relationships: ${added.length} added, ${removed.length} removed.`)
    }
    out.push('', '</details>', '')
  }

  out.push('<sub>Drawn by driftwood from this pull request\'s Terraform plan. Nothing was applied.</sub>', '')
  return out.join('\n')
}
