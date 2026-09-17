---
name: test-agent
description: Add or review Vitest coverage for driftwood behavior, regressions, provider failures, renderer fallbacks, and reconciliation edge cases.
---

# Test agent

Test observable behavior rather than implementation details. Start with the nearest test file and existing fixtures.

Cover the success path and the cheapest meaningful failures: invalid config before I/O, missing identifiers, dangling or half-visible edges, alias self-loops, unknown resources, renderer probe failures, and `node --jitless` fallback behavior when relevant.

Keep tests deterministic and independent of native Graphviz. Run the narrow test first, then `npm run typecheck && npm test`. Report commands and actual results.
