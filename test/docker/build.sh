#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
version="${OPENCODE_VERSION:-$(pnpm view @opencode/cli@2 version --json | node -e 'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>{const v=JSON.parse(s);process.stdout.write(Array.isArray(v)?v.at(-1):v)})')}"
if [[ ! "$version" =~ ^2\.[0-9]+\.[0-9]+$ ]]; then
  echo "Expected a stable OpenCode v2 release, received: $version" >&2
  exit 1
fi
docker build "$@" --build-arg "OPENCODE_VERSION=$version" -f test/docker/Dockerfile -t opencode-queue-v2-test .
