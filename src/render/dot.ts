import type { Entity, Model } from '../model/schema.js'
import { defineRenderer } from './types.js'
import type { RenderContext } from './types.js'
import { selectEntities } from './select.js'
import { ICON_SIZE, MARKER_PREFIX, iconFor, marker, styleFor } from './icons.js'

/**
 * Graphviz DOT source.
 *
 * Emitting DOT needs no Graphviz installed — it's just text. That distinction
 * matters: `dot` (this renderer) always works, while `graphviz` (rendering DOT
 * to SVG) needs an engine. So even a locked-down machine can produce DOT for
 * someone else to render, and nothing is lost by not having the binary.
 *
 * Nodes are HTML-like labels rather than plain `label="a\nb"` strings for two
 * reasons. It allows a name/kind type hierarchy — one line at reading size and
 * one small and muted — instead of two lines competing at the same weight; and
 * it allows a fixed-size cell to be reserved for an icon (see `icons.ts`),
 * which Graphviz then accounts for during layout. Both are what stop nodes
 * coming out as long flat slabs: a box holding an icon above two short lines
 * is roughly 3:2, while one holding a single wide line of text is closer to
 * 6:1, and a graph full of 6:1 boxes is what reads as "squashed".
 */

const INK = '#0f172a'
const MUTED = '#64748b'
const CLUSTER_LINE = '#dbe2ea'
const CLUSTER_FILL = '#f8fafc'
const EDGE_COLOR = '#94a3b8'

/** Border and fill applied on top of the family colours when health is known. */
const HEALTH_COLORS: Record<string, { accent: string; tint: string }> = {
  healthy: { accent: '#16a34a', tint: '#f0fdf4' },
  degraded: { accent: '#d97706', tint: '#fffbeb' },
  down: { accent: '#dc2626', tint: '#fef2f2' },
}

function quote(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * HTML-like labels are parsed as XML, so the five entity references matter —
 * an unescaped `&` in a name is a hard parse error, not a cosmetic problem.
 * The icon marker prefix is stripped here too: a model is data, and data must
 * not be able to place its own artwork in the output.
 */
function xml(text: string): string {
  return text
    .split(MARKER_PREFIX)
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function renderDot(model: Model, ctx: RenderContext = {}): string {
  const view = ctx.view ? model.views.find((v) => v.id === ctx.view) : undefined
  if (ctx.view && !view) {
    throw new Error(`unknown view: ${ctx.view} (have: ${model.views.map((v) => v.id).join(', ') || 'none'})`)
  }

  // Off by default: DOT source is meant to be renderable by any Graphviz, and
  // a marker only becomes artwork if driftwood post-processes the SVG itself.
  const withIcons = ctx.icons === true
  const entities = selectEntities(model, view)
  const visible = new Set(entities.map((e) => e.id))

  const lines: string[] = [
    `digraph "${quote(model.name)}" {`,
    `  graph [rankdir=${ctx.direction === 'TD' ? 'TB' : 'LR'} fontname="Helvetica" fontsize=11 bgcolor="white"`,
    '         nodesep=0.35 ranksep=0.75 pad=0.3 newrank=true];',
    '  node [shape=box style="rounded,filled" fontname="Helvetica" margin=0.06 penwidth=1.2];',
    `  edge [fontname="Helvetica" fontsize=9 fontcolor="${MUTED}" color="${EDGE_COLOR}" penwidth=1.1 arrowsize=0.7];`,
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
    const health = ctx.health?.[e.id]
    const style = (health ? HEALTH_COLORS[health] : undefined) ?? styleFor(e.kind)
    const penwidth = health ? 2.2 : 1.2
    const rows: string[] = []
    if (withIcons) {
      // A fixed-size cell so Graphviz reserves exactly the room the icon will
      // occupy; the 1pt marker inside it is what `injectIcons` finds and
      // replaces, and is invisible if it somehow survives.
      rows.push(
        `<TR><TD FIXEDSIZE="TRUE" WIDTH="${ICON_SIZE + 10}" HEIGHT="${ICON_SIZE + 6}">` +
          `<FONT POINT-SIZE="1" COLOR="${CLUSTER_FILL}">${marker(iconFor(e.kind))}</FONT></TD></TR>`,
      )
    }
    rows.push(`<TR><TD><FONT POINT-SIZE="11" COLOR="${INK}"><B>${xml(e.name ?? e.id)}</B></FONT></TD></TR>`)
    rows.push(`<TR><TD><FONT POINT-SIZE="8" COLOR="${MUTED}">${xml(e.kind)}</FONT></TD></TR>`)
    const label = `<<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="1">${rows.join('')}</TABLE>>`
    return (
      `${indent}"${quote(e.id)}" [label=${label} fillcolor="${style.tint}" ` +
      `color="${style.accent}" penwidth=${penwidth}];`
    )
  }

  let clusterIndex = 0
  for (const [group, members] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  subgraph cluster_${clusterIndex++} {`)
    lines.push(`    label=<<FONT POINT-SIZE="11" COLOR="${MUTED}">${xml(group)}</FONT>>;`)
    lines.push(`    style="rounded,filled"; fillcolor="${CLUSTER_FILL}"; color="${CLUSTER_LINE}";`)
    lines.push('    penwidth=1; labeljust=l; margin=14;')
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
