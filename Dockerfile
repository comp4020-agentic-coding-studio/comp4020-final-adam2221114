# syntax = docker/dockerfile:1

# Server-authoritative Node app. Whatever this image runs must serve HTTP on
# 0.0.0.0:$PORT (fly.toml sets PORT) and publish README.md at /readme/
# (spec/README.md says what's checked) — src/server/index.ts does both.
#
# Single stage on purpose: better-sqlite3 compiles a native binding at install
# time, so build and runtime share one image rather than risk an ABI mismatch
# copying node_modules across stages. Image size isn't the constraint here —
# fly.toml's 256MB machine is, and this fits it comfortably.

FROM docker.io/library/node:24-slim

# node-gyp's toolchain, needed once, to build better-sqlite3's native binding.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

# Pin the same pnpm the course's mise.toml pins, so local, CI and this image
# all resolve dependencies the same way.
RUN corepack enable && corepack prepare pnpm@11.9.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm run build

ENV PORT=8080
CMD ["node", "dist/server/index.js"]
