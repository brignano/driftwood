import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadHealthMap, parseHealthMap, unknownHealthIds } from '../src/health.js'
import { Model } from '../src/model/schema.js'
import { renderMermaid } from '../src/render/mermaid.js'

const model = Model.parse({
  version: 1,
  name: 'test',
  entities: [
    { id: 'aws_lb.api', kind: 'aws_lb', name: 'api', group: 'lb' },
    { id: 'aws_db_instance.orders', kind: 'aws_db_instance', name: 'orders', group: 'db' },
  ],
  edges: [],
  views: [{ id: 'lb-only', include: ['lb'] }],
})

function writeTemp(name: string, contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), 'driftwood-health-')), name)
  writeFileSync(path, contents)
  return path
}

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

describe('loadHealthMap', () => {
  it('reads a valid health file', () => {
    const path = writeTemp('ok.json', '{"aws_lb.api":"down"}')
    expect(loadHealthMap(path)).toEqual({ 'aws_lb.api': 'down' })
  })

  it('reports an unreadable file by path', () => {
    const path = join(tmpdir(), 'driftwood-health-does-not-exist.json')
    expect(() => loadHealthMap(path)).toThrow(/could not read health file/i)
  })

  it('reports malformed JSON rather than throwing a raw parse error', () => {
    const path = writeTemp('broken.json', '{"aws_lb.api": down}')
    expect(() => loadHealthMap(path)).toThrow(/could not read health file/i)
  })

  it('names the offending file and key on an out-of-range status', () => {
    const path = writeTemp('bad-status.json', '{"aws_lb.api":"ok"}')
    expect(() => loadHealthMap(path)).toThrow(/invalid health file .*bad-status\.json/i)
    expect(() => loadHealthMap(path)).toThrow(/aws_lb\.api/)
  })
})

describe('unknownHealthIds', () => {
  it('returns ids that match no entity in the model', () => {
    const health = parseHealthMap({ 'aws_lb.api': 'healthy', 'typo.not_an_entity': 'down' })
    expect(unknownHealthIds(health, model)).toEqual(['typo.not_an_entity'])
  })

  it('does not flag an id the current view merely filters out', () => {
    const health = parseHealthMap({ 'aws_db_instance.orders': 'down' })
    expect(unknownHealthIds(health, model)).toEqual([])
  })
})

describe('health reaches the renderer', () => {
  it('classes visible entities by status', () => {
    const health = parseHealthMap({ 'aws_lb.api': 'healthy', 'aws_db_instance.orders': 'down' })
    const out = renderMermaid(model, { health })
    expect(out).toContain('class n_aws_lb_api healthy;')
    expect(out).toContain('class n_aws_db_instance_orders down;')
  })

  it('skips entities the view filtered out', () => {
    const health = parseHealthMap({ 'aws_db_instance.orders': 'down' })
    const out = renderMermaid(model, { view: 'lb-only', health })
    expect(out).not.toContain('class n_aws_db_instance_orders down;')
  })
})
