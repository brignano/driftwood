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

- [ ] No new **required** native dependency — base install still works with npm alone
- [ ] Anything native is an optional peer dependency behind a `probe()`
- [ ] Read-only: nothing here mutates infrastructure
- [ ] No secret values in config — only env var *names*
- [ ] Tests pass with **and** without Graphviz installed
- [ ] No heuristic identity matching added (cross-source joins stay explicit via `aliases`)

## Validation

<!-- Paste the actual output, not a claim that it passed. -->

```
npm run typecheck && npm test
```

## Notes for reviewers

<!-- Anything ambiguous, any tradeoff taken, anything deliberately left out. -->
