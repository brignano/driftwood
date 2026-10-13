import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { LIGHT, TOKENS_CSS, mix } from '../src/design.js'
import { PALETTE } from '../src/render/icons.js'
import { renderDot } from '../src/render/dot.js'
import { renderMermaid } from '../src/render/mermaid.js'
import { Model } from '../src/model/schema.js'

const require = createRequire(import.meta.url)
const tokens = readFileSync(require.resolve('@brignano/design/tokens.css'), 'utf8')

describe('@brignano/design tokens', () => {
  it('are read from the installed package, not copied', () => {
    expect(TOKENS_CSS).toBe(tokens)
  })

  it('resolve to the light theme, following aliases', () => {
    expect(tokens).toContain(`--danger: ${LIGHT.danger.accent};`)
    expect(tokens).toContain(`--i: ${LIGHT.interactive.accent};`)
    // --ink is var(--n-900) in the light block and something else in dark.
    expect(tokens).toMatch(new RegExp(`--n-900: ${LIGHT.ink};`))
    expect(LIGHT.ink).not.toBe('#f2f2f0')
  })

  it('wash a colour the way color-mix does', () => {
    expect(mix('#000000', 0.5, '#ffffff')).toBe('#808080')
    expect(LIGHT.danger.tint).toBe(mix(LIGHT.danger.accent, 0.12, LIGHT.card))
  })

  it('give families the categorical palette in its validated order', () => {
    expect(PALETTE.edge).toEqual(LIGHT.chart[0])
    expect(PALETTE.observability).toEqual(LIGHT.chart[5])
    expect(PALETTE.other).toEqual(LIGHT.chartOther)
  })
})

describe('diagram colours', () => {
  const model = Model.parse({
    version: 1,
    name: 't',
    entities: [{ id: 'a', kind: 'aws_s3_bucket' }, { id: 'b', kind: 'aws_lambda_function' }],
    edges: [{ from: 'b', to: 'a' }],
  })

  it('use no colour the design system does not declare', () => {
    const declared = new Set(
      [LIGHT.card, LIGHT.ground, LIGHT.ink, LIGHT.inkSoft, LIGHT.slate, LIGHT.line, LIGHT.lineStrong].concat(
        [LIGHT.interactive, LIGHT.success, LIGHT.attention, LIGHT.danger, LIGHT.chartOther, ...LIGHT.chart].flatMap(
          (s) => [s.accent, s.tint],
        ),
      ),
    )
    const health = { a: 'down', b: 'degraded' } as const
    const outputs = [
      renderDot(model, { health }),
      renderMermaid(model, { health, marks: { a: 'destroy', b: 'create' }, edgeMarks: [{ from: 'b', to: 'a', mark: 'added' }] }),
    ]
    for (const out of outputs) {
      for (const hex of out.match(/#[0-9a-fA-F]{6}\b/g) ?? []) expect(declared, hex).toContain(hex.toLowerCase())
    }
  })
})
