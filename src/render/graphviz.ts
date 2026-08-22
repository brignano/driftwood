import { spawn } from 'node:child_process'
import type { Model } from '../model/schema.js'
import { renderDot } from './dot.js'
import { defineRenderer } from './types.js'
import type { Availability, RenderContext } from './types.js'

/**
 * Graphviz rendering to SVG. Graphviz is **bundled, not required**.
 *
 * The problem this project came from: `mingrammer/diagrams` requires the
 * Graphviz *system binary*, which cannot clear corporate software approval.
 * The answer isn't to drop Graphviz, nor to make it an optional extra the user
 * has to go and find — it's to ship it in a form that needs no system package.
 *
 * `@hpcc-js/wasm-graphviz` is real Graphviz compiled to WebAssembly: same DOT
 * semantics, same layouts, zero transitive dependencies, and the WASM is
 * inlined into the JS so there is no separate binary to locate. It is a
 * regular dependency, so `npm install` yields working Graphviz on any machine.
 *
 * Three tiers remain, in preference order:
 *
 *   1. native — the `dot` binary is on PATH. Preferred when present: faster on
 *      very large graphs, and it honours a site's own Graphviz build/plugins.
 *   2. wasm   — the bundled WASM build. The default. Works anywhere
 *      WebAssembly does, with no admin rights and no system package.
 *   3. none   — WebAssembly is switched off (a hardened or `--jitless`
 *      runtime), so `--engine auto` falls back to Mermaid.
 *
 * Tier 3 is rare but real, which is why the fallback is not vestigial.
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

let wasmCache: WasmGraphviz | undefined
let wasmAttempted = false

/**
 * Loads the bundled WASM build.
 *
 * Imported lazily rather than at module load: it is ~800KB, and a Mermaid-only
 * render should never pay for it. Still wrapped in try/catch because
 * WebAssembly can be disabled at runtime, and that must degrade to the Mermaid
 * fallback rather than crash.
 */
export async function loadWasmGraphviz(): Promise<WasmGraphviz | undefined> {
  if (wasmAttempted) return wasmCache
  wasmAttempted = true
  try {
    // `lib` is ES2022, which has no WebAssembly types; probe it off globalThis.
    if (typeof (globalThis as { WebAssembly?: unknown }).WebAssembly === 'undefined') return undefined
    const { Graphviz } = await import('@hpcc-js/wasm-graphviz')
    wasmCache = (await Graphviz.load()) as unknown as WasmGraphviz
  } catch {
    wasmCache = undefined
  }
  return wasmCache
}

/** Test seam: forget any cached WASM instance. */
export function resetWasmCache(): void {
  wasmCache = undefined
  wasmAttempted = false
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
    'Graphviz is unavailable because WebAssembly is disabled in this runtime ' +
      '(for example `node --jitless`). Install the `dot` binary, or use ' +
      '--engine mermaid, which needs neither.',
  )
}

export const graphvizRenderer = defineRenderer({
  name: 'graphviz',
  description: 'Graphviz-rendered SVG (bundled WASM build, or a native `dot` binary)',
  extension: 'svg',
  // Highest priority: Graphviz layout beats Mermaid's, and it is available by
  // default. `auto` only drops past it where WebAssembly is switched off.
  priority: 100,
  async probe(): Promise<Availability> {
    const tier = await detectTier()
    if (tier === 'native') return { available: true, via: 'native dot binary' }
    if (tier === 'wasm') return { available: true, via: 'bundled @hpcc-js/wasm-graphviz' }
    return {
      available: false,
      reason:
        'WebAssembly is disabled in this runtime, so the bundled Graphviz cannot load — ' +
        'install the `dot` binary or use --engine mermaid',
    }
  },
  async render(model, ctx) {
    return renderGraphvizSvg(model, ctx)
  },
})
