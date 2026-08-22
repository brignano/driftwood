#!/usr/bin/env bash
# Ensures a fresh session can immediately run tests, typecheck, and the CLI.
# Idempotent and safe to re-run; never fails the session.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 0

if [ ! -d node_modules ]; then
  echo "driftwood: installing dependencies..."
  npm ci --no-audit --no-fund 2>&1 | tail -3 || npm install --no-audit --no-fund 2>&1 | tail -3
fi

echo "driftwood: ready — npm test | npm run typecheck | npx tsx src/cli.ts engines"
