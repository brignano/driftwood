import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importTerraformState, parseTerraformState } from '../src/providers/terraform.js'
import { validateModel } from '../src/model/validate.js'

const state = parseTerraformState(readFileSync(new URL('../examples/orders-platform.tfstate.json', import.meta.url), 'utf8'))

describe('parseTerraformState', () => {
  it('rejects an unsupported state version', () => {
    expect(() => parseTerraformState('{"version": 3}')).toThrow(/unsupported/)
  })

  it('accepts state with no version field', () => {
    expect(() => parseTerraformState('{"resources": []}')).not.toThrow()
  })
})

describe('importTerraformState', () => {
  it('uses the Terraform address as the entity id', () => {
    const model = importTerraformState(state)
    expect(model.entities.map((e) => e.id)).toContain('aws_s3_bucket.assets')
  })

  it('skips data sources unless asked for them', () => {
    const without = importTerraformState(state)
    expect(without.entities.some((e) => e.id === 'aws_caller_identity.current')).toBe(false)

    const with_ = importTerraformState(state, { includeDataSources: true })
    expect(with_.entities.some((e) => e.id === 'aws_caller_identity.current')).toBe(true)
  })

  it('derives edges from dependencies', () => {
    const model = importTerraformState(state)
    expect(model.edges).toContainEqual({
      from: 'aws_lambda_function.order_worker',
      to: 'aws_sqs_queue.orders',
      kind: 'depends-on',
    })
  })

  it('never emits dangling edges when a dependency was filtered out', () => {
    const model = importTerraformState(state)
    const ids = new Set(model.entities.map((e) => e.id))
    for (const edge of model.edges) {
      expect(ids.has(edge.from)).toBe(true)
      expect(ids.has(edge.to)).toBe(true)
    }
  })

  it('prefers a conventional name attribute for the label', () => {
    const model = importTerraformState(state)
    const bucket = model.entities.find((e) => e.id === 'aws_s3_bucket.assets')
    expect(bucket?.name).toBe('shop-example-com-assets')
    const fn = model.entities.find((e) => e.id === 'aws_lambda_function.order_worker')
    expect(fn?.name).toBe('shop-order-worker')
  })

  it('falls back through the other conventional name attributes', () => {
    const model = importTerraformState(state)
    // Terraform has no universal "name": a cache cluster calls it cluster_id,
    // a task definition family, an alarm alarm_name. Falling straight through
    // to the local resource name loses the only label a reader recognises.
    expect(model.entities.find((e) => e.id === 'aws_elasticache_cluster.sessions')?.name).toBe('shop-sessions')
    expect(model.entities.find((e) => e.id === 'aws_ecs_task_definition.storefront')?.name).toBe('shop-storefront')
    expect(model.entities.find((e) => e.id === 'aws_cloudwatch_metric_alarm.dlq_depth')?.name).toBe(
      'shop-orders-dlq-not-empty',
    )
  })

  it('falls back to the tag named Name when nothing conventional is set', () => {
    const model = importTerraformState(state)
    expect(model.entities.find((e) => e.id === 'aws_vpc.main')?.name).toBe('shop-prod')
  })

  it('groups by the resource-type segment after the provider prefix', () => {
    const model = importTerraformState(state)
    expect(model.entities.find((e) => e.id === 'aws_s3_bucket.assets')?.group).toBe('s3')
    expect(model.entities.find((e) => e.id === 'aws_iam_role.lambda_exec')?.group).toBe('iam')
  })

  it('extracts the short provider name as the platform', () => {
    const model = importTerraformState(state)
    expect(model.entities[0]?.platform).toBe('aws')
  })

  it('stamps provenance on every entity', () => {
    const model = importTerraformState(state)
    expect(model.entities.every((e) => e.source === 'terraform')).toBe(true)
  })

  it('produces a model that passes validation', () => {
    const model = importTerraformState(state)
    expect(validateModel(model).ok).toBe(true)
  })

  it('is deterministic across runs', () => {
    expect(JSON.stringify(importTerraformState(state))).toBe(JSON.stringify(importTerraformState(state)))
  })
})
