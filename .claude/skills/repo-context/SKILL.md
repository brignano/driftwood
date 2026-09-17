---
name: repo-context
description: Load driftwood architecture, conventions, constraints, and validation commands before a code change or review.
---

# Repository context

Use this workflow before changes that span files or layers.

1. Read `AGENTS.md`, `CLAUDE.md`, and `package.json`.
2. Identify whether the work belongs to provider, model, renderer, reconciler, CLI/config, or docs/tooling.
3. Read the nearest implementation and neighboring test before proposing an abstraction.
4. Check the worktree for unrelated changes and preserve them.
5. State the controlling code path, one falsifiable hypothesis, and the cheapest discriminating check.

Keep the summary short: relevant files, hard constraints, quality commands, and blast radius. Do not map the entire repository when local evidence is enough.
