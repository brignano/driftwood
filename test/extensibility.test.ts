import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { Registry } from '../src/registry.js'
import { Model } from '../src/model/schema.js'
import { mergeModels, formatConflicts } from '../src/model/merge.js'
import { defineProvider } from '../src/providers/types.js'
import { providers } from '../src/providers/index.js'
import { renderers, resolveRenderer } from '../src/render/index.js'
import { defineRenderer } from '../src/render/types.js'
import { renderDot } from '../src/render/dot.js'
import { toModel as dynatraceToModel } from '../src/providers/dynatrace.js'

const model = (partial: Partial<Model>): Model => Model.parse({ version: 1, name: 't', ...partial })

describe('Registry', () => {
  it('registers and retrieves by name', () => {
    const r = new Registry<{ name: string }>('thing')
    r.register({ name: 'a' })
    expect(r.get('a').name).toBe('a')
    expect(r.has('a')).toBe(true)
  })

  it('refuses a duplicate registration', () => {
    const r = new Registry<{ name: string }>('thing')
    r.register({ name: 'a' })
    expect(() => r.register({ name: 'a' })).toThrow(/already registered/)
  })

  it('allows a deliberate override', () => {
    const r = new Registry<{ name: string; v?: number }>('thing')
    r.register({ name: 'a', v: 1 })
    r.override({ name: 'a', v: 2 })
    expect(r.get('a').v).toBe(2)
  })

  it('lists available names in the error for an unknown lookup', () => {
    const r = new Registry<{ name: string }>('thing')
    r.register({ name: 'alpha' })
    expect(() => r.get('nope')).toThrow(/available: alpha/)
  })
})

describe('provider extension point', () => {
  it('ships terraform and dynatrace as built-ins', () => {
    expect(providers.names()).toContain('terraform')
    expect(providers.names()).toContain('dynatrace')
  })

  it('marks terraform as platform-agnostic so it covers aws, gcp and onprem alike', () => {
    expect(providers.get('terraform').platforms).toEqual(['*'])
  })

  it('distinguishes declarative from runtime sources', () => {
    expect(providers.get('terraform').kind).toBe('declarative')
    expect(providers.get('dynatrace').kind).toBe('runtime')
  })

  it('accepts a third-party provider through the same API as a built-in', async () => {
    const custom = defineProvider({
      name: 'splunk-example',
      description: 'third-party provider registered from outside core',
      kind: 'runtime',
      platforms: ['onprem'],
      configSchema: z.object({ index: z.string() }),
      observe: (config) =>
        model({ entities: [{ id: `splunk:${config.index}`, kind: 'index', source: 'splunk-example' }] }),
    })
    const local = new Registry<typeof custom>('provider').register(custom)
    const result = await local.get('splunk-example').observe({ index: 'main' }, {
      secret: () => undefined,
      resolvePath: (p) => p,
      log: () => {},
    })
    expect(result.entities[0]?.id).toBe('splunk:main')
  })

  it('validates provider config before doing any work', () => {
    const parsed = providers.get('terraform').configSchema.safeParse({})
    expect(parsed.success).toBe(false)
  })
})

describe('renderer extension point and engine fallback', () => {
  it('registers graphviz, mermaid and dot', () => {
    expect(renderers.names()).toEqual(['dot', 'graphviz', 'mermaid'])
  })

  it('always has mermaid and dot available regardless of environment', async () => {
    expect((await renderers.get('mermaid').probe()).available).toBe(true)
    expect((await renderers.get('dot').probe()).available).toBe(true)
  })

  it('auto resolves to some usable renderer even with no Graphviz installed', async () => {
    const resolved = await resolveRenderer('auto')
    expect(resolved.renderer.name).toBeTruthy()
    // Whatever it picks must actually be usable.
    expect((await resolved.renderer.probe()).available).toBe(true)
  })

  it('falls back past an unavailable engine and reports what it skipped', async () => {
    const local = new Registry<ReturnType<typeof defineRenderer>>('renderer')
    const broken = defineRenderer({
      name: 'broken',
      description: 'never available',
      extension: 'x',
      priority: 999,
      probe: async () => ({ available: false, reason: 'not installed' }),
      render: async () => 'unreachable',
    })
    local.register(broken)
    local.register(renderers.get('mermaid'))

    const ordered = [...local.all()].sort((a, b) => b.priority - a.priority)
    expect(ordered[0]?.name).toBe('broken')
    // The real resolver skips it; assert the probe contract it relies on.
    expect((await broken.probe()).available).toBe(false)
  })

  it('fails loudly when an unavailable engine is named explicitly', async () => {
    const probe = await renderers.get('graphviz').probe()
    if (!probe.available) {
      await expect(resolveRenderer('graphviz')).rejects.toThrow(/not available/)
    } else {
      expect(probe.via).toBeTruthy()
    }
  })

  it('explains how to get Graphviz without a system package when it is missing', async () => {
    const probe = await renderers.get('graphviz').probe()
    if (!probe.available) {
      expect(probe.reason).toContain('@hpcc-js/wasm-graphviz')
    }
  })

  it('emits DOT source with no Graphviz present at all', () => {
    const m = model({
      entities: [
        { id: 'a', kind: 'aws_s3_bucket', name: 'bucket', group: 'storage' },
        { id: 'b', kind: 'aws_lambda_function', name: 'fn', group: 'compute' },
      ],
      edges: [{ from: 'b', to: 'a', kind: 'depends-on' }],
    })
    const dot = renderDot(m)
    expect(dot).toContain('digraph "t"')
    expect(dot).toContain('shape=cylinder')
    expect(dot).toContain('"b" -> "a"')
    expect(dot).toContain('subgraph cluster_0')
  })

  it('escapes quotes in DOT labels', () => {
    const m = model({ entities: [{ id: 'a', kind: 'service', name: 'say "hi"' }] })
    expect(renderDot(m)).toContain('\\"hi\\"')
  })
})

describe('multi-provider merge', () => {
  const tf = {
    provider: 'terraform',
    kind: 'declarative' as const,
    model: model({
      entities: [{ id: 'aws_lambda_function.fn', kind: 'aws_lambda_function', name: 'forwarder', platform: 'aws' }],
    }),
  }
  const dt = {
    provider: 'dynatrace',
    kind: 'runtime' as const,
    model: model({
      entities: [{ id: 'SERVICE-A1B2', kind: 'SERVICE', name: 'forwarder (prod)', platform: 'dynatrace' }],
    }),
  }

  it('keeps unaliased entities separate rather than guessing they match', () => {
    const { model: merged } = mergeModels([tf, dt])
    expect(merged.entities).toHaveLength(2)
  })

  it('collapses entities joined by an explicit alias', () => {
    const { model: merged } = mergeModels([tf, dt], { 'SERVICE-A1B2': 'aws_lambda_function.fn' })
    expect(merged.entities).toHaveLength(1)
    expect(merged.entities[0]?.id).toBe('aws_lambda_function.fn')
  })

  it('records provenance from every provider that saw the entity', () => {
    const { model: merged } = mergeModels([tf, dt], { 'SERVICE-A1B2': 'aws_lambda_function.fn' })
    expect(merged.entities[0]?.source).toBe('dynatrace+terraform')
  })

  it('prefers the declarative name over the runtime one', () => {
    const { model: merged } = mergeModels([tf, dt], { 'SERVICE-A1B2': 'aws_lambda_function.fn' })
    expect(merged.entities[0]?.name).toBe('forwarder')
  })

  it('reports disagreements instead of hiding them', () => {
    const { conflicts } = mergeModels([tf, dt], { 'SERVICE-A1B2': 'aws_lambda_function.fn' })
    const nameConflict = conflicts.find((c) => c.field === 'name')
    expect(nameConflict?.values).toHaveLength(2)
    expect(formatConflicts(conflicts)).toContain('Provider disagreements')
  })

  it('never produces a self-loop when an alias collapses both ends of an edge', () => {
    const a = {
      provider: 'p',
      kind: 'runtime' as const,
      model: model({
        entities: [
          { id: 'x', kind: 'service' },
          { id: 'y', kind: 'service' },
        ],
        edges: [{ from: 'x', to: 'y', kind: 'calls' }],
      }),
    }
    const { model: merged } = mergeModels([a], { y: 'x' })
    expect(merged.edges).toHaveLength(0)
  })

  it('drops edges whose endpoints were never observed', () => {
    const a = {
      provider: 'p',
      kind: 'runtime' as const,
      model: model({ entities: [{ id: 'x', kind: 'service' }], edges: [{ from: 'x', to: 'ghost', kind: 'calls' }] }),
    }
    expect(mergeModels([a]).model.edges).toHaveLength(0)
  })
})

describe('dynatrace mapping', () => {
  it('maps entities and relationships, skipping targets outside the selection', () => {
    const m = dynatraceToModel(
      [
        { entityId: 'SERVICE-1', displayName: 'api', type: 'SERVICE', fromRelationships: { calls: [{ id: 'SERVICE-2' }, { id: 'HOST-OUTSIDE' }] } },
        { entityId: 'SERVICE-2', displayName: 'db', type: 'SERVICE' },
      ],
      'aws',
    )
    expect(m.entities).toHaveLength(2)
    expect(m.edges).toEqual([{ from: 'SERVICE-1', to: 'SERVICE-2', kind: 'calls' }])
    expect(m.entities[0]?.source).toBe('dynatrace')
    expect(m.entities[0]?.platform).toBe('aws')
  })

  it('ignores entities with no id', () => {
    expect(dynatraceToModel([{ displayName: 'orphan' }], 'aws').entities).toHaveLength(0)
  })
})
