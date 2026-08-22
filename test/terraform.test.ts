import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { importTerraformState, parseTerraformState } from '../src/providers/terraform.js'
import { validateModel } from '../src/model/validate.js'

const state = parseTerraformState(readFileSync(new URL('../examples/aws-config.tfstate.json', import.meta.url), 'utf8'))

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
    expect(model.entities.map((e) => e.id)).toContain('aws_s3_bucket.emails')
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
      from: 'aws_lambda_function.email_forwarder',
      to: 'aws_s3_bucket.emails',
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
    const bucket = model.entities.find((e) => e.id === 'aws_s3_bucket.emails')
    expect(bucket?.name).toBe('brignano.io-emails')
    const fn = model.entities.find((e) => e.id === 'aws_lambda_function.email_forwarder')
    expect(fn?.name).toBe('email-forwarder')
  })

  it('groups by the resource-type segment after the provider prefix', () => {
    const model = importTerraformState(state)
    expect(model.entities.find((e) => e.id === 'aws_s3_bucket.emails')?.group).toBe('s3')
    expect(model.entities.find((e) => e.id === 'aws_iam_role.lambda_exec')?.group).toBe('iam')
  })

  it('extracts the short provider name', () => {
    const model = importTerraformState(state)
    expect(model.entities[0]?.provider).toBe('aws')
  })

  it('produces a model that passes validation', () => {
    const model = importTerraformState(state)
    expect(validateModel(model).ok).toBe(true)
  })

  it('is deterministic across runs', () => {
    expect(JSON.stringify(importTerraformState(state))).toBe(JSON.stringify(importTerraformState(state)))
  })
})
