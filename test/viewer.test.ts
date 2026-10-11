import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import type { SourcedModel } from '../src/model/merge.js'
import { VIEWER_FILE, takeSnapshot } from '../src/snapshot.js'
import { renderViewer } from '../src/viewer.js'

const model = (partial: Partial<Model>): Model => Model.parse({ version: 1, name: 'shop', ...partial })
const sourced = (m: Model): SourcedModel[] => [{ provider: 'terraform', kind: 'declarative', model: m }]

const first = model({
  entities: [
    { id: 'aws_lb.api', kind: 'aws_lb', group: 'edge' },
    { id: 'aws_ecs_service.api', kind: 'aws_ecs_service', group: 'app' },
  ],
  edges: [{ from: 'aws_lb.api', to: 'aws_ecs_service.api' }],
})

const snap = (m: Model, extra: Partial<Parameters<typeof takeSnapshot>[0]> = {}) =>
  takeSnapshot({ subject: { app: 'orders-api', environment: 'prod', build: '7' }, observed: m, sources: sourced(m), engine: 'mermaid', ...extra })

/** The JSON the page's script reads, exactly as the browser would see it. */
function embedded(html: string): { snapshot: unknown; diagrams: unknown[] } {
  const match = html.match(/<script type="application\/json" id="driftwood-data">([\s\S]*?)<\/script>/)
  expect(match, 'the page carries its data inline').not.toBeNull()
  return JSON.parse(match![1]!)
}

describe('the snapshot viewer', () => {
  it('is written into every snapshot', async () => {
    const { files } = await snap(first)
    expect(files[VIEWER_FILE]).toMatch(/^<!doctype html>/)
  })

  it('carries the whole snapshot, so it needs nothing but a browser', async () => {
    const { snapshot, files } = await snap(first)
    const html = files[VIEWER_FILE]!
    expect(embedded(html).snapshot).toEqual(snapshot)
    // No CDN, no sibling asset: the store may be served from anywhere.
    expect(html).not.toMatch(/<script[^>]+src=/)
    expect(html).not.toMatch(/<link[^>]+href=/)
    expect(html).not.toContain('https://')
  })

  it('names the app, environment and build it shows', async () => {
    const { files } = await snap(first)
    expect(files[VIEWER_FILE]).toContain('<title>orders-api · prod · 7 · driftwood</title>')
  })

  it('inlines SVG diagrams without their XML prolog', async () => {
    const { snapshot } = await snap(first)
    const svg = '<?xml version="1.0"?>\n<!DOCTYPE svg>\n<svg viewBox="0 0 1 1"><g class="node"><title>aws_lb.api</title></g></svg>'
    const html = renderViewer({ ...snapshot, diagrams: [{ ...snapshot.diagrams[0]!, file: 'diagram.svg' }] }, { 'diagram.svg': svg })
    expect(html).toContain('<template id="diagram-0"><svg viewBox="0 0 1 1">')
    expect(html).not.toContain('<?xml')
  })

  it('shows non-SVG diagrams as escaped source', async () => {
    const { files } = await snap(first)
    expect(files[VIEWER_FILE]).toContain('<template id="diagram-0"><pre>flowchart LR')
  })

  it('cannot be broken out of by a hostile entity name', async () => {
    // Names come from someone's cloud account. One that closes the data
    // script would otherwise run as code on the build platform's page.
    const hostile = model({
      name: 'shop',
      entities: [{ id: 'x', kind: 'aws_s3_bucket', name: '</script><script>alert(1)</script>' }],
    })
    const { snapshot, files } = await snap(hostile)
    const html = files[VIEWER_FILE]!
    expect(html).not.toContain('<script>alert(1)')
    expect(embedded(html).snapshot).toEqual(snapshot)
  })

  it('escapes the heading too', async () => {
    const { files } = await snap(first, { subject: { app: '<b>x</b>', environment: 'prod' } })
    expect(files[VIEWER_FILE]).toContain('<h1>&lt;b&gt;x&lt;/b&gt; · prod</h1>')
  })

  it('summarises changes, drift and health in the header', async () => {
    const previous = (await snap(first)).snapshot
    const second = model({ ...first, entities: [...first.entities, { id: 'aws_sqs_queue.q', kind: 'aws_sqs_queue' }] })
    const { files } = await snap(second, {
      previous,
      declared: first,
      health: { 'aws_lb.api': 'down', 'aws_ecs_service.api': 'degraded' },
    })
    const html = files[VIEWER_FILE]!
    expect(html).toContain('<b>1</b> change since the last deploy')
    expect(html).toContain('differs from the committed design')
    expect(html).toContain('<b>1</b> down')
    expect(html).toContain('<b>1</b> degraded')
  })

  it('reaches the page only through textContent', async () => {
    // innerHTML is used only to clear containers; any other use could put
    // infrastructure-supplied text into the DOM as markup.
    const { files } = await snap(first)
    const script = files[VIEWER_FILE]!.split('<script>')[1]!
    for (const use of script.match(/innerHTML\s*=\s*[^;]+;/g) ?? []) expect(use).toMatch(/innerHTML\s*=\s*''/)
  })
})
