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

  // Unknown is not absent. A provider holding read-only credentials that cannot
  // see a resource must never make the reconciler report it removed.
  it('does not report a declared entity as removed when it sits in a blind spot', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' }],
    })
    const drift = reconcile(declared, model({}))
    expect(drift.entities.removed).toHaveLength(0)
    expect(drift.unverifiable.entities.map((u) => u.entity.id)).toEqual(['aws_secretsmanager_secret.db'])
    expect(drift.unverifiable.entities[0]?.reason).toBe('cannot list secrets')
  })

  it('does not let a blind spot turn the drift gate red', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' }],
    })
    expect(reconcile(declared, model({})).hasDrift).toBe(false)
  })

  it('matches a coverage scope against an id as well as a kind', () => {
    const declared = model({
      coverage: [{ scope: 'aws_route53_record.*', reason: 'delegated zone' }],
      entities: [{ id: 'aws_route53_record.apex', kind: 'aws_route53_record' }],
    })
    const drift = reconcile(declared, model({}))
    expect(drift.entities.removed).toHaveLength(0)
    expect(drift.unverifiable.entities).toHaveLength(1)
  })

  it('still reports a removal outside every declared blind spot', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [{ id: 'aws_s3_bucket.uploads', kind: 'aws_s3_bucket' }],
    })
    const drift = reconcile(declared, model({}))
    expect(drift.entities.removed.map((e) => e.id)).toEqual(['aws_s3_bucket.uploads'])
    expect(drift.unverifiable.entities).toHaveLength(0)
    expect(drift.hasDrift).toBe(true)
  })

  // A blind spot says "might not be seen", never "must not be reported" — a
  // resource appearing inside one is newly visible, and suppressing it would
  // lose a real resource.
  it('still reports an addition inside a blind spot', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
    })
    const observed = model({
      entities: [{ id: 'aws_secretsmanager_secret.new', kind: 'aws_secretsmanager_secret' }],
    })
    const drift = reconcile(declared, observed)
    expect(drift.entities.added.map((e) => e.id)).toEqual(['aws_secretsmanager_secret.new'])
    expect(drift.hasDrift).toBe(true)
  })

  // The entity was observed, so the blind spot never applied to it.
  it('still reports a field change on an entity inside a blind spot', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret', name: 'old' }],
    })
    const observed = model({
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret', name: 'new' }],
    })
    const drift = reconcile(declared, observed)
    expect(drift.entities.changed).toHaveLength(1)
    expect(drift.entities.changed[0]?.field).toBe('name')
  })

  it('treats an edge touching a blind spot as unverifiable rather than removed', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [
        { id: 'aws_lambda_function.fn', kind: 'aws_lambda_function' },
        { id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' },
      ],
      edges: [{ from: 'aws_lambda_function.fn', to: 'aws_secretsmanager_secret.db', kind: 'depends-on' }],
    })
    const observed = model({ entities: [{ id: 'aws_lambda_function.fn', kind: 'aws_lambda_function' }] })
    const drift = reconcile(declared, observed)
    expect(drift.edges.removed).toHaveLength(0)
    expect(drift.unverifiable.edges).toHaveLength(1)
    expect(drift.hasDrift).toBe(false)
  })

  // Intentional divergence is decided before visibility is considered, so an
  // ignored entity stays a single ignored count rather than becoming an
  // unverifiable row the reader has to reconcile with the ignore list.
  it('counts an ignored entity as ignored even when it also sits in a blind spot', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      ignore: { entities: ['aws_secretsmanager_secret.db'], kinds: [], edges: [] },
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' }],
    })
    const drift = reconcile(declared, model({}))
    expect(drift.ignored.entities).toBe(1)
    expect(drift.unverifiable.entities).toHaveLength(0)
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

  it('names the blind spot and the reason for every unverifiable entity', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [
        { id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' },
        { id: 'aws_s3_bucket.uploads', kind: 'aws_s3_bucket' },
      ],
    })
    const report = formatDrift(reconcile(declared, model({})))
    expect(report).toContain('Declared, but not verifiable (1)')
    expect(report).toContain('`aws_secretsmanager_secret.db`')
    expect(report).toContain('cannot list secrets')
    // The one genuine removal must still read as a removal.
    expect(report).toContain('not found in infrastructure (1)')
  })

  // "No drift" next to entities nobody could look at would overclaim.
  it('reports unverifiable entities even when there is no drift', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' }],
    })
    const report = formatDrift(reconcile(declared, model({})))
    expect(report).toContain('No drift')
    expect(report).toContain('Declared, but not verifiable (1)')
  })

  it('says nothing about verifiability when every declared entity was observed', () => {
    const declared = model({
      coverage: [{ scope: 'aws_secretsmanager_*', reason: 'cannot list secrets' }],
      entities: [{ id: 'aws_secretsmanager_secret.db', kind: 'aws_secretsmanager_secret' }],
    })
    const report = formatDrift(reconcile(declared, declared))
    expect(report).not.toContain('not verifiable')
  })
})
