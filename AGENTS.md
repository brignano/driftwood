# driftwood — AI context

**Architecture as code, reconciled with live infrastructure.** A versioned graph model in git, checked continuously against real platform data, with divergence surfaced as a pull request.

Origin: the idea brief in `brignano/ideas` at `proposals/architecture-as-code-reconciler.md`. That brief holds the design rationale and the still-open questions; this repo is its implementation.

## The one architectural idea

Everything routes through **one model**. Nothing bypasses it.

```
providers ──> model (git) ──> renderers
                  ^
                  │
             reconciler (declared vs observed)
```

- **Providers** observe reality and emit a `Model`. They never read the committed model, never write files, never mutate infrastructure.
- **The model** (`architecture.yaml`) is the only thing committed. Schema: `src/model/schema.ts`.
- **Renderers** read a model and emit a picture. They never mutate it.
- **The reconciler** diffs declared against observed.

When adding a feature, decide which of those four it is. If it fits none, it probably shouldn't be built — that decomposition is what keeps "2D now, 3D later" and "static now, live health later" cheap instead of a rewrite.

## Hard constraints

Not preferences. Breaking either defeats the project's purpose:

1. **Zero *required* native dependencies.** The base install must work with npm alone. This project exists because `mingrammer/diagrams` needs the Graphviz binary and that can't clear corporate software approval. Graphviz is supported but never required — see the engine tiers below. Required runtime deps are `commander`, `yaml`, `zod`. Anything native must be an optional peer dependency behind a `probe()`.
2. **Read-only credentials only.** driftwood observes and reports. It never mutates infrastructure.

## Extension points

Both use the same `Registry` (`src/registry.ts`). A third-party plugin registers exactly the way a built-in does — there is no separate plugin API.

### Adding a provider

See `.claude/skills/add-provider/SKILL.md` for the full walkthrough. In short: implement `Provider` from `src/providers/types.ts`, register it in `src/providers/index.ts`, add tests.

- `kind: 'declarative'` (intent — Terraform, CloudFormation, Helm) or `'runtime'` (reality — Dynatrace, Splunk, OTel). This drives merge precedence: declarative wins on naming and grouping, because IaC resource names beat monitoring display names.
- `platforms` lists what it can describe, or `['*']` when platform-agnostic.
- `configSchema` is a Zod schema, validated **before** any network call so errors are useful.
- Never read `process.env` directly — use `ctx.secret(name)`. Config carries the *name* of an env var, never a secret value.

### Adding a renderer

See `.claude/skills/add-renderer/SKILL.md`. Implement `Renderer` from `src/render/types.ts`.

`probe()` is the important part — it reports whether the renderer can actually run here, which is what makes `--engine auto` degrade gracefully instead of failing.

### Engine tiers (the Graphviz answer)

| Tier | Requirement | Notes |
|---|---|---|
| `graphviz` native | `dot` on PATH | Best layout. Needs a system package. |
| `graphviz` WASM | `npm i @hpcc-js/wasm-graphviz` | Real Graphviz compiled to WASM. Same DOT semantics, no system package, no admin rights. **The enterprise unlock.** |
| `dot` | nothing | Emits DOT *source*. Always available — it's just text. |
| `mermaid` | nothing | Always available, renders natively in GitHub. The fallback. |

`--engine auto` walks by `priority` and takes the first that probes available. An explicitly named engine fails loudly instead of substituting — only `auto` may substitute.

## Design rules

- **Never silently delete.** Read-only creds can't see everything. Unknown is not absent — that's what `coverage` is for. A provider that can't see something must never cause the reconciler to report it removed.
- **Never guess identity.** Terraform's `aws_lambda_function.fn` and Dynatrace's `SERVICE-A1B2` only merge via an explicit `aliases` entry. A duplicated node is visible and fixable; a wrongly merged node silently corrupts the graph. Do not add heuristic matching without a very deliberate decision.
- **Surface disagreement, don't hide it.** When providers conflict, `mergeModels` resolves *and* records the conflict.
- **`kind` is an open string, not an enum.** Any provider must emit its own vocabulary without a schema change. Renderers pattern-match known kinds and fall back.
- **Views from v1.** Flat graphs die past ~150 nodes. Never add a feature that assumes one flat graph.
- **Runtime state never enters git.** Health, latency, error rates are render-time overlays only.
- **Drift policy: structural facts count, metadata doesn't.** See `COMPARED_FIELDS` in `src/reconcile/index.ts`. Widening it has a real cost — noisy drift reports get muted, and a muted report equals no tool at all.
- **Providers never do I/O outside `observe`.** Pure mapping functions (`importTerraformState`, `toModel`) stay separately exported and unit-tested without network or disk.

## Identity resolution

The hard problem, and where CMDBs historically die. Entity id **is** the source's native id (Terraform address, Dynatrace entity id). Cross-source joins are manual via `aliases`.

This is honest but limited. Do not claim in docs or output that driftwood resolves identity automatically — it does not.

## Conventions

- TypeScript, ESM, strict mode with `noUncheckedIndexedAccess`.
- Zod schemas are the source of truth for types — derive with `z.infer`, never hand-write a parallel interface.
- Every provider's output must pass `validateModel`. Dangling edges are a provider bug, not something the validator should tolerate.
- Tests live in `test/`, named for the module under test. **Cover failure modes, not just happy paths** — the existing suite tests dangling edges, ignore precedence, view filtering dropping half-visible edges, and alias-induced self-loops.
- Tests must pass whether or not Graphviz is installed. Anything Graphviz-dependent branches on `probe()`.

## Commands

```bash
npm test                       # vitest
npm run typecheck
npm run build
npx tsx src/cli.ts <command>   # run without building
npx tsx src/cli.ts engines     # what this machine can render with
npx tsx src/cli.ts providers   # what is registered
```

Run `npm run typecheck && npm test` before every commit. CI runs both, plus the drift gate, plus a job that installs the WASM package to prove the Graphviz path.
