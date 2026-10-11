import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import type { SourcedModel } from '../src/model/merge.js'
import {
  LATEST_FILE,
  SNAPSHOT_FILE,
  SUMMARY_FILE,
  formatSnapshotSummary,
  loadLatestSnapshot,
  loadPreviousSnapshot,
  parseSnapshot,
  subjectDir,
  takeSnapshot,
  writeSnapshot,
  writeToStore,
} from '../src/snapshot.js'
import type { Snapshot } from '../src/snapshot.js'

const model = (partial: Partial<Model> & { name?: string }): Model =>
  Model.parse({ version: 1, name: 'shop', ...partial })

const sourced = (m: Model): SourcedModel[] => [{ provider: 'terraform', kind: 'declarative', model: m }]

const tmp = () => mkdtempSync(join(tmpdir(), 'driftwood-snap-'))

const first = model({
  entities: [
    { id: 'aws_lb.api', kind: 'aws_lb', group: 'edge' },
    { id: 'aws_ecs_service.api', kind: 'aws_ecs_service', group: 'app' },
    { id: 'aws_s3_bucket.uploads', kind: 'aws_s3_bucket', group: 'data' },
    { id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret', group: 'data' },
  ],
  edges: [
    { from: 'aws_lb.api', to: 'aws_ecs_service.api' },
    { from: 'aws_ecs_service.api', to: 'aws_s3_bucket.uploads' },
  ],
})

/** The next deploy: a queue added, the bucket gone, the service regrouped, the secret invisible. */
const second = model({
  entities: [
    { id: 'aws_lb.api', kind: 'aws_lb', group: 'edge' },
    { id: 'aws_ecs_service.api', kind: 'aws_ecs_service', group: 'compute' },
    { id: 'aws_sqs_queue.orders', kind: 'aws_sqs_queue', group: 'async' },
  ],
  edges: [
    { from: 'aws_lb.api', to: 'aws_ecs_service.api' },
    { from: 'aws_ecs_service.api', to: 'aws_sqs_queue.orders' },
  ],
})

const declared = model({
  ...first,
  views: [
    { id: 'edge', title: 'Edge', include: ['edge'] },
    { id: 'app', include: ['app', 'compute'] },
  ],
  coverage: [{ scope: 'aws_secretsmanager_*', reason: 'the deploy role cannot list secrets' }],
})

async function snapshotOf(m: Model, extra: Partial<Parameters<typeof takeSnapshot>[0]> = {}) {
  return takeSnapshot({
    subject: { app: 'shop', environment: 'prod' },
    observed: m,
    sources: sourced(m),
    engine: 'mermaid',
    now: new Date(),
    ...extra,
  })
}

describe('takeSnapshot', () => {
  it('draws the whole model when there is nothing else to go on', async () => {
    const { snapshot, files } = await snapshotOf(first)

    expect(snapshot.diagrams).toEqual([
      { title: 'shop', file: 'diagram.mmd', renderer: 'mermaid', via: 'built-in' },
    ])
    expect(files['diagram.mmd']).toContain('flowchart LR')
    expect(snapshot.changes).toBeUndefined()
    expect(snapshot.drift).toBeUndefined()
    expect(snapshot.observation.sources).toEqual([
      { provider: 'terraform', kind: 'declarative', entities: 4, edges: 2 },
    ])
  })

  it("draws each of the committed model's views, which no provider can infer", async () => {
    const { snapshot, files } = await snapshotOf(second, { declared })

    expect(snapshot.diagrams.map((d) => [d.view, d.title, d.file])).toEqual([
      [undefined, 'shop', 'diagram.mmd'],
      ['edge', 'Edge', 'diagram-edge.mmd'],
      ['app', 'app', 'diagram-app.mmd'],
    ])
    expect(files['diagram-edge.mmd']).toContain('aws_lb')
    expect(files['diagram-edge.mmd']).not.toContain('aws_sqs_queue')
  })

  it('borrows only views from the committed model, so the snapshot still describes reality', async () => {
    const { snapshot } = await snapshotOf(second, { declared })

    const ids = snapshot.observation.model.entities.map((e) => e.id)
    expect(ids).not.toContain('aws_s3_bucket.uploads')
    expect(snapshot.observation.model.coverage).toEqual([])
    expect(snapshot.observation.model.views).toHaveLength(2)
  })

  it('never lets two views that sanitise alike overwrite each other', async () => {
    const withViews = model({
      ...first,
      views: [
        { id: 'a/b', include: ['edge'] },
        { id: 'a b', include: ['app'] },
      ],
    })
    const { snapshot, files } = await snapshotOf(first, { declared: withViews })

    const names = snapshot.diagrams.map((d) => d.file)
    expect(names).toEqual(['diagram.mmd', 'diagram-a-b.mmd', 'diagram-a-b-2.mmd'])
    expect(Object.keys(files)).toEqual(expect.arrayContaining(names))
  })

  it('reports what this deploy changed against the previous snapshot', async () => {
    const previous = (await snapshotOf(first)).snapshot
    const { snapshot } = await snapshotOf(second, { previous })

    const changes = snapshot.changes!
    expect(changes.since).toBe(previous.observation.observedAt)
    expect(changes.entities.added).toEqual(['aws_sqs_queue.orders'])
    // Carried whole: nothing else in this snapshot still describes them.
    expect(changes.entities.removed.map((e) => e.id)).toEqual([
      'aws_s3_bucket.uploads',
      'aws_secretsmanager_secret.db',
    ])
    expect(changes.entities.changed).toEqual([
      { id: 'aws_ecs_service.api', field: 'group', before: 'app', after: 'compute' },
    ])
    expect(changes.edges.added).toHaveLength(1)
    expect(changes.edges.removed).toHaveLength(1)
  })

  it("does not call a blind spot a removal, using the committed model's coverage", async () => {
    const previous = (await snapshotOf(first)).snapshot
    const { snapshot } = await snapshotOf(second, { previous, declared })

    expect(snapshot.changes!.entities.removed.map((e) => e.id)).toEqual(['aws_s3_bucket.uploads'])
    expect(snapshot.drift!.entities.unverifiable).toEqual(['aws_secretsmanager_secret.db'])
  })

  it('summarises drift from the committed design without failing', async () => {
    const { snapshot } = await snapshotOf(second, { declared })

    expect(snapshot.drift).toEqual({
      hasDrift: true,
      entities: {
        added: ['aws_sqs_queue.orders'],
        removed: ['aws_s3_bucket.uploads'],
        changed: ['aws_ecs_service.api'],
        unverifiable: ['aws_secretsmanager_secret.db'],
      },
      edges: { added: 1, removed: 1 },
    })
  })

  it('reports no drift when reality matches the design', async () => {
    const { snapshot, files } = await snapshotOf(first, { declared })
    expect(snapshot.drift!.hasDrift).toBe(false)
    expect(files[SUMMARY_FILE]).toContain('Matches the committed model.')
  })

  it('carries health so a viewer can colour what it draws', async () => {
    const { snapshot, files } = await snapshotOf(first, { health: { 'aws_lb.api': 'down' } })
    expect(snapshot.health).toEqual({ 'aws_lb.api': 'down' })
    expect(files['diagram.mmd']).toContain('down')
  })

  it('fails loudly when an explicitly named engine cannot run', async () => {
    await expect(snapshotOf(first, { engine: 'no-such-engine' })).rejects.toThrow()
  })
})

describe('formatSnapshotSummary', () => {
  it('inlines Mermaid, which build pages render in place', async () => {
    const { files } = await snapshotOf(first)
    expect(files[SUMMARY_FILE]).toContain('```mermaid\nflowchart LR')
  })

  it('lists other formats by file, since a summary cannot reference an artifact', async () => {
    const { snapshot, files } = await takeSnapshot({ subject: { app: 'shop' }, observed: first, sources: sourced(first), engine: 'dot' })
    expect(files[SUMMARY_FILE]).toContain('- shop: `diagram.dot`')
    expect(files[SUMMARY_FILE]).not.toContain('```')
    expect(formatSnapshotSummary(snapshot)).toContain('`diagram.dot`')
  })

  it('says so when a deploy changed nothing structural', async () => {
    const previous = (await snapshotOf(first)).snapshot
    const { files } = await snapshotOf(first, { previous })
    expect(files[SUMMARY_FILE]).toContain('No structural change since the previous deploy')
  })
})

describe('writing and reading snapshots', () => {
  it('round-trips through the directory it writes', async () => {
    const bundle = await snapshotOf(second, { declared })
    const dir = join(tmp(), 'nested', 'out')

    const written = writeSnapshot(dir, bundle)

    expect(written).toEqual(expect.arrayContaining([SNAPSHOT_FILE, SUMMARY_FILE, 'diagram.mmd']))
    const raw = JSON.parse(readFileSync(join(dir, SNAPSHOT_FILE), 'utf8'))
    expect(parseSnapshot(raw)).toEqual({ ok: true, snapshot: bundle.snapshot, issues: [] })
    // Either the directory or the file inside it, whichever the artifact store kept.
    expect(loadPreviousSnapshot(dir)).toEqual(bundle.snapshot)
    expect(loadPreviousSnapshot(join(dir, SNAPSHOT_FILE))).toEqual(bundle.snapshot)
  })

  it('treats a missing previous snapshot as a first deploy, not an error', () => {
    expect(loadPreviousSnapshot(join(tmp(), 'never-written'))).toBeUndefined()
    const empty = join(tmp(), 'empty-dir')
    mkdirSync(empty)
    expect(loadPreviousSnapshot(empty)).toBeUndefined()
  })

  it('refuses a previous snapshot that exists but does not parse', () => {
    // Dropping it silently would report every entity as new.
    const dir = tmp()
    writeFileSync(join(dir, 'bad.json'), '{ not json')
    expect(() => loadPreviousSnapshot(join(dir, 'bad.json'))).toThrow(/is not JSON/)

    writeFileSync(join(dir, 'wrong.json'), JSON.stringify({ snapshot: 2 }))
    expect(() => loadPreviousSnapshot(join(dir, 'wrong.json'))).toThrow(/not a valid snapshot/)
  })

  it('rejects an unknown format version', () => {
    const result = parseSnapshot({ snapshot: 2 } as unknown as Snapshot)
    expect(result.ok).toBe(false)
    expect(result.issues.join('\n')).toContain('snapshot')
  })
})

describe('which app and environment a snapshot is of', () => {
  it('is recorded on every snapshot, defaulting the environment', async () => {
    const { snapshot } = await takeSnapshot({ subject: { app: 'shop' }, observed: first, sources: sourced(first), engine: 'dot' })
    expect(snapshot.subject).toEqual({ app: 'shop', environment: 'default' })
  })

  it('heads the summary, so a build page says what it is showing', async () => {
    const { files } = await snapshotOf(first, { subject: { app: 'orders-api', environment: 'prod', build: '412' } })
    expect(files[SUMMARY_FILE]!.split('\n')[0]).toBe('## orders-api · prod · 412')
  })

  it("refuses to compare against another app's or environment's snapshot", async () => {
    const previous = (await snapshotOf(first)).snapshot
    // Every entity would read as added and every other as removed.
    await expect(snapshotOf(second, { previous, subject: { app: 'payments', environment: 'prod' } })).rejects.toThrow(
      /previous snapshot is for shop\/prod, not payments\/prod/,
    )
    await expect(snapshotOf(second, { previous, subject: { app: 'shop', environment: 'staging' } })).rejects.toThrow(
      /not shop\/staging/,
    )
  })
})

describe('a store shared by many apps', () => {
  const at = (iso: string) => new Date(iso)
  const snap = (app: string, environment: string, build: string | undefined, m: Model, now: Date, previous?: Snapshot) =>
    snapshotOf(m, { subject: { app, environment, build }, now, previous })

  it('files each snapshot under its app, environment and build', async () => {
    const store = tmp()
    const result = writeToStore(store, await snap('orders-api', 'prod', '101', first, at('2026-10-01T10:00:00Z')))

    expect(result.dir).toBe(join(store, 'orders-api', 'prod', '101'))
    expect(result.latestUpdated).toBe(true)
    expect(JSON.parse(readFileSync(join(store, 'orders-api', 'prod', LATEST_FILE), 'utf8'))).toEqual({
      latest: '101',
      observedAt: '2026-10-01T10:00:00.000Z',
      build: '101',
    })
  })

  it('names a build-less snapshot by its time, so listings sort chronologically', async () => {
    const store = tmp()
    const { dir } = writeToStore(store, await snap('shop', 'prod', undefined, first, at('2026-10-01T10:00:00.123Z')))
    expect(dir).toBe(join(store, 'shop', 'prod', '20261001T100000Z'))
  })

  it("finds each subject's own latest, never another app's", async () => {
    const store = tmp()
    const orders = await snap('orders-api', 'prod', '101', first, at('2026-10-01T10:00:00Z'))
    const payments = await snap('payments', 'prod', '7', second, at('2026-10-01T11:00:00Z'))
    writeToStore(store, orders)
    writeToStore(store, payments)

    expect(loadLatestSnapshot(store, { app: 'orders-api', environment: 'prod' })).toEqual(orders.snapshot)
    expect(loadLatestSnapshot(store, { app: 'payments', environment: 'prod' })).toEqual(payments.snapshot)
    expect(loadLatestSnapshot(store, { app: 'orders-api', environment: 'staging' })).toBeUndefined()
  })

  it('compares the next deploy against the latest it finds', async () => {
    const store = tmp()
    writeToStore(store, await snap('shop', 'prod', '1', first, at('2026-10-01T10:00:00Z')))
    const previous = loadLatestSnapshot(store, { app: 'shop', environment: 'prod' })
    const { snapshot } = await snap('shop', 'prod', '2', second, at('2026-10-01T11:00:00Z'), previous)
    expect(snapshot.changes!.entities.added).toEqual(['aws_sqs_queue.orders'])
  })

  it('never moves latest backwards when pipelines finish out of order', async () => {
    const store = tmp()
    writeToStore(store, await snap('shop', 'prod', '2', second, at('2026-10-01T11:00:00Z')))
    const late = writeToStore(store, await snap('shop', 'prod', '1', first, at('2026-10-01T10:00:00Z')))

    expect(late.latestUpdated).toBe(false)
    expect(loadLatestSnapshot(store, { app: 'shop', environment: 'prod' })!.subject.build).toBe('2')
    // Still written, so the history is complete.
    expect(loadPreviousSnapshot(late.dir)!.subject.build).toBe('1')
  })

  it('keeps pipeline-supplied names inside the store', () => {
    const store = tmp()
    expect(subjectDir(store, { app: 'team/orders api', environment: 'prod' })).toBe(join(store, 'team-orders-api', 'prod'))
    expect(() => subjectDir(store, { app: '..', environment: 'prod' })).toThrow(/cannot be used as a directory name/)
    expect(() => subjectDir(store, { app: 'ok', environment: '///' })).toThrow(/cannot be used as a directory name/)
  })

  it('refuses a latest pointer whose snapshot is missing', async () => {
    const store = tmp()
    const base = subjectDir(store, { app: 'shop', environment: 'prod' })
    mkdirSync(base, { recursive: true })
    writeFileSync(join(base, LATEST_FILE), JSON.stringify({ latest: 'gone', observedAt: '2026-10-01T10:00:00Z' }))
    expect(() => loadLatestSnapshot(store, { app: 'shop', environment: 'prod' })).toThrow(/points at gone/)
  })
})
