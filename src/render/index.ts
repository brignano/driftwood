import { Registry } from '../registry.js'
import type { Model } from '../model/schema.js'
import { mermaidRenderer } from './mermaid.js'
import { dotRenderer } from './dot.js'
import { graphvizRenderer } from './graphviz.js'
import type { Renderer, RenderContext } from './types.js'

export const renderers = new Registry<Renderer>('renderer')
renderers.register(graphvizRenderer)
renderers.register(mermaidRenderer)
renderers.register(dotRenderer)

export interface Resolved {
  renderer: Renderer
  via: string
  /** Set when `auto` wanted a higher-priority engine but it wasn't usable. */
  fellBackFrom?: string
}

/**
 * Picks a renderer. `auto` walks engines by priority and takes the first that
 * reports itself usable, so a machine with Graphviz gets Graphviz and a locked
 * down one silently gets Mermaid — same command, same config, no failure.
 */
export async function resolveRenderer(engine = 'auto'): Promise<Resolved> {
  if (engine !== 'auto') {
    const renderer = renderers.get(engine)
    const probe = await renderer.probe()
    if (!probe.available) {
      // An explicit choice fails loudly; only `auto` is allowed to substitute.
      throw new Error(`renderer '${engine}' is not available: ${probe.reason ?? 'unknown reason'}`)
    }
    return { renderer, via: probe.via ?? 'unknown' }
  }

  const ordered = [...renderers.all()].sort((a, b) => b.priority - a.priority)
  let skipped: string | undefined
  for (const renderer of ordered) {
    const probe = await renderer.probe()
    if (probe.available) {
      return { renderer, via: probe.via ?? 'unknown', fellBackFrom: skipped }
    }
    skipped ??= renderer.name
  }
  throw new Error('no renderer is available')
}

export async function render(model: Model, ctx: RenderContext = {}, engine = 'auto') {
  const resolved = await resolveRenderer(engine)
  return { ...resolved, output: await resolved.renderer.render(model, ctx) }
}

export { renderMermaid } from './mermaid.js'
export { renderDot } from './dot.js'
export { renderGraphvizSvg, detectTier, probeNativeDot } from './graphviz.js'
export { selectEntities } from './select.js'
export type { Renderer, RenderContext, Availability } from './types.js'
