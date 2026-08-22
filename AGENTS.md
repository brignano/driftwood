# driftwood — AI context

**Architecture as code, reconciled with live infrastructure.** A versioned graph model in git, checked continuously against real platform data, with divergence surfaced as a pull request.

Origin: the idea brief in `brignano/ideas` at `proposals/architecture-as-code-reconciler.md`. That brief is the design rationale and still holds open questions; this repo is its implementation.

## The one architectural idea

Everything routes through **one model**. Nothing bypasses it.

```
providers -> model (git) -> renderers
                 ^
                 |
            reconciler (declared vs observed)
```

- **Providers** observe reality and emit entities/edges. They never own the file.
- **The model** (`architecture.yaml`) is the only thing committed. Schema in `src/model/schema.ts`.
- **Renderers** read the model and emit a picture. They never mutate it.
- **The reconciler** diffs declared against observed and reports drift.

When adding a feature, work out which of those four it is. If it doesn't fit one, it probably shouldn't be built — that decomposition is what makes "2D now, 3D later" and "static now, live health later" cheap instead of a rewrite.

## Hard constraints

These are not preferences. Breaking either defeats the project's purpose:

1. **Zero native dependencies.** No Graphviz, no system packages, no compiled binaries. The whole project exists because `mingrammer/diagrams` needs the Graphviz binary and that can't get through corporate software approval. Runtime deps are `commander`, `yaml`, `zod` — pure JS. Keep it that way.
2. **Read-only credentials only.** driftwood never mutates infrastructure. It observes and reports.

## Design rules

- **Never silently delete.** Read-only creds can't see everything. Unknown is not absent — that's what `coverage` is for. A provider that can't see something must not cause the reconciler to report it as removed.
- **`kind` is an open string, not an enum.** Any provider must be able to emit its own vocabulary without a schema change. Renderers pattern-match known kinds and fall back gracefully.
- **Views from v1.** Flat Mermaid dies past ~150 nodes. Never add a feature that assumes one flat graph.
- **Runtime state never enters git.** Health, latency, and error rates are render-time overlays only.
- **Drift policy: structural facts count, metadata doesn't.** See `COMPARED_FIELDS` in `src/reconcile/index.ts`. Widening this is a real decision with a real cost — noisy drift reports get muted, and a muted report is the same as no tool at all.

## Identity resolution

The hard problem, and where CMDBs historically die. Current approach: entity id **is** the Terraform address (`aws_s3_bucket.emails`) because it's stable across plans and readable in a diff.

This works for one cloud, one account, one naming convention. Matching a Terraform resource to a live cloud resource to an OTel service name to a source repo is a much harder problem and is **not** solved here. Don't pretend otherwise in docs or output.

## Conventions

- TypeScript, ESM, strict mode with `noUncheckedIndexedAccess`.
- Zod schemas are the source of truth for types — derive TS types with `z.infer`, never hand-write a parallel interface.
- Providers are pure functions: input data in, `Model` out. No I/O inside a provider; the CLI reads files.
- Every provider's output must pass `validateModel` — dangling edges are a bug in the provider, not something the validator should tolerate.
- Tests live in `test/`, named after the module under test. Cover the failure modes, not just the happy path.

## Commands

```bash
npm test        # vitest
npm run typecheck
npm run build
npx tsx src/cli.ts <command>   # run without building
```

Run `npm run typecheck && npm test` before any commit.
