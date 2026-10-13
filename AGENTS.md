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

1. **No native dependencies, ever.** The whole install must work with npm alone — no compiled addons, no system packages, no post-install build step. This project exists because `mingrammer/diagrams` needs the Graphviz *binary* and that can't clear corporate software approval. Pure JS and WebAssembly are both fine and may be regular dependencies; a native binary may only ever be an *opportunistic upgrade* discovered by `probe()`, never something the tool needs. Runtime deps: `commander`, `yaml`, `zod`, `@hpcc-js/wasm-graphviz`, `@brignano/design` (plain CSS).
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

Colour comes from the shared design system, [`@brignano/design`](https://github.com/brignano/design), through `src/design.ts`, which reads its stylesheets from the installed package. **Never write a hex in `src/`.** The viewer inlines the stylesheets and uses the tokens as CSS properties; diagrams cannot evaluate `var()`, so they take `LIGHT`, the light theme resolved to literals (every diagram is drawn on a white card). Families use the categorical palette (`--chart-1…6`) in its validated order; health and change marks use the state tokens (`--success`, `--attention`, `--danger`, and `--i` for an update), and are always worded as well as coloured. `test/design.test.ts` fails if a renderer emits a colour the design system does not declare.

Icons are drawn in this repo, by category rather than by vendor: no asset pack to vendor, no trademark terms, and one glyph that serves RDS, Cloud SQL and an on-prem Postgres alike. Being vendor-neutral is what makes a second declarative provider cheap — CloudFormation type names (`AWS::ECS::Service`) and GCP kinds classify correctly with no new rules.

`kindLabel` owns the muted second line, and shows an entity's `platform` only when its `kind` does not already state it. `aws_s3_bucket` on platform `aws` would be noise; a Dynatrace `SERVICE` on platform `aws` is the only thing telling a reader which cloud it runs in. It lives beside the classification table for the same reason everything else does: a node labelled `aws` in one engine and not in another means the pictures no longer describe the same system.

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

- **Never silently delete.** Read-only creds can't see everything. Unknown is not absent — that's what `coverage` is for. A provider that can't see something must never cause the reconciler to report it removed. Enforced in `reconcile`: a declared-but-unobserved entity inside a `coverage` scope lands in `unverifiable` rather than `removed`, an edge inherits either endpoint's blind spot, and neither counts towards `hasDrift`. The rule is one-directional — coverage never suppresses an addition, and never touches a change, because a compared entity was observed.
- **Never guess identity.** Terraform's `aws_lambda_function.fn` and Dynatrace's `SERVICE-A1B2` only merge via an explicit `aliases` entry. A duplicated node is visible and fixable; a wrongly merged node silently corrupts the graph. Do not add heuristic matching without a very deliberate decision.
- **Surface disagreement, don't hide it.** When providers conflict, `mergeModels` resolves *and* records the conflict.
- **`kind` is an open string, not an enum.** Any provider must emit its own vocabulary without a schema change. Renderers pattern-match known kinds and fall back.
- **Views from v1.** Flat graphs die past ~150 nodes. Never add a feature that assumes one flat graph.
- **Runtime state never enters git.** Health, latency, error rates are render-time overlays only.
- **Drift policy: structural facts count, metadata doesn't.** See `COMPARED_FIELDS` in `src/reconcile/index.ts`. Widening it has a real cost — noisy drift reports get muted, and a muted report equals no tool at all.
- **A provider's error message is its user interface.** They are written for whoever is reading a CI log, so the CLI catches at the top level and prints the message alone — `parseAsync` returns a promise, and leaving it unhandled turned every provider failure into twenty lines of stack with the useful sentence in the middle. `test/cli.test.ts` is the only test that spawns the CLI, because whether that promise is handled at all cannot be checked any other way.
- **Providers never do I/O outside `observe`.** Pure mapping functions (`importTerraformState`, `toModel`) stay separately exported and unit-tested without network or disk.
- **An observation crossing machines carries its own age.** `src/model/observation.ts` wraps a `Model` in an envelope with `observedAt`, per-provider counts and free-form `origin`, because the machine that deploys is usually not the machine that holds the model. A bare model says nothing about when it was true, and a stale one reaching the reconciler reads as mass deletion — the same hazard as a coverage gap, by a different route. So the `observation` provider refuses an artifact past `maxAgeMinutes`, and refuses a future-dated one rather than treating clock skew as fact. It throws rather than returning a partial model, matching `observeAll`: a provider that cannot answer aborts the run. Provider disagreements are deliberately *not* in the envelope — they describe the observing run, and carrying them would mean a second hand-written copy of `MergeConflict`'s shape.
- **A snapshot reports; it never gates.** `snapshot` (`src/snapshot.ts`) runs as the last step of a deploy and always exits 0 on drift, because a post-deploy step that fails the deploy over a report gets removed. `reconcile` is the gate. Two rules keep it honest: only `views` are borrowed from the committed model, so the diagrams describe what is deployed rather than the design; and "changed since the previous deploy" is computed under the committed model's `ignore` and `coverage`, since an observation carries neither and a blind spot would otherwise read as a removal on every deploy. A missing `--previous` is a first deploy, not an error; a present but unparseable one is an error, because dropping it would report every entity as new. Every snapshot carries a typed `subject` (app, environment, optional build), and comparing against another subject's snapshot is refused for the same reason. A store (`--store`) files snapshots at `<app>/<env>/<build>/` with a `latest.json` pointer that only moves forward, so an out-of-order pipeline cannot make the platform show a stale picture. driftwood writes the store locally and never uploads it; that is the pipeline's job, which keeps it free of write credentials.
- **The viewer is one file and trusts nothing it shows.** `renderViewer` (`src/viewer.ts`) writes `index.html` into every snapshot with the snapshot, diagrams and script all inline, because a store is served from wherever a pipeline uploaded it and nothing guarantees a second asset or a CDN is reachable. It derives nothing the snapshot did not already decide; blast radius is graph traversal over the snapshot's edges, computed in the browser. Entity names come from infrastructure, so they reach the DOM only through `textContent`, and the embedded JSON escapes `<` so a name cannot close its script tag. Both are tested. SVG is inserted as markup because Graphviz escapes labels; node `<title>`s are entity ids, which is how a click maps to an entity.
- **A plan preview reads the plan and nothing else.** `previewPlan` (`src/preview.ts`) turns `terraform show -json <planfile>` into a pull request comment: no credentials, no network, never an apply, and exit 0 whatever the plan does. The plan already holds the before (`prior_state`), the after (`planned_values`) and Terraform's verb per instance (`resource_changes`); the preview reports Terraform's verbs (create, update, replace, destroy) rather than inventing its own, one per entity, with replace winning over update because it is the one that loses data. A resource whose `count` grows is updated, not created. Edges of the resources a plan touches come from the plan's `configuration`, since state only knows what they depended on at the last apply; untouched resources keep their state edges, so a quirk in how references were recorded never reads as a change. The diagram draws the touched resources plus only the other ends of relationships the plan adds or removes and whatever depends on a replaced or destroyed resource; a first version drew every one-hop neighbour and the picture was half subnets and security groups. Removed relationships are drawn dashed, never as plain arrows. Against `--model` it names only what this plan causes, and counts drift that was already there; coverage is set aside for destroys, because a plan that destroys a blind-spot resource is not guessing. The comment starts with `PREVIEW_MARKER` so a workflow edits its one comment instead of adding one per push, and names reach it only escaped: table cells escape `|` and `<`, code spans widen their fence past any backtick, and Mermaid labels escape HTML.
- **Both Terraform JSON shapes go through one importer.** `stateFromValues` converts the values representation (`terraform show -json`, a plan's `prior_state` and `planned_values`) into the raw state's shape, so the two cannot disagree about ids, names or groups. Instance indexes are stripped (`aws_subnet.a[0]` is `aws_subnet.a`), module keys are kept, and a plan handed to the state importer is refused by name rather than read as an empty estate.
- **A fetched state is as fresh as the fetch.** `terraform-cloud` (`src/providers/terraform-cloud.ts`) reads a workspace's *current* state version live, so it deliberately has no `maxAgeMinutes`. A state version's age is when someone last applied, not how stale the answer is. A workspace with no state is an error, not an empty model. The bearer token is sent only to the configured address's origin. A server-chosen download URL on any other host is fetched without it. `fetchCurrentState` takes an injectable `fetch` so every failure path is tested without a network.
- **S3 is signed by hand, not through the AWS SDK.** `terraform-s3` makes one signed GET (`src/providers/aws-sigv4.ts`), so `@aws-sdk/client-s3` and its dozens of transitive packages would buy nothing the four-dependency table can afford. The signer is checked against the GetObject example in the S3 docs. It refuses query strings rather than signing them half-correctly. Credentials come only from env vars through `ctx.secret`. A credential chain (profiles, SSO, instance metadata) is most of an SDK, and `aws configure export-credentials --format env` bridges the gap. Like `terraform-cloud`, it has no `maxAgeMinutes`, and every S3 error is translated into the config field that fixes it.
- **Writing the model back edits the document, never regenerates it.** `applyDrift` (`src/model/apply.ts`) mutates the parsed YAML document in place, because its output is a pull request diff. `dumpModel` would produce a semantically identical file that drops every comment and reflows every block, which is how three real changes become a six-hundred-line diff nobody reviews. Three rules follow, all tested: only compared fields are written (hand-set `level`, hand-added `tags` survive); additions are inserted in sorted position with `localeCompare`, the ordering the importer uses, so a re-import reproduces the file; and the source's trailing-newline convention is preserved. The writer must also converge — reconciling its output reports no drift — or a scheduled job proposes the same pull request every morning.

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
- `orders-platform.drifted.tfstate.json` is the same platform later: two resources created by hand, one deleted, one renamed, and one secret absent because the role reading the state cannot list secrets. CI asserts that reconciling against it exits non-zero, that the deleted bucket is reported as removed, and that the invisible secret is not.

`docs/` holds committed renders of that example, embedded in the README, generated by `scripts/render-docs.ts`. **Change the model or anything that affects rendering and you must run `npm run docs` and commit the result** — CI re-runs it and fails if the committed output differs, so a rendering change that leaves the README showing the old picture cannot merge. The script pins the WASM tier: layout is byte-deterministic per Graphviz build, and a native `dot` is a different build, so pinning is what keeps a contributor who has Graphviz installed from producing a spurious diff.

## Commands

```bash
npm test                       # vitest
npm run typecheck
npm run build
npx tsx src/cli.ts <command>   # run without building
npx tsx src/cli.ts engines     # what this machine can render with
npx tsx src/cli.ts providers   # what is registered
npx tsx src/cli.ts observe     # capture an observation to reconcile elsewhere
npx tsx src/cli.ts preview     # a Terraform plan drawn as a pull request comment
npx tsx src/cli.ts snapshot    # post-deploy bundle for a build page: diagrams, changes, drift
npm run docs                   # regenerate docs/ and the README's embedded render
```

`examples/drift-pr.yml`, `examples/observe-publish.yml`, `examples/plan-preview.yml` and `examples/snapshot-after-deploy.yml` are workflow templates people copy into their own repository, so CI is the only thing standing between a renamed CLI flag and a broken workflow everywhere it was copied. `test/docs.test.ts` asserts the flags they pass still exist. `.github/workflows/demo.yml` runs three deploys into one snapshot store on every PR and asserts the layout and the previous-deploy lookup a platform integration relies on. Its `plan-preview` job draws `examples/orders-platform.plan.json` and posts the comment on the PR. That plan's `prior_state` is the example state in the values format, with six changes on top; `test/preview.test.ts` asserts the two import identically, so changing the state file means updating the plan's `prior_state` to match.

Run `npm run typecheck && npm test` before every commit. CI runs both, plus the drift gate, plus the docs freshness gate, plus one job asserting Graphviz works from a plain install with no `dot` on PATH, and another running `--jitless` to assert the Mermaid fallback.
