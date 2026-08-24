---
name: driftwood-defaults
description: Default engineering workflow for driftwood TypeScript changes
applyTo: "**/*"
---

Before editing, read `AGENTS.md`, `package.json`, and the nearest implementation and test for the behavior.

Use Opus 5 by default for architecture, planning, review, risk analysis, and final synthesis. A faster coding model may handle repetitive edits, but final validation and synthesis return to Opus 5.

Use existing TypeScript, Zod, Vitest, and ESM patterns. Keep changes minimal, preserve public APIs, and test behavior and failure modes. Prefer repository tools and pure functions over new abstractions.

Quality gate: `npm run typecheck`, then `npm test`; run `npm run build` for packaging changes and `npm run docs` for rendering/model changes. Never claim verification without observing the command output.
