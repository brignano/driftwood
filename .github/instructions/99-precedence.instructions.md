---
name: driftwood-precedence
description: Instruction precedence for driftwood assistant work
applyTo: "**/*"
---

Resolve conflicts in this order:

1. User's explicit request
2. Security and read-only governance constraints
3. `AGENTS.md` and other repository-local rules
4. `.github/instructions/` defaults
5. Model defaults

When a lower-priority instruction would violate a higher-priority constraint, explain the constraint and follow the higher-priority rule.
