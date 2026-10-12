#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
docker build --quiet -f test/docker/Dockerfile -t opencode-queue-v2-test .

mounts=(--mount "type=volume,source=${OPENCODE_QUEUE_DOCKER_VOLUME:-opencode-queue-v2-tui},destination=/workspace/test-state")
auth="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
if [[ -f "$auth" ]]; then
  mounts+=(--mount "type=bind,source=$auth,destination=/host-auth.json,readonly")
fi

exec docker run --rm -it --name "opencode-queue-v2-tui-$$" \
  "${mounts[@]}" --env "TERM=${TERM:-xterm-256color}" \
  --entrypoint bash opencode-queue-v2-test -c '
    mkdir -p "$XDG_DATA_HOME/opencode"
    if [[ -f /host-auth.json && ! -e "$XDG_DATA_HOME/opencode/auth.json" ]]; then
      install -m 600 /host-auth.json "$XDG_DATA_HOME/opencode/auth.json"
    fi
    printf "%s\n" "{\"plugins\":[\"/workspace\"]}" > /workspace/opencode.json
    exec opencode2 --standalone "$@" /workspace
  ' opencode-queue "$@"
