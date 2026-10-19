# Build context: repo root.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/bridge-contract/package.json packages/bridge-contract/
COPY apps/bridge/package.json apps/bridge/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY packages/bridge-contract packages/bridge-contract
COPY apps/api apps/api
RUN npm run build -w @ih/shared && npm run build -w @ih/bridge-contract \
    && npm run build -w @ih/api && npm prune --omit=dev

FROM node:24-alpine
# pg_dump/pg_restore for Administration > Backup: the same major version as the server (17).
RUN apk add --no-cache postgresql17-client
ENV NODE_ENV=production \
    SPECS_DIR=/app/specs \
    MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/bridge-contract/package.json packages/bridge-contract/
COPY --from=build /app/packages/bridge-contract/dist packages/bridge-contract/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db/migrations db/migrations
COPY specs specs
# The build's calendar version (ADR 0014). Last, so a new version reuses every layer above.
ARG APP_VERSION=dev
ARG APP_VERSION_PREVIOUS=
ARG APP_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION     APP_VERSION_PREVIOUS=$APP_VERSION_PREVIOUS     APP_COMMIT=$APP_COMMIT
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
