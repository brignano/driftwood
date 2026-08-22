import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import { renderMermaid } from '../src/render/mermaid.js'
import { selectEntities } from '../src/render/select.js'

const model = Model.parse({
  version: 1,
  name: 'test',
  entities: [
    { id: 'aws_s3_bucket.emails', kind: 'aws_s3_bucket', name: 'emails', group: 's3' },
    { id: 'aws_lambda_function.fn', kind: 'aws_lambda_function', name: 'fn', group: 'lambda' },
    { id: 'aws_iam_role.exec', kind: 'aws_iam_role', name: 'exec', group: 'iam' },
    { id: 'loose', kind: 'service', name: 'loose' },
  ],
  edges: [{ from: 'aws_lambda_function.fn', to: 'aws_s3_bucket.emails', kind: 'depends-on' }],
  views: [
    { id: 'storage-only', include: ['s3'] },
    { id: 'no-iam', include: ['*'], exclude: ['iam'] },
  ],
})

describe('renderMermaid', () => {
  it('emits a flowchart header with the requested direction', () => {
    expect(renderMermaid(model)).toMatch(/^flowchart LR\n/)
    expect(renderMermaid(model, { direction: 'TD' })).toMatch(/^flowchart TD\n/)
  })

  it('sanitizes ids that Mermaid cannot parse', () => {
    const out = renderMermaid(model)
    expect(out).toContain('n_aws_s3_bucket_emails')
    expect(out).not.toMatch(/^\s+aws_s3_bucket\.emails\[/m)
  })

  it('wraps grouped entities in subgraphs and leaves ungrouped ones loose', () => {
    const out = renderMermaid(model)
    expect(out).toContain('subgraph n_s3["s3"]')
    expect(out).toContain('n_loose["loose')
  })

  it('picks a cylinder for storage and a hexagon for identity', () => {
    const out = renderMermaid(model)
    expect(out).toMatch(/n_aws_s3_bucket_emails\[\("/)
    expect(out).toMatch(/n_aws_iam_role_exec\{\{"/)
  })

  it('renders edges between visible nodes', () => {
    expect(renderMermaid(model)).toContain('n_aws_lambda_function_fn --> n_aws_s3_bucket_emails')
  })

  it('drops edges whose other end was filtered out by the view', () => {
    const out = renderMermaid(model, { view: 'storage-only' })
    expect(out).not.toContain('-->')
  })

  it('throws on an unknown view rather than silently rendering everything', () => {
    expect(() => renderMermaid(model, { view: 'nope' })).toThrow(/unknown view/)
  })

  it('applies health classes only as a render-time overlay', () => {
    const out = renderMermaid(model, { health: { 'aws_s3_bucket.emails': 'down' } })
    expect(out).toContain('class n_aws_s3_bucket_emails down;')
    expect(out).toContain('classDef down')
    // The model itself is untouched by the overlay.
    expect(model.entities.find((e) => e.id === 'aws_s3_bucket.emails')).not.toHaveProperty('health')
  })

  it('renders the kind on a second line using <br/>', () => {
    // A raw newline inside a Mermaid label is a parse error, and collapsing it
    // to a space loses the two-line node layout entirely.
    expect(renderMermaid(model)).toContain('emails<br/>aws_s3_bucket')
  })

  it('escapes quotes in labels', () => {
    const m = Model.parse({
      version: 1,
      name: 't',
      entities: [{ id: 'a', kind: 'service', name: 'say "hi"' }],
    })
    expect(renderMermaid(m)).toContain('&quot;hi&quot;')
  })
})

describe('selectEntities', () => {
  it('returns everything when no view is given', () => {
    expect(selectEntities(model)).toHaveLength(4)
  })

  it('includes by group pattern', () => {
    const view = model.views.find((v) => v.id === 'storage-only')!
    expect(selectEntities(model, view).map((e) => e.id)).toEqual(['aws_s3_bucket.emails'])
  })

  it('applies exclude after include', () => {
    const view = model.views.find((v) => v.id === 'no-iam')!
    expect(selectEntities(model, view).map((e) => e.id)).not.toContain('aws_iam_role.exec')
  })
})
