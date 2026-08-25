import { z } from 'zod'

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
