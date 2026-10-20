# syntax=docker/dockerfile:1
# Build context: the repository root.
FROM --platform=$BUILDPLATFORM node:24.22.0-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY app/package.json app/
COPY e2e/package.json e2e/
COPY scripts/install-platform-bindings.mjs scripts/
# The dev dependencies are for the tests only. better-sqlite3 needs Python to compile.
# CI=1 skips the bindings for other platforms.
RUN CI=1 npm ci --workspace app --omit=dev --no-audit --no-fund
COPY app/ app/
WORKDIR /src/app
# Copies the PowerSync web worker and wasm assets into public/@powersync.
RUN npx powersync-web copy-assets \
    && npx expo export --platform web --output-dir dist

FROM nginxinc/nginx-unprivileged:1.30.6-alpine
COPY deploy/docker/web-nginx.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /src/app/dist /usr/share/nginx/html
# The entrypoint substitutes only variables that are set. An unset variable
# stays as an nginx variable and nginx refuses to start.
ENV POWERSYNC_URL="" \
    POWERSYNC_WS_URL=""
EXPOSE 8080
