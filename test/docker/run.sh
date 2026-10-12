#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
bash test/docker/build.sh
docker run --rm --name "opencode-queue-v2-test-$$" opencode-queue-v2-test
