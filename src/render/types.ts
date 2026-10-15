import type { Model } from '../model/schema.js'
import type { HealthMap } from '../health.js'
import type { GroupBy } from '../model/schema.js'

export type { GroupBy }

export interface RenderContext {
  view?: string
  direction?: 'LR' | 'TD'
  /** Runtime health, applied at render time. Never committed to the model. */
  health?: HealthMap
  /**
   * Draw category icons on nodes. Only renderers that produce final artwork
   * honour this — Mermaid has no icon primitive, and raw DOT source has no
   * post-processing step to turn a marker into a picture.
   */
  icons?: boolean
  /**
   * What a pending change will do to each entity, by id, using Terraform's own
   * verbs. Like health, an overlay applied at render time. Only Mermaid draws
   * it today, because a plan preview is posted where Mermaid renders in place.
   */
  marks?: Record<string, ChangeMark>
  /**
   * Relationships a pending change adds or removes. A removed one must still
   * be in the model to be drawn, and is drawn dashed, so a picture of the
   * plan never shows a dependency that is going away as one that stays.
   */
  edgeMarks?: EdgeMark[]
  /** How nodes are boxed when the view does not say. Defaults to `group`. */
  groupBy?: GroupBy
  /** Modules to draw as one node each when the view does not say. See `View.collapse`. */
  collapse?: string[]
}

export interface EdgeMark {
  from: string
  to: string
  mark: 'added' | 'removed'
}

export type ChangeMark = 'create' | 'update' | 'replace' | 'destroy'

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
