import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import { formatDrift, reconcile } from '../src/reconcile/index.js'

const model = (partial: Partial<Model> & { name?: string }): Model =>
  Model.parse({ version: 1, name: 'test', ...partial })

describe('reconcile', () => {
  it('reports no drift when the model matches reality', () => {
    const a = model({ entities: [{ id: 'x', kind: 'service', name: 'X' }] })
    const drift = reconcile(a, a)
    expect(drift.hasDrift).toBe(false)
    expect(formatDrift(drift)).toContain('No drift')
  })

  it('reports entities present in infrastructure but missing from the model', () => {
    const declared = model({})
    const observed = model({ entities: [{ id: 'new', kind: 'aws_s3_bucket' }] })
    const drift = reconcile(declared, observed)
    expect(drift.entities.added.map((e) => e.id)).toEqual(['new'])
    expect(drift.hasDrift).toBe(true)
  })

  it('reports entities declared but not found', () => {
    const declared = model({ entities: [{ id: 'gone', kind: 'aws_s3_bucket' }] })
    const observed = model({})
    const drift = reconcile(declared, observed)
    expect(drift.entities.removed.map((e) => e.id)).toEqual(['gone'])
  })

  it('does not treat a tag change as drift', () => {
    const declared = model({ entities: [{ id: 'x', kind: 'service', tags: { owner: 'a' } }] })
    const observed = model({ entities: [{ id: 'x', kind: 'service', tags: { owner: 'b', extra: 'c' } }] })
    expect(reconcile(declared, observed).hasDrift).toBe(false)
  })

  it('does treat a changed kind as drift', () => {
    const declared = model({ entities: [{ id: 'x', kind: 'aws_lambda_function' }] })
    const observed = model({ entities: [{ id: 'x', kind: 'aws_ecs_service' }] })
    const drift = reconcile(declared, observed)
    expect(drift.entities.changed).toHaveLength(1)
    expect(drift.entities.changed[0]?.field).toBe('kind')
  })

  it('honours an entity ignore pattern', () => {
    const declared = model({ ignore: { entities: ['aws_iam_*'], kinds: [], edges: [] } })
    const observed = model({ entities: [{ id: 'aws_iam_role.x', kind: 'aws_iam_role' }] })
    const drift = reconcile(declared, observed)
    expect(drift.hasDrift).toBe(false)
    expect(drift.ignored.entities).toBe(1)
  })

  it('honours a kind ignore pattern', () => {
    const declared = model({ ignore: { entities: [], kinds: ['aws_cloudwatch_*'], edges: [] } })
    const observed = model({ entities: [{ id: 'aws_cloudwatch_log_group.a', kind: 'aws_cloudwatch_log_group' }] })
    expect(reconcile(declared, observed).hasDrift).toBe(false)
  })

  it('ignores edges that touch an ignored entity', () => {
    const declared = model({
      entities: [{ id: 'keep', kind: 'service' }],
      ignore: { entities: ['noisy'], kinds: [], edges: [] },
    })
    const observed = model({
      entities: [
        { id: 'keep', kind: 'service' },
        { id: 'noisy', kind: 'service' },
      ],
      edges: [{ from: 'keep', to: 'noisy', kind: 'depends-on' }],
    })
    const drift = reconcile(declared, observed)
    expect(drift.edges.added).toHaveLength(0)
    expect(drift.ignored.edges).toBe(1)
  })

  it('detects added and removed edges', () => {
    const declared = model({
      entities: [
        { id: 'a', kind: 's' },
        { id: 'b', kind: 's' },
      ],
      edges: [{ from: 'a', to: 'b', kind: 'depends-on' }],
    })
    const observed = model({
      entities: [
        { id: 'a', kind: 's' },
        { id: 'b', kind: 's' },
      ],
      edges: [{ from: 'b', to: 'a', kind: 'depends-on' }],
    })
    const drift = reconcile(declared, observed)
    expect(drift.edges.added).toHaveLength(1)
    expect(drift.edges.removed).toHaveLength(1)
  })

  it('surfaces declared coverage gaps in the report', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'read-only role cannot list secrets' }],
      entities: [{ id: 'gone', kind: 'service' }],
    })
    const report = formatDrift(reconcile(declared, model({})))
    expect(report).toContain('Known coverage gaps')
    expect(report).toContain('read-only role cannot list secrets')
  })
})

describe('formatDrift', () => {
  it('emits markdown suitable for a pull request body', () => {
    const declared = model({ entities: [{ id: 'gone', kind: 'aws_s3_bucket', name: 'old' }] })
    const observed = model({ entities: [{ id: 'new', kind: 'aws_lambda_function', name: 'fn' }] })
    const report = formatDrift(reconcile(declared, observed))
    expect(report).toContain('## Architecture drift detected')
    expect(report).toContain('`new`')
    expect(report).toContain('`gone`')
  })
})
