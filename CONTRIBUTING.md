# Contributing

Read [AGENTS.md](AGENTS.md) first — it holds the architecture and the two hard constraints. This file is the short version.

## Setup

```bash
npm install
npm test
```

Graphviz works immediately — it ships as a bundled WASM build, so there is nothing to install:

```bash
npx tsx src/cli.ts engines   # graphviz should report available
```

Installing the native `dot` binary is optional; driftwood will prefer it when present, but never needs it.

## Before every commit

```bash
npm run typecheck && npm test
```

## The two rules

1. **No native dependencies, ever.** The install works with npm alone. This project exists because a required Graphviz binary made a tool un-installable inside a corporation. Pure JS and WebAssembly are fine as regular dependencies; a native binary may only be an opportunistic upgrade found by `probe()`.
2. **Read-only.** driftwood observes and reports. It never mutates infrastructure.

## Adding things

- **A provider** (Splunk, AWS API, GCP, Kubernetes, OTel): `.claude/skills/add-provider/SKILL.md`
- **A renderer** (D2, PlantUML, an interactive view): `.claude/skills/add-renderer/SKILL.md`

Both extension points use the same registry. A third-party plugin registers exactly the way a built-in does.

## Testing expectations

Cover failure modes, not just happy paths. The existing suite tests dangling edges, ignore-rule precedence, view filtering dropping half-visible edges, and alias-induced self-loops — match that standard.

Tests must pass both with Graphviz available (the default) and under `node --jitless`, where WebAssembly is disabled. Branch on `probe()` for anything engine-dependent.
