# React build served by nginx, which also reverse-proxies /api to the api service.
FROM node:26-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN npm run build -w @ih/web

FROM nginx:1.31-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY deploy/docker/security-headers.conf /etc/nginx/snippets/security-headers.conf
# Rendered into conf.d at start from the environment (ADR 0012); blank = no framing.
COPY deploy/docker/frame-ancestors.conf.template /etc/nginx/templates/frame-ancestors.conf.template
ENV FRAME_ANCESTORS=""
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
