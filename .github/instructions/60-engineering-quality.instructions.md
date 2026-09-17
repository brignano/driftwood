---
name: driftwood-engineering-quality
description: Error handling, testing, and documentation standards for driftwood
applyTo: "**/*"
---

Catch errors at boundaries and preserve actionable context. Providers must not silently delete unknown resources, guess identity, mutate infrastructure, or perform I/O outside `observe`. Renderers must scope through `selectEntities`, drop invisible edges, escape labels, and keep health as a render-time overlay.

Derive types from Zod schemas. Validate models, reject dangling edges, and add regression tests for failure paths. Comments should explain why, not restate code. Update generated docs when rendering behavior changes.
