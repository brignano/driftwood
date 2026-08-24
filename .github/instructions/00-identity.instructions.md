---
name: driftwood-identity
description: Repository identity and architecture boundaries for driftwood
applyTo: "**/*"
---

This repository is driftwood: architecture as code reconciled with live infrastructure.

Route features through one of four layers: providers observe reality, the model is committed state, renderers emit views, and the reconciler compares declared with observed. Preserve those boundaries and use existing abstractions before adding new ones.

`AGENTS.md` is the detailed source of truth. When instructions conflict, follow the user's explicit request, security constraints, repository rules, then these defaults.
