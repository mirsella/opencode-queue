#!/usr/bin/env bash
set -euo pipefail
opencode2 --version
pnpm test
pnpm typecheck
pnpm exec tsx --test test/integration.test.ts
