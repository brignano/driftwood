---
name: driftwood-git-workflow
description: Git and pull request standards for driftwood
applyTo: "**/*"
---

Every repository change must be made on a focused feature branch and delivered through a pull request. Never make changes directly on the protected branch. Use conventional commit subjects.

Creating the branch, commit, push, or pull request is allowed when needed to satisfy this workflow; merging remains an explicit user decision. Never rewrite history.

Pull requests should state what changed, why, which layer owns it, verification commands and observed results, risk, and any docs/model freshness impact. Keep unrelated worktree changes intact.
