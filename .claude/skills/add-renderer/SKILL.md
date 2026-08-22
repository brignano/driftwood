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
- **Anything native is an optional peer dependency**, imported via a variable specifier so it isn't a compile-time dependency:
  ```ts
  const specifier = '@scope/optional-pkg'
  const mod = await import(/* @vite-ignore */ specifier)
  ```
- **Use `selectEntities` from `src/render/select.js`** for view scoping so every engine scopes identically.
- **Drop edges whose endpoints aren't visible** in the current view.
- **Accept `ctx.health` as a render-time overlay.** Never read health from the model — it is never committed there.
- **Escape labels.** Model text is arbitrary; each format has its own escaping rules.

## Register it

In `src/render/index.ts`: `renderers.register(myRenderer)`.

## Test it

Tests must pass **whether or not** your engine's dependency is installed. Branch on `probe()`:

```ts
const probe = await renderers.get('d2').probe()
if (!probe.available) {
  expect(probe.reason).toContain('install')
} else {
  expect(await renderers.get('d2').render(model, {})).toContain('...')
}
```
