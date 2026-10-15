import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import { arrange } from '../src/render/arrange.js'
import { renderDot } from '../src/render/dot.js'
import { renderMermaid } from '../src/render/mermaid.js'
import { iconFor } from '../src/render/icons.js'
import type { SourcedModel } from '../src/model/merge.js'
import { VIEWER_FILE, takeSnapshot } from '../src/snapshot.js'

const API = 'module.ecs_service["api"]'
const WORKER = 'module.ecs_service["worker"]'

const model = Model.parse({
  version: 1,
  name: 'shop',
  entities: [
    { id: 'aws_lb.public', kind: 'aws_lb', group: 'lb' },
    { id: 'module.network.aws_vpc.main', kind: 'aws_vpc', group: 'vpc' },
    { id: `${API}.aws_ecs_service.this`, kind: 'aws_ecs_service', group: 'ecs' },
    { id: `${API}.aws_security_group.this`, kind: 'aws_security_group', group: 'security' },
    { id: `${API}.module.logs.aws_cloudwatch_log_group.this`, kind: 'aws_cloudwatch_log_group', group: 'cloudwatch' },
    { id: `${WORKER}.aws_ecs_service.this`, kind: 'aws_ecs_service', group: 'ecs' },
    { id: 'SERVICE-A1B2', kind: 'SERVICE', source: 'dynatrace' },
  ],
  edges: [
    { from: 'aws_lb.public', to: `${API}.aws_ecs_service.this` },
    { from: `${API}.aws_ecs_service.this`, to: `${API}.aws_security_group.this` },
    { from: `${API}.aws_ecs_service.this`, to: `${API}.module.logs.aws_cloudwatch_log_group.this` },
    { from: `${API}.aws_ecs_service.this`, to: 'module.network.aws_vpc.main' },
    { from: `${API}.aws_security_group.this`, to: 'module.network.aws_vpc.main' },
    { from: `${WORKER}.aws_ecs_service.this`, to: 'module.network.aws_vpc.main' },
  ],
  views: [
    { id: 'services', include: ['module.ecs_service*'], groupBy: 'module' },
    { id: 'overview', collapse: ['*'] },
  ],
})

const byId = (m: Model) => new Map(m.entities.map((e) => [e.id, e]))

describe('grouping by module', () => {
  it('boxes each resource by the module instance that owns it, leaving the root and other providers alone', () => {
    const { model: out, members } = arrange(model, { groupBy: 'module' })
    const e = byId(out)
    expect(e.get(`${API}.aws_ecs_service.this`)?.group).toBe(API)
    expect(e.get(`${API}.module.logs.aws_cloudwatch_log_group.this`)?.group).toBe(`${API}.module.logs`)
    expect(e.get('aws_lb.public')?.group).toBeUndefined()
    expect(e.get('SERVICE-A1B2')?.group).toBeUndefined()
    expect(members).toEqual({})
  })

  it('never changes the model it was given, because group is a compared field', () => {
    arrange(model, { groupBy: 'module', collapse: ['*'] })
    expect(byId(model).get(`${API}.aws_ecs_service.this`)?.group).toBe('ecs')
  })

  it('is what a view asks for, whatever the default', () => {
    const { model: out } = arrange(model, { view: 'services', groupBy: 'group' })
    expect(out.entities.map((e) => e.group)).toEqual(
      out.entities.map((e) => e.id.slice(0, e.id.lastIndexOf('.aws_'))),
    )
  })

  it('still refuses a view that does not exist', () => {
    expect(() => arrange(model, { view: 'nope' })).toThrow(/unknown view: nope/)
  })
})

describe('collapsing modules', () => {
  it('draws the outermost matching module as one node, with its count', () => {
    const { model: out, members } = arrange(model, { view: 'overview' })
    const e = byId(out)
    expect(e.get(API)).toMatchObject({ name: 'ecs_service["api"]', kind: 'module · 3 resources' })
    expect(e.get(WORKER)?.kind).toBe('module · 1 resource')
    expect(e.has(`${API}.module.logs`)).toBe(false)
    expect(members[API]).toEqual([
      `${API}.aws_ecs_service.this`,
      `${API}.aws_security_group.this`,
      `${API}.module.logs.aws_cloudwatch_log_group.this`,
    ])
    expect(e.has('aws_lb.public')).toBe(true)
    expect(e.has('SERVICE-A1B2')).toBe(true)
  })

  it('keeps arrows across the boundary, once, and drops the ones inside', () => {
    const { model: out } = arrange(model, { collapse: ['*'] })
    expect(out.edges.map((e) => `${e.from} -> ${e.to}`).sort()).toEqual([
      `${API} -> module.network`,
      `${WORKER} -> module.network`,
      `aws_lb.public -> ${API}`,
    ].sort())
  })

  it('matches every instance by the unkeyed name, or one by its key', () => {
    expect(Object.keys(arrange(model, { collapse: ['module.ecs_service'] }).members).sort()).toEqual([API, WORKER])
    expect(Object.keys(arrange(model, { collapse: [WORKER] }).members)).toEqual([WORKER])
  })

  it('boxes a collapsed module by its caller when grouping by module', () => {
    const { model: out } = arrange(model, { groupBy: 'module', collapse: [`${API}.module.logs`] })
    expect(byId(out).get(`${API}.module.logs`)?.group).toBe(API)
    expect(byId(out).get(`${API}.module.logs`)?.name).toBe('ecs_service["api"].logs')
  })

  it('keeps a shared group when every resource inside had the same one', () => {
    const { model: out } = arrange(model, { collapse: [WORKER] })
    expect(byId(out).get(WORKER)?.group).toBe('ecs')
    expect(byId(arrange(model, { collapse: [API] }).model).get(API)?.group).toBeUndefined()
  })

  it('shows the worst health inside a module as the module’s', () => {
    const { ctx } = arrange(model, {
      collapse: ['*'],
      health: { [`${API}.aws_ecs_service.this`]: 'degraded', [`${API}.aws_security_group.this`]: 'down' },
    })
    expect(ctx.health?.[API]).toBe('down')
    expect(ctx.health?.[WORKER]).toBeUndefined()
  })

  it('marks a module by what a change does inside it, calling out a replace', () => {
    const marks = (inside: Record<string, 'create' | 'update' | 'replace' | 'destroy'>) =>
      arrange(model, { collapse: [API], marks: inside }).ctx.marks?.[API]
    const all = (m: 'create' | 'destroy') => ({
      [`${API}.aws_ecs_service.this`]: m,
      [`${API}.aws_security_group.this`]: m,
      [`${API}.module.logs.aws_cloudwatch_log_group.this`]: m,
    })
    expect(marks(all('create'))).toBe('create')
    expect(marks(all('destroy'))).toBe('destroy')
    expect(marks({ [`${API}.aws_ecs_service.this`]: 'create' })).toBe('update')
    expect(marks({ [`${API}.aws_ecs_service.this`]: 'update', [`${API}.aws_security_group.this`]: 'replace' })).toBe('replace')
    expect(marks({})).toBeUndefined()
  })

  it('calls a merged relationship new or removed only when all of it is', () => {
    const edgeMarks = (marked: Array<{ from: string; to: string; mark: 'added' | 'removed' }>) =>
      arrange(model, { collapse: [API], edgeMarks: marked }).ctx.edgeMarks
    const a = { from: `${API}.aws_ecs_service.this`, to: 'module.network.aws_vpc.main' }
    const b = { from: `${API}.aws_security_group.this`, to: 'module.network.aws_vpc.main' }
    expect(edgeMarks([{ ...a, mark: 'added' }])).toEqual([])
    expect(edgeMarks([{ ...a, mark: 'added' }, { ...b, mark: 'added' }])).toEqual([
      { from: API, to: 'module.network.aws_vpc.main', mark: 'added' },
    ])
  })
})

describe('every engine draws the arrangement', () => {
  it('Graphviz and Mermaid draw the collapsed module, not what is inside it', () => {
    const dot = renderDot(model, { view: 'overview' })
    const mmd = renderMermaid(model, { view: 'overview' })
    expect(dot).toContain(`"${API.replace(/"/g, '\\"')}" [label=`)
    expect(dot).toContain('module · 3 resources')
    expect(dot).not.toContain('aws_security_group.this')
    expect(mmd).toContain('[["ecs_service[&quot;api&quot;]<br/>module · 3 resources"]]')
    expect(mmd).not.toContain('aws_security_group.this')
  })

  it('gives a collapsed module its own icon, and no provider kind that one', () => {
    expect(iconFor('module · 3 resources')).toBe('module')
    expect(iconFor('azurerm_api_management_module')).not.toBe('module')
  })
})

describe('a snapshot of collapsed modules', () => {
  const sources: SourcedModel[] = [{ provider: 'terraform', kind: 'declarative', model }]
  it('records which entities each collapsed node stands for, for the viewer', async () => {
    const { snapshot, files } = await takeSnapshot({
      subject: { app: 'shop' },
      observed: model,
      sources,
      engine: 'mermaid',
    })
    const overview = snapshot.diagrams.find((d) => d.view === 'overview')!
    expect(overview.members?.[API]).toHaveLength(3)
    expect(snapshot.diagrams.find((d) => d.view === 'services')?.members).toBeUndefined()
    expect(files[VIEWER_FILE]).toContain('"members":{')
  })

  it('collapses every diagram when asked to, where a view does not say', async () => {
    const { snapshot } = await takeSnapshot({
      subject: { app: 'shop' },
      observed: model,
      sources,
      engine: 'mermaid',
      collapse: ['module.ecs_service'],
    })
    expect(Object.keys(snapshot.diagrams[0]!.members ?? {}).sort()).toEqual([API, WORKER])
  })
})
