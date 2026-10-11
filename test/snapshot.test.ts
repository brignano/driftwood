import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import type { SourcedModel } from '../src/model/merge.js'
import {
  SNAPSHOT_FILE,
  SUMMARY_FILE,
  formatSnapshotSummary,
  loadPreviousSnapshot,
  parseSnapshot,
  takeSnapshot,
  writeSnapshot,
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
  return takeSnapshot({ observed: m, sources: sourced(m), engine: 'mermaid', now: new Date(), ...extra })
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
    const { snapshot, files } = await takeSnapshot({ observed: first, sources: sourced(first), engine: 'dot' })
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
