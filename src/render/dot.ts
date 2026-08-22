import type { Entity, Model } from '../model/schema.js'
import { defineRenderer } from './types.js'
import type { RenderContext } from './types.js'
import { selectEntities } from './select.js'

/**
 * Graphviz DOT source.
 *
 * Emitting DOT needs no Graphviz installed — it's just text. That distinction
 * matters: `dot` (this renderer) always works, while `graphviz` (rendering DOT
 * to SVG) needs an engine. So even a locked-down machine can produce DOT for
 * someone else to render, and nothing is lost by not having the binary.
 */

function quote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

const SHAPES: Array<[RegExp, string]> = [
  [/(s3|bucket|rds|dynamodb|database|efs|volume|storage)/i, 'cylinder'],
  [/(sqs|sns|queue|topic|kinesis|kafka|eventbridge)/i, 'parallelogram'],
  [/(route53|dns|cloudfront|vpc|subnet|lb|gateway|cdn|zone|record)/i, 'ellipse'],
  [/(iam|role|policy|secret|kms|cert|acm|auth)/i, 'hexagon'],
]

function shapeFor(kind: string): string {
  for (const [pattern, shape] of SHAPES) if (pattern.test(kind)) return shape
  return 'box'
}

const HEALTH_COLORS: Record<string, string> = {
  healthy: '#0f9d58',
  degraded: '#f4b400',
  down: '#db4437',
}

export function renderDot(model: Model, ctx: RenderContext = {}): string {
  const view = ctx.view ? model.views.find((v) => v.id === ctx.view) : undefined
  if (ctx.view && !view) {
    throw new Error(`unknown view: ${ctx.view} (have: ${model.views.map((v) => v.id).join(', ') || 'none'})`)
  }

  const entities = selectEntities(model, view)
  const visible = new Set(entities.map((e) => e.id))
  const lines: string[] = [
    `digraph "${quote(model.name)}" {`,
    `  rankdir=${ctx.direction === 'TD' ? 'TB' : 'LR'};`,
    '  node [fontname="Helvetica" style=filled fillcolor="#ffffff"];',
    '  edge [fontname="Helvetica" color="#666666"];',
  ]

  const grouped = new Map<string, Entity[]>()
  const ungrouped: Entity[] = []
  for (const e of entities) {
    if (e.group) {
      const list = grouped.get(e.group) ?? []
      list.push(e)
      grouped.set(e.group, list)
    } else ungrouped.push(e)
  }

  const nodeLine = (e: Entity, indent: string): string => {
    const label = `${e.name ?? e.id}\\n${e.kind}`
    const health = ctx.health?.[e.id]
    const color = health ? ` fillcolor="${HEALTH_COLORS[health]}" fontcolor="#ffffff"` : ''
    return `${indent}"${quote(e.id)}" [label="${quote(label)}" shape=${shapeFor(e.kind)}${color}];`
  }

  let clusterIndex = 0
  for (const [group, members] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph cluster_${clusterIndex++} {`)
    lines.push(`    label="${quote(group)}";`)
    lines.push('    style=rounded; color="#999999";')
    for (const e of members) lines.push(nodeLine(e, '    '))
    lines.push('  }')
  }
  for (const e of ungrouped) lines.push(nodeLine(e, '  '))

  for (const edge of model.edges) {
    if (!visible.has(edge.from) || !visible.has(edge.to)) continue
    const label = edge.label ? ` [label="${quote(edge.label)}"]` : ''
    lines.push(`  "${quote(edge.from)}" -> "${quote(edge.to)}"${label};`)
  }

  lines.push('}')
  return lines.join('\n') + '\n'
}

export const dotRenderer = defineRenderer({
  name: 'dot',
  description: 'Graphviz DOT source (no Graphviz installation required)',
  extension: 'dot',
  priority: 10,
  async probe() {
    return { available: true, via: 'built-in' }
  },
  async render(model, ctx) {
    return renderDot(model, ctx)
  },
})
