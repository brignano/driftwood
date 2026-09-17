import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Model } from './model/schema.js'

export const HealthStatus = z.enum(['healthy', 'degraded', 'down'])
export type HealthStatus = z.infer<typeof HealthStatus>
export type HealthMap = Record<string, HealthStatus>

export function parseHealthMap(input: unknown, label = 'health map'): HealthMap {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error(`${label} must be an object mapping entity ids to healthy, degraded, or down`)
  }

  const result: HealthMap = {}

  function validateBranch(branch: Record<string, unknown>, path: string[] = []): void {
    for (const [key, value] of Object.entries(branch)) {
      const nextPath = [...path, key]
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        validateBranch(value as Record<string, unknown>, nextPath)
        continue
      }

      const fullKey = nextPath.join('.')
      const parsed = HealthStatus.safeParse(value)
      if (!parsed.success) {
        throw new Error(`invalid health value for "${fullKey}" in ${label}: expected healthy, degraded, or down`)
      }

      result[fullKey] = parsed.data
    }
  }

  validateBranch(input as Record<string, unknown>)
  return result
}

/**
 * Read and validate a health file. Kept here rather than in `cli.ts` so the
 * unreadable-file and malformed-JSON paths are reachable from tests.
 */
export function loadHealthMap(path: string): HealthMap {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    throw new Error(`could not read health file ${path}: ${error instanceof Error ? error.message : String(error)}`)
  }

  try {
    return parseHealthMap(raw, `health file ${path}`)
  } catch (error) {
    throw new Error(`invalid health file ${path}:\n${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Health ids that match no entity in the model at all — an operator typo,
 * as distinct from an id the current view legitimately filters out.
 */
export function unknownHealthIds(health: HealthMap, model: Model): string[] {
  const known = new Set(model.entities.map((entity) => entity.id))
  return Object.keys(health).filter((id) => !known.has(id))
}
