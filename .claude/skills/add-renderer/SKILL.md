---
name: add-renderer
description: Add a new output renderer to driftwood (D2, PlantUML, SVG, JSON, an interactive or 3D view). Use when the user wants driftwood to emit a new diagram format or visual output.
---

# Adding a renderer

A renderer turns a `Model` into output. It never mutates the model.

## The probe contract

```ts
export const myRenderer = defineRenderer({
  name: 'd2',
  description: 'one line, shown by `driftwood engines`',
  extension: 'd2',
  priority: 60,              // higher wins under --engine auto
  async probe() {
    const ok = await canActuallyRun()
    return ok
      ? { available: true, via: 'native d2 binary' }
      : { available: false, reason: 'no `d2` on PATH — install from https://d2lang.com' }
  },
  async render(model, ctx) {
    return emitD2(model, ctx)
  },
})
```

`probe()` is the whole reason graceful degradation works. Get it right:

- It must **never throw**. Return `{ available: false, reason }` instead.
- It must **never hang**. Bound any subprocess check with a timeout (see `probeNativeDot`).
- `reason` must tell the user *how to fix it*, not just that it failed.

## Priority and fallback

`--engine auto` sorts by `priority` descending and takes the first available. An explicitly named engine fails loudly — only `auto` substitutes.

Current priorities: `graphviz` 100, `mermaid` 50, `dot` 10.

Pick a priority by output quality when available. If your renderer needs something that might be missing, give it high priority and let `probe()` handle absence — that is the pattern, not an exception to it.

## Requirements

- **A renderer that needs nothing must report `available: true` unconditionally.** Mermaid and DOT are the floor; at least one renderer must always work or the tool breaks entirely.
- **Never add a native dependency.** Pure JS and WebAssembly may be regular dependencies (that's how Graphviz ships here). A native binary may only be an *opportunistic upgrade* discovered by `probe()` — the renderer must still work without it.
- **Import anything heavy lazily**, inside `probe()`/`render()` rather than at module load, and wrap it in try/catch so a runtime that can't load it degrades instead of crashing:
  ```ts
  try {
    if (typeof (globalThis as { WebAssembly?: unknown }).WebAssembly === 'undefined') return undefined
    const { Thing } = await import('@scope/heavy-pkg')
  } catch { return undefined }
  ```
- **Use `selectEntities` from `src/render/select.js`** for view scoping so every engine scopes identically.
- **Drop edges whose endpoints aren't visible** in the current view.
- **Accept `ctx.health` as a render-time overlay.** Never read health from the model — it is never committed there.
- **Escape labels.** Model text is arbitrary; each format has its own escaping rules.
- **Classify with `src/render/icons.ts`, never with your own regex table.** `iconFor(kind)` and `familyFor(kind)` decide what an entity *is* and what colour it gets. A queue drawn as a queue in one engine and a cylinder in another means the two pictures no longer describe the same system. If your format can draw vector artwork, `ICONS[key].body` is a 24x24 glyph you can inline; if it can't, map the key to the nearest shape your format has, the way `mermaid.ts` does.

## Register it

In `src/render/index.ts`: `renderers.register(myRenderer)`.

## Test it

Tests must pass in every environment your engine might meet — including `node --jitless`, where WebAssembly is unavailable. Branch on `probe()`:

```ts
const probe = await renderers.get('d2').probe()
if (!probe.available) {
  expect(probe.reason).toContain('install')
} else {
  expect(await renderers.get('d2').render(model, {})).toContain('...')
}
```
