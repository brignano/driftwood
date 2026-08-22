import { describe, expect, it } from 'vitest'
import { loadModel, matches, validateModel } from '../src/model/validate.js'

describe('matches', () => {
  it('matches exactly by default', () => {
    expect(matches('aws_s3_bucket.emails', 'aws_s3_bucket.emails')).toBe(true)
    expect(matches('aws_s3_bucket.emails', 'aws_s3_bucket.other')).toBe(false)
  })

  it('supports a trailing wildcard', () => {
    expect(matches('aws_iam_*', 'aws_iam_role.lambda')).toBe(true)
    expect(matches('aws_iam_*', 'aws_s3_bucket.x')).toBe(false)
  })

  it('treats a bare star as match-all', () => {
    expect(matches('*', 'anything')).toBe(true)
  })
})

describe('validateModel', () => {
  const base = { version: 1 as const, name: 'test' }

  it('accepts a minimal model', () => {
    const result = validateModel(base)
    expect(result.ok).toBe(true)
    expect(result.model?.entities).toEqual([])
  })

  it('rejects a model missing a version', () => {
    const result = validateModel({ name: 'x' })
    expect(result.ok).toBe(false)
  })

  it('rejects duplicate entity ids', () => {
    const result = validateModel({
      ...base,
      entities: [
        { id: 'a', kind: 'service' },
        { id: 'a', kind: 'service' },
      ],
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('duplicate entity id'))).toBe(true)
  })

  it('rejects edges pointing at unknown entities', () => {
    const result = validateModel({
      ...base,
      entities: [{ id: 'a', kind: 'service' }],
      edges: [{ from: 'a', to: 'ghost' }],
    })
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.message.includes('ghost'))).toBe(true)
  })

  it('warns but does not fail on a view that matches nothing', () => {
    const result = validateModel({
      ...base,
      entities: [{ id: 'a', kind: 'service' }],
      views: [{ id: 'empty', include: ['nope_*'] }],
    })
    expect(result.ok).toBe(true)
    expect(result.issues.some((i) => i.severity === 'warning')).toBe(true)
  })

  it('applies schema defaults', () => {
    const result = validateModel({ ...base, entities: [{ id: 'a', kind: 'service' }] })
    expect(result.model?.entities[0]?.level).toBe('container')
    expect(result.model?.ignore.entities).toEqual([])
  })
})

describe('loadModel', () => {
  it('reports invalid YAML as an error rather than throwing', () => {
    const result = loadModel('key: [unclosed')
    expect(result.ok).toBe(false)
    expect(result.issues[0]?.message).toContain('invalid YAML')
  })

  it('round-trips a valid document', () => {
    const result = loadModel('version: 1\nname: demo\nentities:\n  - id: a\n    kind: service\n')
    expect(result.ok).toBe(true)
    expect(result.model?.name).toBe('demo')
  })
})
