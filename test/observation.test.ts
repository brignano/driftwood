import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import {
  ageInMinutes,
  dumpObservation,
  formatObservation,
  parseObservation,
  toObservation,
} from '../src/model/observation.js'
import { observationProvider } from '../src/providers/observation.js'
import { makeContext } from '../src/config.js'
import { Model } from '../src/model/schema.js'
import type { SourcedModel } from '../src/model/merge.js'

const model = (partial: Partial<Model> & { name?: string }): Model =>
  Model.parse({ version: 1, name: 'test', ...partial })

const sample = model({
  entities: [
    { id: 'a', kind: 'service' },
    { id: 'b', kind: 'aws_s3_bucket' },
  ],
  edges: [{ from: 'a', to: 'b', kind: 'depends-on' }],
})

const sources: SourcedModel[] = [{ provider: 'terraform', kind: 'declarative', model: sample }]

/** Writes an observation to a temp dir and returns a provider config for it. */
function onDisk(contents: string, name = 'observed.json'): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'driftwood-obs-'))
  writeFileSync(join(dir, name), contents)
  return { dir, path: name }
}

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000)

describe('toObservation', () => {
  it('records when it was taken and what each provider contributed', () => {
    const o = toObservation(sample, sources, { workspace: 'prod' })
    expect(o.observation).toBe(1)
    expect(o.model.entities).toHaveLength(2)
    expect(o.origin).toEqual({ workspace: 'prod' })
    expect(o.sources).toEqual([{ provider: 'terraform', kind: 'declarative', entities: 2, edges: 1 }])
    expect(ageInMinutes(o)).toBe(0)
  })

  // YAML is a superset of JSON, so the one parser the provider uses reads
  // either serialization. A pipeline can emit whichever its artifact store
  // handles better without the consumer caring.
  it('round-trips through YAML and through JSON', () => {
    const o = toObservation(sample, sources, { commit: 'abc123' })
    for (const format of ['yaml', 'json'] as const) {
      const reparsed = parseObservation(parseYaml(dumpObservation(o, format)))
      expect(reparsed.ok, `${format} did not round-trip: ${reparsed.issues.join('; ')}`).toBe(true)
      expect(reparsed.observation?.model).toEqual(o.model)
      expect(reparsed.observation?.origin).toEqual({ commit: 'abc123' })
    }
  })
})

describe('parseObservation', () => {
  it('rejects a bare model — an envelope with no date cannot be checked for staleness', () => {
    const result = parseObservation(sample)
    expect(result.ok).toBe(false)
    expect(result.issues.join(' ')).toMatch(/observation|observedAt/)
  })

  it('rejects an unknown envelope version rather than guessing at its shape', () => {
    const o = { ...toObservation(sample, sources), observation: 2 }
    expect(parseObservation(o).ok).toBe(false)
  })

  it('rejects a malformed timestamp', () => {
    const o = { ...toObservation(sample, sources), observedAt: 'last Tuesday' }
    expect(parseObservation(o).ok).toBe(false)
  })
})

describe('ageInMinutes', () => {
  it('counts whole minutes since the observation', () => {
    const o = toObservation(sample, sources, {}, at(90))
    expect(ageInMinutes(o)).toBe(90)
  })

  it('goes negative for a future timestamp, so clock skew is detectable', () => {
    const o = toObservation(sample, sources, {}, at(-30))
    expect(ageInMinutes(o)).toBeLessThan(0)
  })
})

describe('the observation provider', () => {
  const read = (contents: string, config: Record<string, unknown> = {}) => {
    const { dir, path } = onDisk(contents)
    const parsed = observationProvider.configSchema.parse({ path, ...config })
    return observationProvider.observe(parsed, makeContext(dir))
  }

  it('returns the model the artifact carries', () => {
    const out = read(dumpObservation(toObservation(sample, sources)))
    expect(out.entities.map((e) => e.id)).toEqual(['a', 'b'])
    expect(out.edges).toHaveLength(1)
  })

  it('reads JSON as happily as YAML', () => {
    const out = read(dumpObservation(toObservation(sample, sources), 'json'))
    expect(out.entities).toHaveLength(2)
  })

  // The push pattern's real failure mode: the pipeline stops publishing, the
  // consumer keeps reading the last artifact, and everything deployed since
  // reads as a deletion. Refusing is the only safe answer.
  it('refuses an artifact older than maxAgeMinutes', () => {
    const stale = dumpObservation(toObservation(sample, sources, {}, at(60 * 24 * 9)))
    expect(() => read(stale, { maxAgeMinutes: 1440 })).toThrow(/older than the 1440-minute limit/)
  })

  it('accepts an artifact inside the limit', () => {
    const fresh = dumpObservation(toObservation(sample, sources, {}, at(30)))
    expect(read(fresh, { maxAgeMinutes: 1440 }).entities).toHaveLength(2)
  })

  it('trusts any age when no limit is set', () => {
    const ancient = dumpObservation(toObservation(sample, sources, {}, at(60 * 24 * 365)))
    expect(read(ancient).entities).toHaveLength(2)
  })

  it('refuses a future-dated artifact rather than treating clock skew as fact', () => {
    const future = dumpObservation(toObservation(sample, sources, {}, at(-180)))
    expect(() => read(future)).toThrow(/in the future/)
  })

  it('fails with the validation detail when the artifact is not an observation', () => {
    expect(() => read('version: 1\nname: not-an-observation\n')).toThrow(/is not a valid observation/)
  })

  // Flattening a Terraform observation to 'runtime' would invert the merge
  // precedence that makes IaC resource names beat monitoring display names.
  it('does not claim to be a runtime source', () => {
    expect(observationProvider.kind).toBe('declarative')
  })

  it('validates its config before touching the disk', () => {
    expect(observationProvider.configSchema.safeParse({}).success).toBe(false)
    expect(observationProvider.configSchema.safeParse({ path: 'x', maxAgeMinutes: 0 }).success).toBe(false)
    expect(observationProvider.configSchema.safeParse({ path: 'x', maxAgeMinutes: -5 }).success).toBe(false)
  })
})

describe('formatObservation', () => {
  it('leads with the counts, the age and the providers', () => {
    const o = toObservation(sample, sources, {}, at(12))
    const line = formatObservation(o)
    expect(line).toContain('2 entities, 1 edges')
    expect(line).toContain('12 minutes ago')
    expect(line).toContain('terraform (2/1)')
  })

  it('includes the provenance a reviewer needs to trace the artifact', () => {
    const o = toObservation(sample, sources, { workspace: 'prod-orders', commit: 'abc1234' })
    const line = formatObservation(o)
    expect(line).toContain('workspace=prod-orders')
    expect(line).toContain('commit=abc1234')
  })
})
