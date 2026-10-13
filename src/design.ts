import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

/**
 * The shared design system, `@brignano/design`, as driftwood consumes it.
 *
 * Its rule is that no hex lives outside its `tokens.css`, so nothing here
 * declares a colour: the stylesheets are read from the installed package and
 * the values parsed out of them. Upgrading the package restyles every output.
 * The package is plain CSS — no build step, nothing native — so it is an
 * ordinary dependency like any other.
 *
 * Two consumers want it in two shapes:
 *
 *   - The HTML viewer is a browser page, so it inlines the stylesheets whole
 *     and uses the custom properties directly, dark mode included.
 *   - Diagrams (DOT, SVG, Mermaid) are files that end up as `<img>` sources,
 *     job-summary embeds and GitHub-rendered Mermaid, where a `var()` means
 *     nothing. They get literal values resolved from the light theme, which
 *     is what they are drawn on: every diagram sits on a white card.
 */

const require = createRequire(import.meta.url)

function stylesheet(file: string): string {
  return readFileSync(require.resolve(`@brignano/design/${file}`), 'utf8')
}

/** `tokens.css`, verbatim, for inlining into a page. */
export const TOKENS_CSS = stylesheet('tokens.css')

/**
 * The declarations in a stylesheet's first `:root { … }` block, which in both
 * files is the light theme. Comments are stripped first: they quote token
 * names in prose.
 */
function lightDeclarations(css: string): Map<string, string> {
  const body = css.replace(/\/\*[\s\S]*?\*\//g, '')
  const start = body.indexOf(':root {')
  const end = body.indexOf('}', start)
  if (start === -1 || end === -1) throw new Error('@brignano/design: no :root block found')
  const out = new Map<string, string>()
  for (const [, name, value] of body.slice(start, end).matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out.set(name!, value!.trim())
  }
  return out
}

const declared = lightDeclarations(TOKENS_CSS)

/** A light-theme token as a literal colour, following `var()` aliases. */
function token(name: string, seen: string[] = []): string {
  const value = declared.get(name)
  if (value === undefined) throw new Error(`@brignano/design: token ${name} is not declared`)
  const alias = /^var\((--[\w-]+)\)$/.exec(value)
  if (!alias) {
    if (!/^#[0-9a-f]{6}$/i.test(value)) throw new Error(`@brignano/design: ${name} is not a plain colour (${value})`)
    return value.toLowerCase()
  }
  if (seen.includes(name)) throw new Error(`@brignano/design: ${name} refers to itself`)
  return token(alias[1]!, [...seen, name])
}

/**
 * `color-mix(in srgb, <colour> <pct>, <ground>)`, which is how the design
 * system makes a state's wash. Resolved here because Graphviz and Mermaid
 * cannot evaluate it.
 */
export function mix(colour: string, pct: number, ground: string): string {
  const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const a = rgb(colour)
  const b = rgb(ground)
  return '#' + a.map((v, i) => Math.round(v * pct + b[i]! * (1 - pct)).toString(16).padStart(2, '0')).join('')
}

/** A colour that marks a thing (`accent`) and the wash behind it (`tint`). */
export interface Swatch {
  accent: string
  tint: string
}

const card = token('--card')
/** The light-theme wash strength, from `--*-surface` in tokens.css. */
const WASH = 0.12
const swatch = (name: string): Swatch => ({ accent: token(name), tint: mix(token(name), WASH, card) })

/** Light-theme literals for outputs that cannot use CSS custom properties. */
export const LIGHT = {
  card,
  ground: token('--bg'),
  ink: token('--ink'),
  /** Secondary text. 7.7:1, so it is safe at the small sizes diagrams use. */
  inkSoft: token('--ink-soft'),
  /** UI marks only (3.4:1): edges and arrowheads, never text. */
  slate: token('--slate'),
  line: token('--line'),
  lineStrong: token('--line-strong'),
  interactive: swatch('--i'),
  success: swatch('--success'),
  attention: swatch('--attention'),
  danger: swatch('--danger'),
} as const
