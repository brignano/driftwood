---
name: driftwood-secrets
description: Secret handling and read-only access rules for driftwood
applyTo: "**/*"
---

Never put secret values in chat, source, committed config, fixtures, logs, or pull requests. Configuration may contain environment variable names only; providers read values through `ctx.secret(name)` and never access `process.env` directly.

Use read-only credentials. If a secret is exposed, stop using it, remove it from tracked content, rotate it, and document the incident without reproducing the value.
