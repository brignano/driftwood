import type { Entity, Model, View } from '../model/schema.js'
import { matches } from '../model/validate.js'

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

type ShapeFamily = 'storage' | 'messaging' | 'network' | 'identity' | 'compute'

const KIND_PATTERNS: Array<[RegExp, ShapeFamily]> = [
  [/(s3|bucket|rds|dynamodb|db|database|efs|volume|storage)/i, 'storage'],
  [/(sqs|sns|queue|topic|kinesis|kafka|eventbridge)/i, 'messaging'],
  [/(route53|dns|cloudfront|vpc|subnet|lb|gateway|cdn|zone|record)/i, 'network'],
  [/(iam|role|policy|secret|kms|cert|acm|auth)/i, 'identity'],
  [/(lambda|ec2|ecs|function|instance|service|container|app)/i, 'compute'],
]

function shapeFor(kind: string): ShapeFamily {
  for (const [pattern, family] of KIND_PATTERNS) {
    if (pattern.test(kind)) return family
  }
  return 'compute'
}

function renderNode(e: Entity): string {
  const label = escapeLabel(`${e.name ?? e.id}\n${e.kind}`)
  const id = nodeId(e.id)
  switch (shapeFor(e.kind)) {
    case 'storage':
      return `${id}[("${label}")]`
    case 'messaging':
      return `${id}[/"${label}"/]`
    case 'network':
      return `${id}("${label}")`
    case 'identity':
      return `${id}{{"${label}"}}`
    default:
      return `${id}["${label}"]`
  }
}

export function selectEntities(model: Model, view?: View): Entity[] {
  if (!view) return model.entities
  return model.entities.filter((e) => {
    const target = [e.id, e.group ?? '']
    const included =
      view.include.length === 0 || view.include.some((p) => target.some((t) => t !== '' && matches(p, t)))
    const excluded = view.exclude.some((p) => target.some((t) => t !== '' && matches(p, t)))
    return included && !excluded
  })
}

export interface RenderOptions {
  view?: string
  direction?: 'LR' | 'TD'
  /** Runtime health, applied at render time. Never committed to the model. */
  health?: Record<string, 'healthy' | 'degraded' | 'down'>
}

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
