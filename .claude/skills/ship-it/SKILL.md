---
name: ship-it
description: Implement a driftwood issue end to end: inspect context, make focused changes, validate, and draft delivery notes without pushing or merging.
---

# Ship it

1. Load `repo-context` guidance and inspect the relevant implementation, tests, and worktree.
2. Create or use a focused feature branch; never work directly on the protected branch.
3. Make the smallest change that addresses the requested behavior. Preserve existing user changes.
4. Add or update focused regression tests, including failure paths where relevant.
5. Run `npm run typecheck && npm test`; run `npm run build` or `npm run docs` when applicable.
6. Review the diff for scope, generated artifacts, secrets, native dependencies, and read-only violations.
7. Commit and push the branch, then open a pull request with changed files, observed verification, residual risk, and a PR-ready summary.

Do not merge, tag, release, or mutate infrastructure without explicit approval.
