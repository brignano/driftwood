import type { Entity, Model } from '../model/schema.js'
import { PALETTE, familyFor, iconFor } from './icons.js'
import type { Family, IconKey } from './icons.js'
import { selectEntities } from './select.js'
import { defineRenderer } from './types.js'
import type { RenderContext } from './types.js'

/**
 * Mermaid is the default renderer for one reason: it renders natively in
 * GitHub and GitLab markdown, so the reader installs nothing. No Graphviz
 * binary, no system package, no software-center ticket.
 */

/** Mermaid node ids can't contain dots, brackets, or quotes. */
function nodeId(id: string): string {
  return 'n_' + id.replace(/[^a-zA-Z0-9_]/g, '_')
}

function escapeLabel(text: string): string {
  // Mermaid renders <br/> inside a quoted label; a raw newline breaks parsing.
  return text.replace(/"/g, '&quot;').replace(/\n/g, '<br/>')
}

/**
 * Mermaid has no icon primitive, so the same categorisation that picks an icon
 * for the Graphviz renderer picks a shape and a colour here. Sharing it is the
 * point: a queue must not be a cylinder in one engine and a parallelogram in
 * the other, or the two pictures stop describing the same system.
 */
const SHAPES: Partial<Record<IconKey, (id: string, label: string) => string>> = {
  database: (id, l) => `${id}[("${l}")]`,
  storage: (id, l) => `${id}[("${l}")]`,
  cache: (id, l) => `${id}[("${l}")]`,
  queue: (id, l) => `${id}[/"${l}"/]`,
  topic: (id, l) => `${id}[/"${l}"/]`,
  events: (id, l) => `${id}[/"${l}"/]`,
  email: (id, l) => `${id}[/"${l}"/]`,
  dns: (id, l) => `${id}("${l}")`,
  cdn: (id, l) => `${id}("${l}")`,
  network: (id, l) => `${id}("${l}")`,
  loadbalancer: (id, l) => `${id}("${l}")`,
  api: (id, l) => `${id}("${l}")`,
  identity: (id, l) => `${id}{{"${l}"}}`,
  secret: (id, l) => `${id}{{"${l}"}}`,
  certificate: (id, l) => `${id}{{"${l}"}}`,
  firewall: (id, l) => `${id}{{"${l}"}}`,
}

function renderNode(e: Entity): string {
  const label = escapeLabel(`${e.name ?? e.id}\n${e.kind}`)
  const id = nodeId(e.id)
  const shape = SHAPES[iconFor(e.kind)]
  return shape ? shape(id, label) : `${id}["${label}"]`
}

export type RenderOptions = RenderContext

export function renderMermaid(model: Model, opts: RenderOptions = {}): string {
  const view = opts.view ? model.views.find((v) => v.id === opts.view) : undefined
  if (opts.view && !view) {
    throw new Error(`unknown view: ${opts.view} (have: ${model.views.map((v) => v.id).join(', ') || 'none'})`)
  }

  const entities = selectEntities(model, view)
  const visible = new Set(entities.map((e) => e.id))
  const lines: string[] = [`flowchart ${opts.direction ?? 'LR'}`]

  // Group into subgraphs; ungrouped entities are emitted at the top level.
  const grouped = new Map<string, Entity[]>()
  const ungrouped: Entity[] = []
  for (const e of entities) {
    if (e.group) {
      const list = grouped.get(e.group) ?? []
      list.push(e)
      grouped.set(e.group, list)
    } else {
      ungrouped.push(e)
    }
  }

  for (const [group, members] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`    subgraph ${nodeId(group)}["${escapeLabel(group)}"]`)
    for (const e of members) lines.push(`        ${renderNode(e)}`)
    lines.push('    end')
  }
  for (const e of ungrouped) lines.push(`    ${renderNode(e)}`)

  // An edge is only drawn when both ends survived the view filter.
  for (const edge of model.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue
    const label = edge.label ? `|"${escapeLabel(edge.label)}"|` : ''
    lines.push(`    ${nodeId(edge.from)} -->${label} ${nodeId(edge.to)}`)
  }

  // Family colours, matching the Graphviz renderer's palette. Emitted before
  // the health overlay so that health, being the more urgent fact, wins.
  const families = new Set<Family>()
  for (const e of entities) {
    const family = familyFor(e.kind)
    families.add(family)
    lines.push(`    class ${nodeId(e.id)} f_${family};`)
  }
  for (const family of [...families].sort()) {
    const { accent, tint } = PALETTE[family]
    lines.push(`    classDef f_${family} fill:${tint},stroke:${accent},color:#0f172a;`)
  }

  if (opts.health) {
    lines.push('')
    for (const [id, status] of Object.entries(opts.health)) {
      if (!visible.has(id)) continue
      lines.push(`    class ${nodeId(id)} ${status};`)
    }
    lines.push('    classDef healthy fill:#0b6b3a,stroke:#0f9d58,color:#fff;')
    lines.push('    classDef degraded fill:#7a5b00,stroke:#f4b400,color:#fff;')
    lines.push('    classDef down fill:#7a1c1c,stroke:#db4437,color:#fff;')
  }

  return lines.join('\n') + '\n'
}

export const mermaidRenderer = defineRenderer({
  name: 'mermaid',
  description: 'Mermaid flowchart — renders natively in GitHub, zero install',
  extension: 'mmd',
  priority: 50,
  async probe() {
    // Always available: it is string generation with no engine behind it.
    return { available: true, via: 'built-in' }
  },
  async render(model, ctx) {
    return renderMermaid(model, ctx)
  },
})
