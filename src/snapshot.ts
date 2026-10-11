import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { Edge, Entity } from './model/schema.js'
import type { Model } from './model/schema.js'
import type { SourcedModel } from './model/merge.js'
import { Observation, formatObservation, toObservation } from './model/observation.js'
import { COMPARED_FIELDS, reconcile } from './reconcile/index.js'
import { resolveRenderer } from './render/index.js'
import { HealthStatus } from './health.js'
import type { HealthMap } from './health.js'
import { renderViewer } from './viewer.js'

/**
 * A snapshot: what one deploy left behind, packaged for whoever shows it.
 *
 * `observe` hands facts to a repository that reconciles them later. A snapshot
 * is for the other audience — the person who just deployed, looking at a build
 * page. It is the observation plus everything a viewer needs to draw it without
 * running driftwood itself: rendered diagrams, what changed since the previous
 * deploy, and how far the result sits from the committed design.
 *
 * It is a reporting step, not a gate. A post-deploy hook that fails the deploy
 * because the architecture moved would be switched off within a week, so the
 * snapshot records drift and leaves the decision to whoever reads it. The
 * `reconcile` command remains the gate.
 */

/** A compared field that moved between two deploys. */
export const SnapshotFieldChange = z.object({
  id: z.string(),
  field: z.enum(COMPARED_FIELDS),
  before: z.string().optional(),
  after: z.string().optional(),
})
export type SnapshotFieldChange = z.infer<typeof SnapshotFieldChange>

/**
 * What this deploy changed, relative to the previous snapshot. Added entities
 * are named by id because they are in this snapshot's model; removed ones are
 * carried whole, because nothing else in the snapshot still describes them and
 * a viewer drawing "this went away" needs to know what it was.
 */
export const SnapshotChanges = z.object({
  /** `observedAt` of the snapshot compared against. */
  since: z.string().datetime(),
  entities: z.object({
    added: z.array(z.string()),
    removed: z.array(Entity),
    changed: z.array(SnapshotFieldChange),
  }),
  edges: z.object({
    added: z.array(Edge),
    removed: z.array(Edge),
  }),
})
export type SnapshotChanges = z.infer<typeof SnapshotChanges>

/**
 * Distance from the committed model, by entity id. Deliberately a summary: the
 * full report is what `reconcile` is for, and a build page needs to say "three
 * things differ from the design" and link onward, not re-render a pull request.
 */
export const SnapshotDrift = z.object({
  hasDrift: z.boolean(),
  entities: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.string()),
    /** Declared, unobserved, inside a blind spot. Unknown, never absent. */
    unverifiable: z.array(z.string()),
  }),
  edges: z.object({ added: z.number().int(), removed: z.number().int() }),
})
export type SnapshotDrift = z.infer<typeof SnapshotDrift>

export const SnapshotDiagram = z.object({
  /** The view drawn, or absent for the whole model. */
  view: z.string().optional(),
  title: z.string(),
  /** Path relative to the snapshot directory. */
  file: z.string(),
  renderer: z.string(),
  via: z.string(),
})
export type SnapshotDiagram = z.infer<typeof SnapshotDiagram>

/**
 * What a snapshot is *of*. A build platform deploys many apps to many
 * environments, and a diagram nobody can attribute is worse than none — so
 * identity is a required, typed field rather than whatever free-form `origin`
 * keys a pipeline happened to set. It is also the store's directory layout, and
 * what decides which earlier snapshot counts as "previous".
 */
export const SnapshotSubject = z.object({
  /** The app, service or repository deployed. */
  app: z.string().min(1),
  environment: z.string().min(1).default('default'),
  /** The build or pipeline run id. Names the snapshot's directory in a store. */
  build: z.string().min(1).optional(),
})
export type SnapshotSubject = z.infer<typeof SnapshotSubject>

export const Snapshot = z.object({
  /** Format version, independent of the observation's and the model's. */
  snapshot: z.literal(1),
  subject: SnapshotSubject,
  observation: Observation,
  changes: SnapshotChanges.optional(),
  drift: SnapshotDrift.optional(),
  health: z.record(HealthStatus).optional(),
  diagrams: z.array(SnapshotDiagram),
})
export type Snapshot = z.infer<typeof Snapshot>

export interface SnapshotOptions {
  subject: z.input<typeof SnapshotSubject>
  /** The merged observation, as `observeAll` or an importer produced it. */
  observed: Model
  sources: SourcedModel[]
  /**
   * The committed model. Lends the snapshot its hand-written `views`, which no
   * provider can infer and without which a large estate is one unreadable
   * picture, and is what drift is measured against.
   */
  declared?: Model
  /** The previous deploy's snapshot, to say what this one changed. */
  previous?: Snapshot
  health?: HealthMap
  origin?: Record<string, string>
  engine?: string
  direction?: 'LR' | 'TD'
  icons?: boolean
  now?: Date
}

export interface SnapshotBundle {
  snapshot: Snapshot
  /** Diagrams and the markdown summary, keyed by path relative to the snapshot directory. */
  files: Record<string, string>
  /** Set when `auto` could not use the engine it preferred. */
  fellBackFrom?: string
}

export const SNAPSHOT_FILE = 'snapshot.json'
export const SUMMARY_FILE = 'summary.md'
/** The page a build platform embeds: diagrams, changes and blast radius, with nothing to fetch. */
export const VIEWER_FILE = 'index.html'

/** View ids are free text in the model; file names are not. */
function fileStem(viewId: string): string {
  return viewId.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'view'
}

/**
 * The previous snapshot is compared under the committed model's `ignore` and
 * `coverage`, not its own (an observation carries neither). A secret the
 * deploying role cannot list is in a blind spot on every deploy, and reporting
 * it as removed by this one would be the same false deletion the coverage rule
 * exists to prevent.
 */
function changesSince(previous: Snapshot, current: Model, declared?: Model): SnapshotChanges {
  const before = previous.observation.model
  const diff = reconcile(
    declared ? { ...before, ignore: declared.ignore, coverage: declared.coverage } : before,
    current,
  )
  return {
    since: previous.observation.observedAt,
    entities: {
      added: diff.entities.added.map((e) => e.id),
      removed: diff.entities.removed,
      changed: diff.entities.changed.map((c) => ({
        id: c.id,
        field: c.field,
        before: c.declared,
        after: c.observed,
      })),
    },
    edges: { added: diff.edges.added, removed: diff.edges.removed },
  }
}

function driftFrom(declared: Model, observed: Model): SnapshotDrift {
  const drift = reconcile(declared, observed)
  return {
    hasDrift: drift.hasDrift,
    entities: {
      added: drift.entities.added.map((e) => e.id),
      removed: drift.entities.removed.map((e) => e.id),
      // One entity can change in several fields; the summary counts entities.
      changed: [...new Set(drift.entities.changed.map((c) => c.id))],
      unverifiable: drift.unverifiable.entities.map((u) => u.entity.id),
    },
    edges: { added: drift.edges.added.length, removed: drift.edges.removed.length },
  }
}

/**
 * Builds a snapshot in memory. No disk, no network: the observation has
 * already happened, so this is reachable from tests and from a host program
 * that wants the diagrams without driftwood writing files on its behalf.
 */
export async function takeSnapshot(opts: SnapshotOptions): Promise<SnapshotBundle> {
  const subject = SnapshotSubject.parse(opts.subject)
  if (opts.previous) assertSameSubject(opts.previous, subject)
  const views = opts.declared?.views ?? opts.observed.views
  // Views come from the committed model, aliases have already been applied by
  // the merge, and nothing else from the declared model leaks into what was
  // observed — the snapshot must still describe reality, not the design.
  const model: Model = { ...opts.observed, views }
  const observation = toObservation(model, opts.sources, opts.origin, opts.now)

  const { renderer, via, fellBackFrom } = await resolveRenderer(opts.engine ?? 'auto')
  const ctx = { direction: opts.direction ?? 'LR', health: opts.health, icons: opts.icons ?? true }

  const files: Record<string, string> = {}
  const diagrams: SnapshotDiagram[] = []
  const used = new Set<string>()

  const overview = `diagram.${renderer.extension}`
  files[overview] = await renderer.render(model, ctx)
  used.add(overview)
  diagrams.push({ title: model.name, file: overview, renderer: renderer.name, via })

  for (const view of views) {
    let file = `diagram-${fileStem(view.id)}.${renderer.extension}`
    // Two view ids can sanitise to the same stem; never let one overwrite another.
    for (let n = 2; used.has(file); n++) file = `diagram-${fileStem(view.id)}-${n}.${renderer.extension}`
    used.add(file)
    files[file] = await renderer.render(model, { ...ctx, view: view.id })
    diagrams.push({ view: view.id, title: view.title ?? view.id, file, renderer: renderer.name, via })
  }

  const snapshot = Snapshot.parse({
    snapshot: 1,
    subject,
    observation,
    changes: opts.previous ? changesSince(opts.previous, model, opts.declared) : undefined,
    drift: opts.declared ? driftFrom(opts.declared, model) : undefined,
    health: opts.health,
    diagrams,
  })

  files[SUMMARY_FILE] = formatSnapshotSummary(snapshot, files, opts.now)
  files[VIEWER_FILE] = renderViewer(snapshot, files)
  return { snapshot, files, fellBackFrom }
}

/**
 * Comparing one app's deploy against another's would report every entity as
 * added and every other as removed, which reads as a catastrophe rather than a
 * mistake. Refuse it instead.
 */
function assertSameSubject(previous: Snapshot, subject: SnapshotSubject): void {
  const was = previous.subject
  if (was.app !== subject.app || was.environment !== subject.environment) {
    throw new Error(
      `the previous snapshot is for ${was.app}/${was.environment}, not ${subject.app}/${subject.environment} — ` +
        'comparing them would report everything as changed. Pass the previous snapshot of the same app and environment.',
    )
  }
}

export interface SnapshotParseResult {
  ok: boolean
  snapshot?: Snapshot
  issues: string[]
}

export function parseSnapshot(raw: unknown): SnapshotParseResult {
  const parsed = Snapshot.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
    }
  }
  return { ok: true, snapshot: parsed.data, issues: [] }
}

/**
 * Reads a previous snapshot. Accepts the directory `writeSnapshot` produced or
 * the `snapshot.json` inside it, since a pipeline restoring last deploy's
 * artifact will hand over whichever its artifact store kept.
 *
 * Returns undefined when nothing is there: the first deploy has no previous
 * snapshot, and that is not an error. A file that exists but does not parse
 * is one, because silently dropping it would report every entity as new.
 */
export function loadPreviousSnapshot(path: string): Snapshot | undefined {
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EISDIR') return loadPreviousSnapshot(join(path, SNAPSHOT_FILE))
    if (code === 'ENOENT') return undefined
    throw new Error(`could not read previous snapshot ${path}: ${(error as Error).message}`)
  }

  let raw: unknown
  try {
    raw = JSON.parse(source)
  } catch (error) {
    throw new Error(`previous snapshot ${path} is not JSON: ${(error as Error).message}`)
  }
  const result = parseSnapshot(raw)
  if (!result.ok || !result.snapshot) {
    throw new Error(`previous snapshot ${path} is not a valid snapshot:\n  ${result.issues.join('\n  ')}`)
  }
  return result.snapshot
}

/** Writes `snapshot.json` and every file in the bundle into `dir`, creating it if needed. */
export function writeSnapshot(dir: string, bundle: SnapshotBundle): string[] {
  mkdirSync(dir, { recursive: true })
  const written: string[] = []
  for (const [name, content] of Object.entries(bundle.files)) {
    writeFileSync(join(dir, name), content)
    written.push(name)
  }
  writeFileSync(join(dir, SNAPSHOT_FILE), `${JSON.stringify(bundle.snapshot, null, 2)}\n`)
  written.push(SNAPSHOT_FILE)
  return written
}

export const LATEST_FILE = 'latest.json'

/**
 * Where a store keeps the latest snapshot of one app in one environment. Read
 * by the platform to show the current picture without listing anything, and by
 * the next deploy to find what it is compared against.
 */
export const LatestPointer = z.object({
  latest: z.string().min(1),
  observedAt: z.string().datetime(),
  build: z.string().optional(),
})
export type LatestPointer = z.infer<typeof LatestPointer>

/**
 * App, environment and build ids become directory names, and arrive from
 * pipeline variables nobody here controls. Anything outside a conservative set
 * is replaced, and a segment that would climb out of the store is refused.
 */
function pathSegment(value: string, label: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '')
  if (!safe || /^\.+$/.test(safe)) throw new Error(`${label} '${value}' cannot be used as a directory name`)
  return safe
}

/** `<store>/<app>/<environment>`, the directory holding every snapshot of one subject. */
export function subjectDir(store: string, subject: z.input<typeof SnapshotSubject>): string {
  const s = SnapshotSubject.parse(subject)
  return join(store, pathSegment(s.app, 'app'), pathSegment(s.environment, 'environment'))
}

/**
 * The build id when there is one, otherwise the observation time, compacted so
 * directory listings sort chronologically.
 */
function snapshotDirName(snapshot: Snapshot): string {
  if (snapshot.subject.build) return pathSegment(snapshot.subject.build, 'build')
  return snapshot.observation.observedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function readLatestPointer(dir: string): LatestPointer | undefined {
  const path = join(dir, LATEST_FILE)
  let source: string
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = LatestPointer.safeParse(JSON.parse(source))
  if (!parsed.success) throw new Error(`${path} is not a valid latest pointer`)
  return parsed.data
}

/** The most recent snapshot of a subject in a store, or undefined before its first deploy. */
export function loadLatestSnapshot(store: string, subject: z.input<typeof SnapshotSubject>): Snapshot | undefined {
  const dir = subjectDir(store, subject)
  const pointer = readLatestPointer(dir)
  if (!pointer) return undefined
  const snapshot = loadPreviousSnapshot(join(dir, pathSegment(pointer.latest, 'latest')))
  if (!snapshot) throw new Error(`${join(dir, LATEST_FILE)} points at ${pointer.latest}, which has no ${SNAPSHOT_FILE}`)
  return snapshot
}

export interface StoreResult {
  /** The directory the snapshot was written to. */
  dir: string
  written: string[]
  /** False when a newer snapshot was already latest — a pipeline that finished out of order. */
  latestUpdated: boolean
}

/**
 * Writes a snapshot into a store at `<store>/<app>/<environment>/<build>/` and
 * moves that subject's `latest.json` to it.
 *
 * `latest` only ever moves forward. Two pipelines for the same app can finish
 * out of order, and the slower, older one must not make the platform show a
 * picture that is no longer true. A re-run of the same build overwrites its
 * own directory, which is what a retried deploy should do.
 *
 * Only a local directory is written. Uploading it to wherever the platform
 * reads from belongs to the pipeline, so driftwood never needs write
 * credentials for anything.
 */
export function writeToStore(store: string, bundle: SnapshotBundle): StoreResult {
  const base = subjectDir(store, bundle.snapshot.subject)
  const name = snapshotDirName(bundle.snapshot)
  const dir = join(base, name)
  const written = writeSnapshot(dir, bundle)

  const current = readLatestPointer(base)
  const observedAt = bundle.snapshot.observation.observedAt
  const latestUpdated = !current || Date.parse(observedAt) >= Date.parse(current.observedAt)
  if (latestUpdated) {
    const pointer: LatestPointer = { latest: name, observedAt, build: bundle.snapshot.subject.build }
    // Written aside and renamed, so a reader never sees half a pointer.
    const tmp = join(base, `.${LATEST_FILE}.${process.pid}.tmp`)
    writeFileSync(tmp, `${JSON.stringify(pointer, null, 2)}\n`)
    renameSync(tmp, join(base, LATEST_FILE))
  }
  return { dir, written, latestUpdated }
}

const count = (n: number) => `${n} ${n === 1 ? 'entity' : 'entities'}`

/**
 * Markdown for a CI job summary or a build page. Mermaid diagrams are inlined
 * because GitHub and most build UIs render them in place; anything else is
 * listed by file name, since a summary cannot reference a sibling artifact.
 */
export function formatSnapshotSummary(
  snapshot: Snapshot,
  files: Record<string, string> = {},
  now: Date = new Date(),
): string {
  const { app, environment, build } = snapshot.subject
  const heading = `## ${app} · ${environment}${build ? ` · ${build}` : ''}`
  const out: string[] = [heading, '', formatObservation(snapshot.observation, now), '']

  const changes = snapshot.changes
  if (changes) {
    const { entities, edges } = changes
    const total =
      entities.added.length + entities.removed.length + entities.changed.length + edges.added.length + edges.removed.length
    out.push('### Changed by this deploy', '')
    if (total === 0) {
      out.push(`No structural change since the previous deploy (${changes.since}).`, '')
    } else {
      for (const id of entities.added) out.push(`- **added** \`${id}\``)
      for (const e of entities.removed) out.push(`- **removed** \`${e.id}\` - ${e.kind}`)
      for (const c of entities.changed) {
        out.push(`- **changed** \`${c.id}\` ${c.field}: ${c.before ?? '-'} -> ${c.after ?? '-'}`)
      }
      if (edges.added.length || edges.removed.length) {
        out.push(`- relationships: ${edges.added.length} added, ${edges.removed.length} removed`)
      }
      out.push('')
    }
  }

  const drift = snapshot.drift
  if (drift) {
    out.push('### Against the committed design', '')
    const { entities, edges } = drift
    if (!drift.hasDrift) {
      out.push('Matches the committed model.')
    } else {
      const parts = [
        entities.added.length && `${count(entities.added.length)} not in the model`,
        entities.removed.length && `${count(entities.removed.length)} declared but not found`,
        entities.changed.length && `${count(entities.changed.length)} changed`,
        (edges.added || edges.removed) &&
          `${edges.added + edges.removed} ${edges.added + edges.removed === 1 ? 'relationship' : 'relationships'} different`,
      ].filter(Boolean)
      out.push(`Differs from the committed model: ${parts.join(', ')}. Run \`driftwood reconcile\` for the full report.`)
    }
    if (entities.unverifiable.length) {
      out.push('', `_Not checked: ${count(entities.unverifiable.length)} declared inside a blind spot._`)
    }
    out.push('')
  }

  out.push('### Diagrams', '')
  for (const d of snapshot.diagrams) {
    const body = files[d.file]
    if (d.renderer === 'mermaid' && body !== undefined) {
      out.push(`#### ${d.title}`, '', '```mermaid', body.trimEnd(), '```', '')
    } else {
      out.push(`- ${d.title}: \`${d.file}\``)
    }
  }
  out.push('')
  return out.join('\n')
}
