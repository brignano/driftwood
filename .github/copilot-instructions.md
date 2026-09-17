# driftwood assistant context

Read `AGENTS.md` before changing `src/`. It is the canonical architecture and constraint guide.

Use the numbered files in `.github/instructions/` for workflow and security defaults. Use `.claude/skills/` for focused workflows; existing provider and renderer skills are authoritative for those extension points.

All repository changes belong on a feature branch and in a pull request; do not work directly on the protected branch.

Before delivery, run `npm run typecheck && npm test`. Run `npm run docs` when model or rendering behavior changes. Do not merge or release without explicit approval.
