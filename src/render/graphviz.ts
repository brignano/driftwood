import { spawn } from 'node:child_process'
import type { Model } from '../model/schema.js'
import { renderDot } from './dot.js'
import { defineRenderer } from './types.js'
import type { Availability, RenderContext } from './types.js'

/**
 * Graphviz rendering to SVG, with three tiers of availability.
 *
 * The original problem this project came from: `mingrammer/diagrams` requires
 * the Graphviz *system binary*, and that cannot be pushed through corporate
 * software approval. The answer is not to give up Graphviz, it's to stop
 * requiring the binary:
 *
 *   1. native  — the `dot` binary is on PATH. Best output, needs a system package.
 *   2. wasm    — the optional `@hpcc-js/wasm-graphviz` npm package is installed.
 *                Real Graphviz compiled to WebAssembly: same layouts, same DOT
 *                semantics, installed over plain npm with no system package
 *                and no admin rights. This is the enterprise unlock.
 *   3. none    — neither is present, so `--engine auto` falls back to Mermaid.
 *
 * Tier 2 is the point. "With Graphviz" and "installable at work" stop being
 * mutually exclusive.
 */

export type GraphvizTier = 'native' | 'wasm' | 'none'

/** Runs `dot -V` to see whether a usable native Graphviz is on PATH. */
export function probeNativeDot(command = 'dot'): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (v: boolean) => {
      if (!settled) {
        settled = true
        resolve(v)
      }
    }
    try {
      const child = spawn(command, ['-V'], { stdio: 'ignore' })
      child.on('error', () => done(false))
      child.on('close', (code) => done(code === 0))
      // A hung probe must never block a render; treat slow as absent.
      setTimeout(() => {
        child.kill()
        done(false)
      }, 2000).unref?.()
    } catch {
      done(false)
    }
  })
}

interface WasmGraphviz {
  layout(source: string, format: string, engine: string): string
}

/**
 * Loads the optional WASM package. It is an optional peer dependency, not a
 * hard one, so a machine that cannot install it still gets a working tool.
 */
export async function loadWasmGraphviz(): Promise<WasmGraphviz | undefined> {
  try {
    // The specifier is held in a variable deliberately: a literal would make
    // this a hard compile-time dependency, defeating the point of it being
    // optional. Resolution failure is the expected path, not an error.
    const specifier = '@hpcc-js/wasm-graphviz'
    const mod = (await import(/* @vite-ignore */ specifier)) as {
      Graphviz?: { load(): Promise<WasmGraphviz> }
    }
    if (!mod.Graphviz) return undefined
    return await mod.Graphviz.load()
  } catch {
    return undefined
  }
}

export async function detectTier(): Promise<GraphvizTier> {
  if (await probeNativeDot()) return 'native'
  if (await loadWasmGraphviz()) return 'wasm'
  return 'none'
}

function runNativeDot(source: string, engine: string, format: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(engine, [`-T${format}`])
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new Error(`${engine} exited ${code}: ${err.trim()}`))
    })
    child.stdin.write(source)
    child.stdin.end()
  })
}

export async function renderGraphvizSvg(model: Model, ctx: RenderContext = {}): Promise<string> {
  const source = renderDot(model, ctx)
  const tier = await detectTier()
  if (tier === 'native') return runNativeDot(source, 'dot', 'svg')
  if (tier === 'wasm') {
    const gv = await loadWasmGraphviz()
    if (gv) return gv.layout(source, 'svg', 'dot')
  }
  throw new Error(
    'Graphviz is not available. Either install the `dot` binary, or run ' +
      '`npm install @hpcc-js/wasm-graphviz` for a pure-npm WASM build that needs ' +
      'no system package. Alternatively use --engine mermaid.',
  )
}

export const graphvizRenderer = defineRenderer({
  name: 'graphviz',
  description: 'Graphviz-rendered SVG (native `dot` binary, or WASM fallback)',
  extension: 'svg',
  // Highest priority: when Graphviz is genuinely available its layout beats
  // Mermaid's. When it isn't, `auto` silently drops to the next renderer.
  priority: 100,
  async probe(): Promise<Availability> {
    const tier = await detectTier()
    if (tier === 'native') return { available: true, via: 'native dot binary' }
    if (tier === 'wasm') return { available: true, via: '@hpcc-js/wasm-graphviz' }
    return {
      available: false,
      reason:
        'no `dot` on PATH and @hpcc-js/wasm-graphviz is not installed — ' +
        'run `npm install @hpcc-js/wasm-graphviz` for a no-system-package build',
    }
  },
  async render(model, ctx) {
    return renderGraphvizSvg(model, ctx)
  },
})
