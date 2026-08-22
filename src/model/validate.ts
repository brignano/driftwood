import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { Model } from './schema.js'

export interface Issue {
  severity: 'error' | 'warning'
  message: string
}

export interface ValidationResult {
  ok: boolean
  model?: Model
  issues: Issue[]
}

/** Matches an id or group against a pattern supporting a trailing `*`. */
export function matches(pattern: string, value: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('*')) return value.startsWith(pattern.slice(0, -1))
  return pattern === value
}

/**
 * Schema validation alone isn't enough — a model can be well-formed YAML and
 * still be nonsense (an edge pointing at an entity that doesn't exist, two
 * entities sharing an id). Those are the failures that would produce a broken
 * diagram silently, so they're errors, not warnings.
 */
export function validateModel(raw: unknown): ValidationResult {
  const parsed = Model.safeParse(raw)
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        severity: 'error' as const,
        message: `${i.path.join('.') || '(root)'}: ${i.message}`,
      })),
    }
  }

  const model = parsed.data
  const issues: Issue[] = []
  const ids = new Set<string>()

  for (const e of model.entities) {
    if (ids.has(e.id)) {
      issues.push({ severity: 'error', message: `duplicate entity id: ${e.id}` })
    }
    ids.add(e.id)
  }

  for (const edge of model.edges) {
    if (!ids.has(edge.from)) {
      issues.push({ severity: 'error', message: `edge references unknown entity: ${edge.from} (in ${edge.from} -> ${edge.to})` })
    }
    if (!ids.has(edge.to)) {
      issues.push({ severity: 'error', message: `edge references unknown entity: ${edge.to} (in ${edge.from} -> ${edge.to})` })
    }
    if (edge.from === edge.to) {
      issues.push({ severity: 'warning', message: `self-referencing edge on ${edge.from}` })
    }
  }

  const viewIds = new Set<string>()
  for (const view of model.views) {
    if (viewIds.has(view.id)) {
      issues.push({ severity: 'error', message: `duplicate view id: ${view.id}` })
    }
    viewIds.add(view.id)

    // A view that selects nothing is almost always a typo in a pattern.
    const hit = model.entities.some((e) =>
      view.include.length === 0
        ? true
        : view.include.some((p) => matches(p, e.id) || (e.group != null && matches(p, e.group))),
    )
    if (!hit) {
      issues.push({ severity: 'warning', message: `view '${view.id}' matches no entities` })
    }
  }

  return { ok: !issues.some((i) => i.severity === 'error'), model, issues }
}

export function loadModel(source: string): ValidationResult {
  let raw: unknown
  try {
    raw = parseYaml(source)
  } catch (err) {
    return { ok: false, issues: [{ severity: 'error', message: `invalid YAML: ${(err as Error).message}` }] }
  }
  return validateModel(raw)
}

export function dumpModel(model: Model): string {
  return stringifyYaml(model, { lineWidth: 0 })
}
