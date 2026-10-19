# The sink contract's conformance suite, for external sinks to run in their own CI:
#   docker run --rm -e SINK_URL=... -e SINK_KEY=... -e SINK_INSTANCE=... \
#     [-e SINK_CREDENTIAL='{"username":"..."}'] [-e SINK_DESTINATION='{"repository":"..."}'] \
#     ghcr.io/<owner>/ct-bridge-conformance:<version>
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
RUN npm run build -w @ih/bridge-contract && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/bridge-contract/package.json packages/bridge-contract/
COPY --from=build /app/packages/bridge-contract/dist packages/bridge-contract/dist
# The suite delivers the shared document fixture (read relative to dist/conformance).
COPY packages/bridge-contract/test/fixtures packages/bridge-contract/test/fixtures
USER node
ENTRYPOINT ["node", "packages/bridge-contract/dist/conformance/cli.js"]
