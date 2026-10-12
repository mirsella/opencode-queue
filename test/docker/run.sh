#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build -f test/docker/Dockerfile -t opencode-queue-v2-test .
docker run --rm --name "opencode-queue-v2-test-$$" opencode-queue-v2-test
