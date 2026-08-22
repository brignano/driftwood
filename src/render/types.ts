import type { Model } from '../model/schema.js'

export interface RenderContext {
  view?: string
  direction?: 'LR' | 'TD'
  /** Runtime health, applied at render time. Never committed to the model. */
  health?: Record<string, 'healthy' | 'degraded' | 'down'>
}

export interface Availability {
  available: boolean
  /** How it will render, e.g. 'native dot binary', 'wasm', 'built-in'. */
  via?: string
  /** Why it isn't available, and what to do about it. */
  reason?: string
}

/**
 * The renderer extension point.
 *
 * `probe()` is what makes graceful degradation possible: a renderer reports
 * whether it can actually run in this environment, so `--engine auto` can pick
 * the best available one instead of failing. That is the whole answer to
 * "Graphviz if we can install it, Mermaid if we can't".
 */
export interface Renderer {
  name: string
  description: string
  /** File extension for the output, without a dot. */
  extension: string
  /** Higher wins under `--engine auto`. */
  priority: number
  probe(): Promise<Availability>
  render(model: Model, ctx: RenderContext): Promise<string>
}

export function defineRenderer(r: Renderer): Renderer {
  return r
}
