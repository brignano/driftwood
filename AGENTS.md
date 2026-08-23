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

1. **No native dependencies, ever.** The whole install must work with npm alone — no compiled addons, no system packages, no post-install build step. This project exists because `mingrammer/diagrams` needs the Graphviz *binary* and that can't clear corporate software approval. Pure JS and WebAssembly are both fine and may be regular dependencies; a native binary may only ever be an *opportunistic upgrade* discovered by `probe()`, never something the tool needs. Runtime deps: `commander`, `yaml`, `zod`, `@hpcc-js/wasm-graphviz`.
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

### Icons and colour

`src/render/icons.ts` owns what an entity *is* (`iconFor`) and what colour it gets (`familyFor`, `PALETTE`). Every renderer classifies through it — Mermaid maps the same keys onto shapes because it has no icon primitive. Never add a second regex table; a queue drawn as a queue in one engine and a cylinder in another means the pictures no longer describe the same system.

Icons are drawn in this repo, by category rather than by vendor: no asset pack to vendor, no trademark terms, and one glyph that serves RDS, Cloud SQL and an on-prem Postgres alike.

Two things about the mechanism are load-bearing and easy to break:

- **The icon is never handed to Graphviz.** `image=` is resolved as a filesystem path by the native binary, so a `data:` URI would work on the WASM tier and fail on the native one. Instead `renderDot` reserves a fixed-size label cell holding a 1pt marker, and `injectIcons` swaps markers for inline SVG after layout. Both tiers therefore draw the same picture.
- **The marker must survive Graphviz's SVG escaping.** It is `@@dwicon_<key>@@` — letters, digits, `_` and `@` only. A hyphen comes back out as `&#45;` and the marker stops matching itself. CI asserts no marker survives into rendered output.

Node geometry is a design decision, not an accident: an icon above a name above a small muted `kind` gives a roughly 3:2 box, where a single line of text gives something nearer 6:1, and a page of 6:1 boxes is what reads as squashed.

### Engine tiers (the Graphviz answer)

| Tier | Requirement | Notes |
|---|---|---|
| `graphviz` native | `dot` on PATH | Opportunistic upgrade: faster on huge graphs, honours a site's own Graphviz build. Never required. |
| `graphviz` WASM | **nothing — bundled** | Real Graphviz compiled to WASM, a regular dependency. The default. |
| `dot` | nothing | Emits DOT *source*. Always available — it's just text. |
| `mermaid` | nothing | Always available, renders natively in GitHub. |

The only environment where Graphviz can't run is one with WebAssembly disabled (hardened runtime, `node --jitless`); there `auto` degrades to Mermaid. Rare but real, and asserted in CI — do not delete the fallback as dead code.

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
- Tests must pass both with Graphviz available (the default) and with WebAssembly disabled. Anything engine-dependent branches on `probe()`.

## The worked example

`examples/` holds a fictional e-commerce platform, `orders-platform`: 45 Terraform resources across edge (Route 53, CloudFront, ACM, WAF), network (VPC, subnets, security groups), an ALB in front of two ECS services, Postgres/Redis/DynamoDB/S3, an SQS+SNS+Lambda order pipeline, IAM and KMS, and CloudWatch. It is deliberately large enough that views are load-bearing rather than decorative.

- `orders-platform.tfstate.json` is the source of truth. `architecture.yaml` is `import terraform` output plus hand-written `views`, `ignore`, `aliases` and `coverage`, which no importer can infer.
- **If you change the state file, re-import and re-apply those four blocks** — `group` is a compared field, so a hand-edited group that the importer would not produce shows up as permanent drift and the CI drift gate goes red.
- `orders-platform.drifted.tfstate.json` is the same platform later: two resources created by hand, one deleted, one renamed. CI asserts that reconciling against it exits non-zero.

## Commands

```bash
npm test                       # vitest
npm run typecheck
npm run build
npx tsx src/cli.ts <command>   # run without building
npx tsx src/cli.ts engines     # what this machine can render with
npx tsx src/cli.ts providers   # what is registered
```

Run `npm run typecheck && npm test` before every commit. CI runs both, plus the drift gate, plus one job asserting Graphviz works from a plain install with no `dot` on PATH, and another running `--jitless` to assert the Mermaid fallback.
