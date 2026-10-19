# The delivery bridge (docs/superpowers/specs/2026-10-19-delivery-bridge-design.md).
# Build context: repo root.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/bridge-contract/package.json packages/bridge-contract/
COPY apps/api/package.json apps/api/
COPY apps/bridge/package.json apps/bridge/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/bridge-contract packages/bridge-contract
COPY apps/bridge apps/bridge
RUN npm run build -w @ih/bridge-contract && npm run build -w @ih/bridge && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production \
    BRIDGE_MIGRATIONS_DIR=/app/db/bridge-migrations
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/bridge-contract/package.json packages/bridge-contract/
COPY --from=build /app/packages/bridge-contract/dist packages/bridge-contract/dist
COPY --from=build /app/apps/bridge/package.json apps/bridge/
COPY --from=build /app/apps/bridge/dist apps/bridge/dist
COPY db/bridge-migrations db/bridge-migrations
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
USER node
EXPOSE 3100
CMD ["node", "apps/bridge/dist/server.js"]
