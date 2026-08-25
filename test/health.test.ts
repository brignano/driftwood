import { describe, expect, it } from 'vitest'
import { parseHealthMap } from '../src/health.js'

describe('parseHealthMap', () => {
  it('accepts the supported statuses', () => {
    expect(parseHealthMap({ a: 'healthy', b: 'degraded', c: 'down' })).toEqual({
      a: 'healthy',
      b: 'degraded',
      c: 'down',
    })
  })

  it('rejects a non-object root', () => {
    expect(() => parseHealthMap(['healthy'])).toThrow(/health map must be an object/i)
  })

  it('rejects unsupported health values', () => {
    expect(() => parseHealthMap({ a: 'unknown' })).toThrow(/invalid health value/i)
  })

  it('surfaces the exact bad key path', () => {
    expect(() => parseHealthMap({ nested: { a: 'bad' } })).toThrow(/nested\.a/i)
  })
})
