import type { Entity, Model } from '../model/schema.js'
import { PALETTE, familyFor, iconFor, kindLabel } from './icons.js'
import type { Family, IconKey } from './icons.js'
import { selectEntities } from './select.js'
import { defineRenderer } from './types.js'
import type { ChangeMark, RenderContext } from './types.js'

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
  // Labels render as HTML, and names come from infrastructure: a bucket called
  // `<img onerror=...>` must show as text. Then newlines become the one tag
  // Mermaid is meant to see, since a raw newline breaks parsing.
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br/>')
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

/** Terraform's plan symbols, so the label reads the way `terraform plan` prints. */
const MARK_LABELS: Record<ChangeMark, string> = {
  create: '+ create',
  update: '~ update',
  replace: '-/+ replace',
  destroy: '- destroy',
}

/**
 * Outlines only, so the family fill still says what a thing is and health,
 * when both are drawn, still owns the fill. Destroy is dashed as well as red:
 * colour alone must not carry the meaning.
 */
const MARK_STYLES: Record<ChangeMark, string> = {
  create: 'stroke:#7c3aed,stroke-width:3px',
  update: 'stroke:#0891b2,stroke-width:3px',
  replace: 'stroke:#d97706,stroke-width:3px',
  destroy: 'stroke:#dc2626,stroke-width:3px,stroke-dasharray:6 4',
}

function renderNode(e: Entity, mark?: ChangeMark): string {
  const lines = [e.name ?? e.id, kindLabel(e.kind, e.platform), ...(mark ? [MARK_LABELS[mark]] : [])]
  const label = escapeLabel(lines.join('\n'))
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
    for (const e of members) lines.push(`        ${renderNode(e, opts.marks?.[e.id])}`)
    lines.push('    end')
  }
  for (const e of ungrouped) lines.push(`    ${renderNode(e, opts.marks?.[e.id])}`)

  // An edge is only drawn when both ends survived the view filter. Mermaid
  // styles links by their position, so the index of each marked one is kept.
  const edgeMarks = new Map((opts.edgeMarks ?? []).map((m) => [`${m.from}\u0000${m.to}`, m.mark]))
  const linkStyles: string[] = []
  let index = 0
  for (const edge of model.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue
    const label = edge.label ? `|"${escapeLabel(edge.label)}"|` : ''
    const mark = edgeMarks.get(`${edge.from}\u0000${edge.to}`)
    const arrow = mark === 'removed' ? '-.->' : mark === 'added' ? '==>' : '-->'
    lines.push(`    ${nodeId(edge.from)} ${arrow}${label} ${nodeId(edge.to)}`)
    // No hex colour right before a `;`: Mermaid reads `#7c3aed;` as an entity code.
    if (mark) linkStyles.push(`    linkStyle ${index} stroke:${mark === 'added' ? '#7c3aed' : '#dc2626'},stroke-width:2px`)
    index++
  }
  lines.push(...linkStyles)

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

  if (opts.marks) {
    const used = new Set<ChangeMark>()
    lines.push('')
    for (const [id, mark] of Object.entries(opts.marks)) {
      if (!visible.has(id)) continue
      used.add(mark)
      lines.push(`    class ${nodeId(id)} mark_${mark};`)
    }
    for (const mark of [...used].sort()) lines.push(`    classDef mark_${mark} ${MARK_STYLES[mark]};`)
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
