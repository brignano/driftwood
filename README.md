# driftwood

**Architecture as code, reconciled with live infrastructure.**

A versioned architecture *model* in git that is continuously checked against reality — Terraform state today, cloud APIs and telemetry later. When the model and the infrastructure diverge, that divergence becomes a pull request instead of a diagram nobody trusts.

> Status: **proof of concept.** The core loop works end to end. See [Where this is going](#where-this-is-going) for what is deliberately not built yet.

## Why

Two problems that are usually treated separately share one root cause:

- **Diagrams-as-code tools** (Structurizr, C4, `mingrammer/diagrams`, D2) move the picture into git but don't stop it rotting. A hand-maintained model decays exactly like a Visio file, just with better blame.
- **Live topology tools** (Dynatrace Smartscape, Datadog Service Map, Kiali) show real discovered topology but produce no artifact — nothing to version, nothing to review, no expression of design *intent*, and nothing a coding agent can edit.

Nobody owns the middle. driftwood is the middle.

### No Graphviz

`mingrammer/diagrams` requires the Graphviz **system binary**, which is often impossible to get approved inside a corporate environment. driftwood has **zero native dependencies** — it renders to Mermaid, which GitHub and GitLab render natively, so the reader installs nothing at all.

This is a hard constraint, not a preference. A tool that needs a system package doesn't get installed.

## How it fits together

```mermaid
flowchart LR
    subgraph Providers["Providers — observe"]
        TF["Terraform state"]
        SOON["cloud APIs · OTel<br/>(not yet)"]
    end
    subgraph Core["Core"]
        MODEL["architecture.yaml<br/>entities · edges · views<br/>(versioned in git)"]
        REC["Reconciler<br/>declared vs observed"]
    end
    subgraph Renderers["Renderers — present"]
        MMD["Mermaid"]
        LATER["2D live · 3D<br/>(not yet)"]
    end
    TF --> REC
    SOON -.-> REC
    MODEL --> REC
    REC -->|"divergence"| MODEL
    MODEL --> MMD
    MODEL -.-> LATER
```

The model is the only thing in git. Providers write into it, renderers read from it, the reconciler diffs it. Because everything routes through one model, "static diagram vs. live health" and "2D vs. 3D" are rendering modes rather than rewrites — health is just an attribute on a node, and blast radius is a traversal over edges that already exist.

## Install

```bash
npm install
npm run build
```

Requires Node 20+. Runtime dependencies are `commander`, `yaml`, and `zod` — all pure JavaScript.

## Usage

### Import a model from Terraform state

```bash
npx tsx src/cli.ts import terraform examples/aws-config.tfstate.json \
  --name aws-config -o examples/architecture.yaml
```

Entity ids are Terraform addresses (`aws_s3_bucket.emails`). That's deliberate: the address is stable across plans, readable in a diff, and sidesteps the identity-resolution problem that kills CMDBs. Edges come from Terraform's own `dependencies`.

### Validate

```bash
npx tsx src/cli.ts validate examples/architecture.yaml
```

Catches schema errors, duplicate ids, edges pointing at entities that don't exist, and views that match nothing. This is what makes agent edits safe to accept — a coding agent can rewrite the model and CI proves it's still coherent.

### Render

```bash
npx tsx src/cli.ts render examples/architecture.yaml --view email
```

```mermaid
flowchart LR
    subgraph n_lambda["lambda"]
        n_aws_lambda_function_email_forwarder["email-forwarder<br/>aws_lambda_function"]
    end
    subgraph n_s3["s3"]
        n_aws_s3_bucket_emails[("brignano.io-emails<br/>aws_s3_bucket")]
    end
    subgraph n_ses["ses"]
        n_aws_ses_receipt_rule_set_main["main<br/>aws_ses_receipt_rule_set"]
        n_aws_ses_receipt_rule_archive["archive-hi<br/>aws_ses_receipt_rule"]
        n_aws_ses_receipt_rule_forward["forward-hi<br/>aws_ses_receipt_rule"]
        n_aws_ses_receipt_rule_noreply["bounce-noreply<br/>aws_ses_receipt_rule"]
    end
    n_aws_lambda_function_email_forwarder --> n_aws_s3_bucket_emails
    n_aws_ses_receipt_rule_archive --> n_aws_s3_bucket_emails
    n_aws_ses_receipt_rule_archive --> n_aws_ses_receipt_rule_set_main
    n_aws_ses_receipt_rule_forward --> n_aws_lambda_function_email_forwarder
    n_aws_ses_receipt_rule_forward --> n_aws_ses_receipt_rule_set_main
    n_aws_ses_receipt_rule_noreply --> n_aws_ses_receipt_rule_set_main
```

**Views exist from v1, not as a later optimization.** Flat Mermaid becomes unreadable past roughly 150 nodes, and any real enterprise graph blows through that immediately. A view is a scoped slice matching entity ids or groups, with a trailing `*` wildcard.

### Reconcile — the point of the whole thing

```bash
npx tsx src/cli.ts reconcile examples/architecture.yaml \
  --terraform examples/aws-config.drifted.tfstate.json
```

```markdown
## Architecture drift detected

### Present in infrastructure, missing from the model (2)
- `aws_cloudfront_distribution.cdn` - aws_cloudfront_distribution (d123.cloudfront.net)
- `aws_sqs_queue.dlq` - aws_sqs_queue (email-forwarder-dlq)

### Declared in the model, not found in infrastructure (1)
- `aws_ses_receipt_rule.noreply` - aws_ses_receipt_rule (bounce-noreply)

### Relationships
- **added** `aws_cloudfront_distribution.cdn` -> `aws_s3_bucket.emails`
- **added** `aws_sqs_queue.dlq` -> `aws_lambda_function.email_forwarder`
- **removed** `aws_ses_receipt_rule.noreply` -> `aws_ses_receipt_rule_set.main`
```

Exits **1** on drift and **0** when clean, so it works directly as a CI gate. Output is markdown because its destination is a pull request body.

## The drift policy

This is the design decision most likely to sink the project in practice. Report too much and every run becomes noise that gets muted; report too little and the model rots anyway.

**Default: structural facts count, metadata doesn't.**

| Change | Drift? |
|---|---|
| A resource appears or disappears | **Yes** |
| An edge appears or disappears | **Yes** |
| `kind`, `name`, or `group` changes | **Yes** |
| A tag is added or changed | No |
| Anything matching an `ignore` rule | No |

`ignore` holds intentional divergence, reviewed like code. An edge touching an ignored entity is ignored by implication — otherwise ignoring one noisy resource would still surface all of its edges.

## Coverage gaps are explicit

Read-only credentials never see everything, and **unknown must never be silently reported as absent**. The model declares its own blind spots:

```yaml
coverage:
  - scope: aws_secretsmanager_*
    reason: the read-only role used by CI cannot list secrets
```

These are printed with every drift report. "Always matches live platform data" is a promise no tool can keep; reconciliation with declared blind spots is one it can.

## Project layout

```
src/
  model/schema.ts        the model — entities, edges, views, ignore, coverage
  model/validate.ts      schema + referential integrity
  providers/terraform.ts Terraform state (v4) -> observed model
  render/mermaid.ts      model + view -> Mermaid
  reconcile/index.ts     declared vs observed -> drift report
  cli.ts                 validate · render · import · reconcile
examples/                a worked AWS example, plus a deliberately drifted copy
```

## Development

```bash
npm test        # 46 tests
npm run typecheck
npm run build
```

## Where this is going

Built:

- [x] The model, with a schema and a real validator
- [x] Terraform state provider
- [x] Mermaid renderer with scoped views
- [x] Reconciler with an explicit drift policy, wired as a CI gate

Deliberately not built yet, roughly in order:

- [ ] Open the drift report as an actual pull request, not just a CI failure
- [ ] Live cloud API providers (AWS, GCP) to catch resources no IaC owns
- [ ] Preserve human/agent annotations across regeneration
- [ ] Health overlay on the 2D graph (the renderer already accepts it)
- [ ] Interactive viewer, blast-radius traversal
- [ ] 3D — last, optional, and only if someone actually asks

**On 3D:** it's the reward, not the plan. Netflix's Vizceral was the flagship of exactly this concept and is effectively abandoned; Cloudcraft deliberately stopped at 2.5D isometric because it stays readable and screenshot-able. 3D topology demos brilliantly and then goes unused during incidents — it occludes, doesn't diff, doesn't paste into a postmortem, and needs a mouse. Build the model first and a 3D view stays cheap to add later.

## License

MIT
