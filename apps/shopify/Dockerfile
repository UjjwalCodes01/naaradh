# apps/shopify — embedded Shopify app (shopify.naaradh.com). Cloud Run image.
#
# Build from the REPO ROOT:  docker build -f apps/shopify/Dockerfile -t naaradh-shopify .
# `react-router build` bundles the workspace packages (vite ssr.noExternal); their third-party
# dependencies are direct dependencies of the app, installed --prod and hoisted into /app.
# Base image pinned like the other services (docs/runbooks/deploy.md "Base image").
ARG NODE_IMAGE=node:22.23.2-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS fetch
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN pnpm fetch

FROM fetch AS build
COPY . .
RUN pnpm install --offline --frozen-lockfile --filter "@naaradh/shopify-app..." \
 && pnpm --filter @naaradh/shopify-app build

FROM fetch AS prod-deps
COPY . .
RUN rm -rf node_modules \
 && pnpm install --offline --frozen-lockfile --prod --filter "@naaradh/shopify-app" \
      --config.shamefully-hoist=true \
 && rm -rf node_modules/@naaradh

FROM ${NODE_IMAGE} AS runtime
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/apps/shopify/package.json ./package.json
COPY --from=build /repo/apps/shopify/build ./build
USER node
EXPOSE 8080
CMD ["node", "node_modules/@react-router/serve/bin.js", "build/server/index.js"]
