#!/usr/bin/env tsx
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadModel } from '../src/model/validate.js'
import { renderGraphvizSvg } from '../src/render/graphviz.js'
import { renderMermaid } from '../src/render/mermaid.js'

/**
 * Renders the worked example into `docs/`, which the README embeds.
 *
 * A picture of the output is the one piece of documentation that cannot be
 * written once and left alone — it is wrong the moment rendering changes, and
 * a stale screenshot of your own tool is worse than none. So it is generated
 * from the committed model by this script, and CI re-runs it and fails if the
 * result differs from what is checked in. Same argument as the drift gate, one
 * level up: the artifact is checked against its source rather than trusted.
 *
 * Run it with `npm run docs`.
 *
 * The tier is pinned to the bundled WASM build rather than detected. Layout is
 * byte-deterministic for a given Graphviz build, but a native `dot` is a
 * different build, so a contributor who has Graphviz installed would otherwise
 * produce a diff that fails the check in CI, where no `dot` exists.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'docs')

/** Rendered as SVG. `context` is deliberately included: it is the argument for views. */
const VIEWS = ['context', 'edge', 'app', 'data', 'async', 'network']

/** Also emitted as Mermaid, for the README's "renders natively in a PR" claim. */
const MERMAID_VIEWS = ['async']

const result = loadModel(readFileSync(join(root, 'examples/architecture.yaml'), 'utf8'))
if (!result.ok || !result.model) {
  for (const issue of result.issues) console.error(`${issue.severity}: ${issue.message}`)
  console.error('\nexamples/architecture.yaml is not a valid model.')
  process.exit(1)
}
const model = result.model

mkdirSync(outDir, { recursive: true })

for (const view of VIEWS) {
  const svg = await renderGraphvizSvg(model, { view, direction: 'LR' }, 'wasm')
  writeFileSync(join(outDir, `${view}.svg`), svg)
  const size = `${Math.round(svg.length / 1024)}KB`
  console.log(`docs/${view}.svg`.padEnd(24) + size)
}

for (const view of MERMAID_VIEWS) {
  const mmd = renderMermaid(model, { view, direction: 'LR' })
  writeFileSync(join(outDir, `${view}.mmd`), mmd)
  console.log(`docs/${view}.mmd`.padEnd(24) + `${Math.round(mmd.length / 1024)}KB`)
  // GitHub renders Mermaid from a fenced block but not from a linked file, so
  // the README has to carry a copy — which is a copy that can rot. Rewrite it
  // from the same render instead of trusting whoever pasted it last.
  replaceMarkedBlock(join(root, 'README.md'), view, '```mermaid\n' + mmd.trimEnd() + '\n```')
}

function replaceMarkedBlock(file: string, name: string, body: string): void {
  const open = `<!-- generated:${name} -->`
  const close = `<!-- /generated:${name} -->`
  const source = readFileSync(file, 'utf8')
  const start = source.indexOf(open)
  const end = source.indexOf(close)
  if (start === -1 || end === -1 || end < start) {
    console.error(`${file}: missing ${open} ... ${close} markers`)
    process.exit(1)
  }
  const updated = source.slice(0, start + open.length) + '\n' + body + '\n' + source.slice(end)
  if (updated !== source) writeFileSync(file, updated)
  console.log(`README.md ${open}`.padEnd(24) + 'updated in place')
}
