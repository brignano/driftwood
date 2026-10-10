import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parse } from 'yaml'
import { applyDrift, formatApplySummary } from '../src/model/apply.js'
import { importTerraformState, parseTerraformState } from '../src/providers/terraform.js'
import { loadModel } from '../src/model/validate.js'
import { Model } from '../src/model/schema.js'
import { reconcile } from '../src/reconcile/index.js'

const model = (partial: Partial<Model> & { name?: string }): Model =>
  Model.parse({ version: 1, name: 'test', ...partial })

/** Reconcile a YAML source against an observed model, then write the result back. */
function roundTrip(source: string, observed: Model): string {
  const declared = loadModel(source)
  if (!declared.ok || !declared.model) throw new Error(declared.issues.map((i) => i.message).join('; '))
  return applyDrift(source, reconcile(declared.model, observed)).yaml
}

describe('applyDrift', () => {
  it('adds an observed entity the model was missing', () => {
    const source = 'version: 1\nname: t\nentities: []\nedges: []\n'
    const observed = model({ entities: [{ id: 'aws_s3_bucket.new', kind: 'aws_s3_bucket', name: 'b' }] })
    const out = parse(roundTrip(source, observed))
    expect(out.entities.map((e: { id: string }) => e.id)).toEqual(['aws_s3_bucket.new'])
  })

  it('removes an entity that is genuinely gone', () => {
    const source = 'version: 1\nname: t\nentities:\n  - id: gone\n    kind: aws_s3_bucket\nedges: []\n'
    const out = parse(roundTrip(source, model({})))
    expect(out.entities).toEqual([])
  })

  // The whole point of the coverage rule, carried through to the writer: a
  // pull request that deletes an entity nobody deleted is the failure mode.
  it('leaves an unobservable entity in place', () => {
    const source = [
      'version: 1',
      'name: t',
      'entities:',
      '  - id: aws_secretsmanager_secret.db',
      '    kind: aws_secretsmanager_secret',
      'edges: []',
      'coverage:',
      '  - scope: aws_secretsmanager_*',
      '    reason: cannot list secrets',
      '',
    ].join('\n')
    const out = parse(roundTrip(source, model({})))
    expect(out.entities.map((e: { id: string }) => e.id)).toEqual(['aws_secretsmanager_secret.db'])
  })

  it('applies a changed field without disturbing the rest of the entity', () => {
    const source = [
      'version: 1',
      'name: t',
      'entities:',
      '  - id: db',
      '    kind: aws_db_instance',
      '    name: old',
      '    level: component',
      '    tags:',
      '      owner: platform-team',
      'edges: []',
      '',
    ].join('\n')
    const observed = model({ entities: [{ id: 'db', kind: 'aws_db_instance', name: 'new' }] })
    const out = parse(roundTrip(source, observed))
    expect(out.entities[0].name).toBe('new')
    // `level` and `tags` are not compared fields, so they are not the
    // writer's to overwrite — even though the observation has neither.
    expect(out.entities[0].level).toBe('component')
    expect(out.entities[0].tags).toEqual({ owner: 'platform-team' })
  })

  it('preserves comments and the hand-written blocks no importer can infer', () => {
    const source = [
      'version: 1',
      'name: t',
      'entities:',
      '  - id: keep',
      '    kind: service',
      'edges: []',
      '# Views are hand-written and explain themselves.',
      'views:',
      '  - id: edge',
      '    include: ["*"]',
      '# Intentional divergence, reviewed like code.',
      'ignore:',
      '  kinds: [aws_cloudwatch_log_group]',
      '# Cross-source identity is explicit, never guessed.',
      'aliases:',
      '  SERVICE-ABC: keep',
      '',
    ].join('\n')
    const observed = model({
      entities: [
        { id: 'keep', kind: 'service' },
        { id: 'added', kind: 'service' },
      ],
    })
    const out = roundTrip(source, observed)
    expect(out).toContain('# Views are hand-written and explain themselves.')
    expect(out).toContain('# Intentional divergence, reviewed like code.')
    expect(out).toContain('# Cross-source identity is explicit, never guessed.')
    expect(out).toContain('SERVICE-ABC: keep')
    const parsed = parse(out)
    expect(parsed.views).toHaveLength(1)
    expect(parsed.ignore.kinds).toEqual(['aws_cloudwatch_log_group'])
  })

  it('keeps the trailing newline convention the source used', () => {
    const withBlank = 'version: 1\nname: t\nentities: []\nedges: []\n\n'
    const observed = model({ entities: [{ id: 'x', kind: 'service' }] })
    expect(roundTrip(withBlank, observed).endsWith('\n\n')).toBe(true)

    const withOne = 'version: 1\nname: t\nentities: []\nedges: []\n'
    const out = roundTrip(withOne, observed)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.endsWith('\n\n')).toBe(false)
  })

  it('gives a source with no trailing newline one', () => {
    const source = 'version: 1\nname: t\nentities: []\nedges: []'
    const observed = model({ entities: [{ id: 'x', kind: 'service' }] })
    expect(roundTrip(source, observed).endsWith('\n')).toBe(true)
  })

  // `localeCompare` and `<` disagree on `.` versus `_`, which is exactly what
  // Terraform addresses are built from. Sorting one way and inserting the
  // other puts a new entity near, but not at, its re-import position.
  it('inserts using the same ordering the importer sorts with', () => {
    const ids = ['aws_iam_role_policy.orders_api', 'aws_iam_role.ecs_task_execution', 'aws_iam_role.orders_api']
    const source = [
      'version: 1',
      'name: t',
      'entities:',
      ...ids.flatMap((id) => [`  - id: ${id}`, '    kind: aws_iam_role']),
      'edges: []',
      '',
    ].join('\n')
    const observed = model({
      entities: [
        ...ids.map((id) => ({ id, kind: 'aws_iam_role' })),
        { id: 'aws_iam_role.lambda_exec', kind: 'aws_iam_role' },
      ],
    })
    const out = parse(roundTrip(source, observed))
    const expected = [...ids, 'aws_iam_role.lambda_exec'].sort((a, b) => a.localeCompare(b))
    expect(out.entities.map((e: { id: string }) => e.id)).toEqual(expected)
  })

  it('adds and removes edges', () => {
    const source = [
      'version: 1',
      'name: t',
      'entities:',
      '  - id: a',
      '    kind: s',
      '  - id: b',
      '    kind: s',
      'edges:',
      '  - from: a',
      '    to: b',
      '    kind: depends-on',
      '',
    ].join('\n')
    const observed = model({
      entities: [
        { id: 'a', kind: 's' },
        { id: 'b', kind: 's' },
      ],
      edges: [{ from: 'b', to: 'a', kind: 'depends-on' }],
    })
    const out = parse(roundTrip(source, observed))
    expect(out.edges).toEqual([{ from: 'b', to: 'a', kind: 'depends-on' }])
  })

  it('creates the entities and edges blocks when the model has none', () => {
    const source = 'version: 1\nname: t\n'
    const observed = model({
      entities: [
        { id: 'a', kind: 's' },
        { id: 'b', kind: 's' },
      ],
      edges: [{ from: 'a', to: 'b', kind: 'depends-on' }],
    })
    const out = parse(roundTrip(source, observed))
    expect(out.entities).toHaveLength(2)
    expect(out.edges).toHaveLength(1)
  })

  it('reports what it wrote, including what it deliberately left alone', () => {
    const source = [
      'version: 1',
      'name: t',
      'entities:',
      '  - id: aws_secretsmanager_secret.db',
      '    kind: aws_secretsmanager_secret',
      'edges: []',
      'coverage:',
      '  - scope: aws_secretsmanager_*',
      '    reason: cannot list secrets',
      '',
    ].join('\n')
    const declared = loadModel(source)
    const observed = model({ entities: [{ id: 'new', kind: 'service' }] })
    const { summary } = applyDrift(source, reconcile(declared.model!, observed))
    expect(summary.entitiesAdded).toBe(1)
    expect(summary.entitiesRemoved).toBe(0)
    expect(summary.leftUnverified).toBe(1)
    expect(formatApplySummary(summary)).toContain('1 declared fact left in place')
  })
})

describe('applyDrift on the worked example', () => {
  const source = () => readFileSync(new URL('../examples/architecture.yaml', import.meta.url), 'utf8')
  const drifted = () =>
    importTerraformState(
      parseTerraformState(readFileSync(new URL('../examples/orders-platform.drifted.tfstate.json', import.meta.url), 'utf8')),
      { modelName: 'orders-platform' },
    )

  // The property that makes this safe to run on a schedule: writing the drift
  // back must actually resolve it, or the job proposes the same pull request
  // every morning.
  it('converges — reconciling the written model reports no drift', () => {
    const written = roundTrip(source(), drifted())
    const reloaded = loadModel(written)
    expect(reloaded.ok).toBe(true)
    expect(reconcile(reloaded.model!, drifted()).hasDrift).toBe(false)
  })

  it('is idempotent — a second pass changes nothing', () => {
    const once = roundTrip(source(), drifted())
    expect(roundTrip(once, drifted())).toBe(once)
  })

  it('leaves every hand-written block and comment intact', () => {
    const written = roundTrip(source(), drifted())
    const before = parse(source())
    const after = parse(written)
    expect(after.views).toEqual(before.views)
    expect(after.ignore).toEqual(before.ignore)
    expect(after.aliases).toEqual(before.aliases)
    expect(after.coverage).toEqual(before.coverage)
    for (const comment of source().split('\n').filter((l) => l.trimStart().startsWith('#'))) {
      expect(written).toContain(comment)
    }
  })

  // A model the importer would not produce shows up as permanent drift, and
  // `group` is a compared field — so every entity a re-import can see must
  // come back byte-identical.
  it('writes entities a re-import reproduces exactly', () => {
    const written = parse(roundTrip(source(), drifted()))
    const reimported = drifted()
    const byId = new Map(reimported.entities.map((e) => [e.id, e]))
    for (const entity of written.entities) {
      const fresh = byId.get(entity.id)
      if (!fresh) continue
      expect(entity).toEqual(JSON.parse(JSON.stringify(fresh)))
    }
  })

  it('touches only the entities and edges that actually changed', () => {
    const written = roundTrip(source(), drifted())
    const before = source().split('\n')
    const after = written.split('\n')
    const removed = before.filter((l) => !after.includes(l))
    // The one genuinely deleted bucket, the renamed database's old name, and
    // the three edges that went with the bucket.
    expect(removed.some((l) => l.includes('shop-example-com-uploads'))).toBe(true)
    expect(removed.some((l) => l.includes('shop-orders-prod') && !l.includes('v2'))).toBe(true)
    // Nothing from a hand-written block, and no blind-spot resource.
    expect(removed.some((l) => l.includes('aws_secretsmanager_secret.db_password'))).toBe(false)
    expect(removed.some((l) => l.trimStart().startsWith('#'))).toBe(false)
  })
})
