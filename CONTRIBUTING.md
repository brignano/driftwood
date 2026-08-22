# Contributing

Read [AGENTS.md](AGENTS.md) first — it holds the architecture and the two hard constraints. This file is the short version.

## Setup

```bash
npm install
npm test
```

Optionally add Graphviz support without a system package:

```bash
npm install @hpcc-js/wasm-graphviz
npx tsx src/cli.ts engines   # should now report graphviz available
```

## Before every commit

```bash
npm run typecheck && npm test
```

## The two rules

1. **Zero required native dependencies.** The base install works with npm alone. This project exists because a required Graphviz binary made a tool un-installable inside a corporation. Optional native things live behind a `probe()` as optional peer dependencies.
2. **Read-only.** driftwood observes and reports. It never mutates infrastructure.

## Adding things

- **A provider** (Splunk, AWS API, GCP, Kubernetes, OTel): `.claude/skills/add-provider/SKILL.md`
- **A renderer** (D2, PlantUML, an interactive view): `.claude/skills/add-renderer/SKILL.md`

Both extension points use the same registry. A third-party plugin registers exactly the way a built-in does.

## Testing expectations

Cover failure modes, not just happy paths. The existing suite tests dangling edges, ignore-rule precedence, view filtering dropping half-visible edges, and alias-induced self-loops — match that standard.

Tests must pass whether or not Graphviz is installed; branch on `probe()` for anything engine-dependent.
