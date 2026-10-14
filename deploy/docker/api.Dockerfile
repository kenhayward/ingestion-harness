# Build context: repo root.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npm run build -w @ih/shared && npm run build -w @ih/api && npm prune --omit=dev

FROM node:26-alpine
ENV NODE_ENV=production \
    SPECS_DIR=/app/specs \
    MIGRATIONS_DIR=/app/db/migrations
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/api/package.json apps/api/
COPY --from=build /app/apps/api/dist apps/api/dist
COPY db/migrations db/migrations
COPY specs specs
USER node
EXPOSE 3000
CMD ["node", "apps/api/dist/server.js"]
