## What changed

<!-- One or two sentences. What does this add or fix? -->

## Which layer

<!-- Tick one. If it fits none, explain why it belongs in this repo at all. -->

- [ ] Provider (observes reality, returns a Model)
- [ ] Model / schema
- [ ] Renderer (Model -> output)
- [ ] Reconciler (declared vs observed)
- [ ] CLI / config
- [ ] Docs, CI, or tooling

## Constraint check

- [ ] No native dependency added — install still works with npm alone (WASM is fine, compiled addons are not)
- [ ] Any native binary is an opportunistic upgrade behind a `probe()`, never required
- [ ] Read-only: nothing here mutates infrastructure
- [ ] No secret values in config — only env var *names*
- [ ] Tests pass with Graphviz available **and** under `node --jitless` (WebAssembly disabled)
- [ ] No heuristic identity matching added (cross-source joins stay explicit via `aliases`)

## Validation

<!-- Paste the actual output, not a claim that it passed. -->

```
npm run typecheck && npm test
```

## Notes for reviewers

<!-- Anything ambiguous, any tradeoff taken, anything deliberately left out. -->
