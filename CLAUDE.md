See [AGENTS.md](AGENTS.md) for the full working context: the architecture, the hard constraints, the extension points, and the design rules.

Read it before changing anything in `src/`.

Two rules that override any local convenience:

1. **Zero *required* native dependencies.** The base install must work with npm alone. Native things are optional peer dependencies behind a `probe()`.
2. **Read-only credentials only.** This tool observes and reports; it never mutates infrastructure.

Before every commit: `npm run typecheck && npm test`.
