See [AGENTS.md](AGENTS.md) for the full working context: the architecture, the hard constraints, the extension points, and the design rules.

Read it before changing anything in `src/`.

Two rules that override any local convenience:

1. **No native dependencies, ever.** The whole install must work with npm alone. Pure JS and WebAssembly are fine as regular dependencies (Graphviz ships as WASM). A native binary may only be an *opportunistic upgrade* found by `probe()` — never something the tool needs.
2. **Read-only credentials only.** This tool observes and reports; it never mutates infrastructure.

Before every commit: `npm run typecheck && npm test`.
