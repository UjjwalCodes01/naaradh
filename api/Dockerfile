# api — public REST API (api.naaradh.com). Production image for Cloud Run.
#
# Build from the REPO ROOT (workspace packages and the lockfile live there):
#   docker build -f api/Dockerfile -t naaradh-api .
# Works with BuildKit and with the legacy builder (no cache mounts / heredocs on purpose).
#
# Stages: fetch (lockfile → pnpm store) → build (tsup bundle) → prod-deps (production-only
# node_modules) → runtime (non-root, no npm/corepack, no sources, no dev deps).
#
# The base image is pinned by tag AND multi-arch index digest. To refresh (all four
# */Dockerfile together — docs/runbooks/deploy.md "Base image"):
#   docker pull node:22.<x>.<y>-bookworm-slim
#   docker inspect --format '{{index .RepoDigests 0}}' node:22.<x>.<y>-bookworm-slim
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
# pnpm version comes from "packageManager" in the root package.json (pnpm@9.15.9).
RUN corepack enable
WORKDIR /repo

# Only the lockfile decides what is downloaded, so this layer survives source-only changes.
FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

# ---------------------------------------------------------------------------------------------
FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@naaradh/api..." \
 && pnpm --filter @naaradh/api build

# Production dependencies of the app AND of every workspace package it bundles, publicly hoisted
# into the root node_modules (shamefully-hoist) so the bundle's bare imports resolve from /app.
# Not node-linker=hoisted: with --filter, pnpm 9's hoisted linker also installs other workspace
# projects' dependencies (vitest/vite/esbuild from engines/harness) — dev tooling in prod.
FROM fetch AS prod-deps
COPY . .
# `pnpm fetch` left a full virtual store (dev deps included) in node_modules/.pnpm — start clean;
# --offline installs from the content-addressable store it populated.
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@naaradh/api..." \
      --config.shamefully-hoist=true \
 && rm -rf node_modules/@naaradh node_modules/.bin
# (@naaradh/* are bundled into dist/ by tsup noExternal; their workspace links would dangle.)

# ---------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime
# The runtime never installs anything: drop the package managers and their CVE surface.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production \
    NODE_OPTIONS=--enable-source-maps
WORKDIR /app
# Everything stays owned by root: the process user can read the code, never change it.
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/api/package.json ./package.json
COPY --from=build /repo/api/dist ./dist
# Fail the BUILD, not the first request, if a runtime import cannot be resolved.
# (The script must sit in /app so that its import.meta.resolve() searches /app/node_modules.)
COPY infra/docker/check-imports.mjs ./check-imports.mjs
RUN node check-imports.mjs dist && rm check-imports.mjs
USER node
# Cloud Run injects PORT (8080 unless the service says otherwise); the app binds 0.0.0.0:$PORT.
EXPOSE 8080
CMD ["node", "dist/index.js"]
