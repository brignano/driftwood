import { describe, expect, it } from 'vitest'
import { Model } from '../src/model/schema.js'
import { renderDot } from '../src/render/dot.js'
import { renderMermaid } from '../src/render/mermaid.js'
import { graphvizRenderer, renderGraphvizSvg } from '../src/render/graphviz.js'
import {
  ICONS,
  MARKER_PREFIX,
  PALETTE,
  familyFor,
  iconFor,
  injectIcons,
  marker,
} from '../src/render/icons.js'

const model = (partial: Partial<Model>): Model => Model.parse({ version: 1, name: 't', ...partial })

describe('iconFor', () => {
  it('maps common infrastructure vocabularies to a category', () => {
    expect(iconFor('aws_s3_bucket')).toBe('storage')
    expect(iconFor('aws_sqs_queue')).toBe('queue')
    expect(iconFor('aws_sns_topic')).toBe('topic')
    expect(iconFor('aws_lambda_function')).toBe('function')
    expect(iconFor('aws_route53_record')).toBe('dns')
    expect(iconFor('aws_cloudfront_distribution')).toBe('cdn')
    expect(iconFor('aws_acm_certificate')).toBe('certificate')
    expect(iconFor('aws_iam_role')).toBe('identity')
    expect(iconFor('aws_secretsmanager_secret')).toBe('secret')
    expect(iconFor('aws_vpc')).toBe('network')
  })

  it('is not AWS-specific', () => {
    expect(iconFor('google_storage_bucket')).toBe('storage')
    expect(iconFor('azurerm_kubernetes_cluster')).toBe('cluster')
    expect(iconFor('k8s_deployment')).toBe('service')
    expect(iconFor('gcp_pubsub_subscription')).toBe('topic')
    expect(iconFor('SERVICE')).toBe('service')
    expect(iconFor('CLOUD_APPLICATION')).toBe('generic')
  })

  it('matches whole tokens, which `\\b` cannot do around underscores', () => {
    expect(iconFor('aws_ses_receipt_rule')).toBe('email')
    expect(iconFor('aws_kms_key')).toBe('secret')
    expect(iconFor('aws_msk_cluster')).toBe('queue')
    // ...without matching the same letters inside a longer word.
    expect(iconFor('aws_sesame_widget')).not.toBe('email')
    expect(iconFor('aws_keystone_widget')).not.toBe('secret')
  })

  /**
   * Ordering, not the patterns themselves, is what makes this table work.
   * Every case here is one where a later pattern would also match and give a
   * visibly wrong glyph, so these are the ones that pin the order.
   */
  it('resolves patterns that overlap in favour of the more specific one', () => {
    expect(iconFor('aws_elasticache_cluster')).toBe('cache') // not a Kubernetes cluster
    expect(iconFor('aws_db_instance')).toBe('database') // not an EC2 instance
    expect(iconFor('aws_db_subnet_group')).toBe('database') // not a subnet
    expect(iconFor('aws_security_group')).toBe('firewall') // not a target group
    expect(iconFor('aws_ecs_cluster')).toBe('cluster')
    expect(iconFor('aws_ecs_service')).toBe('service')
    expect(iconFor('aws_ecs_task_definition')).toBe('container')
    expect(iconFor('aws_lb_target_group')).toBe('loadbalancer')
    expect(iconFor('aws_lb_listener')).toBe('loadbalancer')
    expect(iconFor('aws_nat_gateway')).toBe('network') // not an API gateway
    expect(iconFor('aws_kms_key')).toBe('secret')
    expect(iconFor('aws_cloudwatch_log_group')).toBe('monitoring')
    expect(iconFor('aws_lambda_event_source_mapping')).toBe('events')
  })

  it('falls back rather than throwing on a kind it has never seen', () => {
    // `kind` is an open string by design, so unknown is normal, not an error.
    expect(iconFor('some_vendor_widget')).toBe('generic')
    expect(iconFor('')).toBe('generic')
  })

  it('gives every icon a drawable body and a palette entry', () => {
    for (const [key, icon] of Object.entries(ICONS)) {
      expect(icon.body, key).toMatch(/^<(circle|rect|path|ellipse)/)
      expect(PALETTE[icon.family], key).toBeDefined()
    }
  })
})

describe('renderDot icon markers', () => {
  const m = model({
    entities: [
      { id: 'a', kind: 'aws_s3_bucket', name: 'bucket', group: 's3' },
      { id: 'b', kind: 'aws_sqs_queue', name: 'queue', group: 'sqs' },
    ],
  })

  it('leaves DOT source marker-free by default, so any Graphviz can render it', () => {
    expect(renderDot(m)).not.toContain(MARKER_PREFIX)
  })

  it('emits exactly one marker per entity when icons are asked for', () => {
    const dot = renderDot(m, { icons: true })
    expect(dot.split(MARKER_PREFIX)).toHaveLength(3)
    expect(dot).toContain(marker('storage'))
    expect(dot).toContain(marker('queue'))
  })

  it('colours a node by its family', () => {
    const dot = renderDot(m)
    expect(dot).toContain(`fillcolor="${PALETTE.data.tint}" color="${PALETTE.data.accent}"`)
    expect(dot).toContain(`fillcolor="${PALETTE.messaging.tint}" color="${PALETTE.messaging.accent}"`)
  })

  it('lets a health overlay override the family colour without touching the model', () => {
    const dot = renderDot(m, { health: { a: 'down' } })
    expect(dot).toContain('#dc2626')
    expect(m.entities[0]).not.toHaveProperty('health')
  })

  it('strips the marker prefix out of model-supplied text', () => {
    // A model is data. Data must not be able to place artwork in the output.
    const hostile = model({ entities: [{ id: 'x', kind: 'service', name: `${marker('secret')}pwn` }] })
    const dot = renderDot(hostile, { icons: true })
    expect(dot).not.toContain(marker('secret'))
    expect(dot).toContain('pwn')
    expect(dot.split(MARKER_PREFIX)).toHaveLength(2) // only the reserved cell
  })
})

describe('injectIcons', () => {
  // Trimmed to the shape Graphviz actually emits: a node group whose outline
  // fixes the horizontal centre and whose marker text fixes the baseline.
  const node = (key: string, id = 'a') =>
    `<g id="node1" class="node">\n<title>${id}</title>\n` +
    `<path fill="#ecfdf5" stroke="#059669" d="M100,-50C100,-50 20,-50 20,-50 20,-10 100,-10 100,-50"/>\n` +
    `<text xml:space="preserve" text-anchor="start" x="47.2" y="-40" font-size="1.00">${marker(key as never)}</text>\n</g>`

  it('replaces a marker with artwork centred on the node', () => {
    const out = injectIcons(node('database'))
    expect(out).not.toContain(MARKER_PREFIX)
    expect(out).toContain('class="driftwood-icon"')
    // Node spans x 20..100, so the icon's 24pt box starts 12 left of centre.
    expect(out).toContain('translate(48 -52)')
  })

  it('colours the icon from the caller-supplied lookup, keyed by entity id', () => {
    const out = injectIcons(node('database'), (id) => (id === 'a' ? '#059669' : '#000000'))
    expect(out).toContain('stroke="#059669"')
  })

  it('resolves XML entities in the node title before looking the id up', () => {
    // Graphviz writes `aws_db.a-b` as `aws_db.a&#45;b`.
    const seen: string[] = []
    injectIcons(node('database', 'aws_db.a&#45;b'), (id) => {
      seen.push(id)
      return '#000000'
    })
    expect(seen).toEqual(['aws_db.a-b'])
  })

  it('passes an SVG with no markers through untouched', () => {
    const svg = '<svg><g id="node1" class="node"><title>a</title><ellipse cx="5" cy="5" rx="2" ry="2"/></g></svg>'
    expect(injectIcons(svg)).toBe(svg)
  })

  it('removes a marker it cannot place rather than leaving it visible', () => {
    const orphan = `<g id="node1" class="node">\n<title>a</title>\n` +
      `<text x="1" y="-1" font-size="1.00">${marker('generic')}</text>\n</g>`
    const out = injectIcons(orphan)
    expect(out).not.toContain(MARKER_PREFIX)
  })
})

describe('renderGraphvizSvg', () => {
  it('draws an icon per node, or degrades honestly where WebAssembly is off', async () => {
    const m = model({
      entities: [
        { id: 'a', kind: 'aws_db_instance', name: 'orders', group: 'db' },
        { id: 'b', kind: 'aws_lambda_function', name: 'worker', group: 'lambda' },
      ],
      edges: [{ from: 'b', to: 'a', kind: 'depends-on' }],
    })

    if (!(await graphvizRenderer.probe()).available) {
      await expect(renderGraphvizSvg(m)).rejects.toThrow(/WebAssembly/)
      return
    }

    const svg = await renderGraphvizSvg(m)
    expect(svg).toContain('<svg')
    expect(svg).not.toContain(MARKER_PREFIX)
    expect(svg.match(/class="driftwood-icon"/g)).toHaveLength(2)
    expect(svg).toContain(`stroke="${PALETTE.data.accent}"`)
    expect(svg).toContain(`stroke="${PALETTE.compute.accent}"`)

    // Self-contained: no external references, so it survives being pasted
    // anywhere. That is the whole reason the icons are inlined.
    expect(svg).not.toContain('<image')
    expect(svg).not.toMatch(/xlink:href="(?!#)/)

    const plain = await renderGraphvizSvg(m, { icons: false })
    expect(plain).not.toContain('driftwood-icon')
    expect(plain).not.toContain(MARKER_PREFIX)
  })
})

describe('renderMermaid families', () => {
  it('classifies nodes with the same table the Graphviz renderer uses', () => {
    const m = model({ entities: [{ id: 'a', kind: 'aws_db_instance', name: 'orders' }] })
    const out = renderMermaid(m)
    expect(familyFor('aws_db_instance')).toBe('data')
    expect(out).toContain('class n_a f_data;')
    expect(out).toContain(`classDef f_data fill:${PALETTE.data.tint},stroke:${PALETTE.data.accent}`)
  })

  it('puts the health overlay after the family class so health wins', () => {
    const m = model({ entities: [{ id: 'a', kind: 'aws_db_instance' }] })
    const out = renderMermaid(m, { health: { a: 'down' } })
    expect(out.indexOf('class n_a f_data;')).toBeLessThan(out.indexOf('class n_a down;'))
  })
})
