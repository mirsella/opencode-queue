FROM node:24-bookworm-slim
RUN apt-get update && apt-get install --no-install-recommends -y git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
ARG OPENCODE_VERSION=2
RUN pnpm add --global @opencode/cli@${OPENCODE_VERSION} --global-dir /opt/opencode --global-bin-dir /usr/local/bin
RUN node /opt/opencode/5/node_modules/@opencode/cli/postinstall.mjs
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
ENV XDG_CONFIG_HOME=/workspace/test-state/config XDG_DATA_HOME=/workspace/test-state/data XDG_CACHE_HOME=/workspace/test-state/cache
CMD ["bash", "test/docker/check.sh"]
