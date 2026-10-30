# syntax=docker/dockerfile:1
# blueprincedraw — static Excalidraw front-end served by a ~200-line Node stdlib server.
# Box contract rules 1–4, 12: distroless, uid 10001, read-only, no state, base images pinned by digest.

FROM node:24-trixie-slim@sha256:54f84b4cf8432b21aaffd5d3ce8d41e12cea0d10d33c09d2f3c9879d49d6b446 AS build
WORKDIR /src
# Dependencies first: frozen lockfile, no install scripts, nothing younger than 7 days (.npmrc).
COPY package.json package-lock.json .npmrc ./
RUN npm ci --no-audit
COPY tsconfig.json vite.config.ts index.html ./
COPY scripts ./scripts
COPY src ./src
COPY server ./server
COPY test ./test
# build = copy Excalidraw fonts/locales locally + typecheck + vite + brotli/gzip twins; then the tests
RUN npm run build && npm test

FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:a6c34457f6da4295807e051411c7783739c65b997a324fed14e4fa292615ae91
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="blueprincedraw" \
      org.opencontainers.image.description="Excalidraw for humongous boards; boards stay in the visitor's browser" \
      org.opencontainers.image.source="https://github.com/pazka/blueprincedraw" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}"
ENV NODE_ENV=production APP_VERSION=${VERSION}
COPY --from=build /src/server /app/server
COPY --from=build /src/dist /app/dist
USER 10001:10001
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/server/healthcheck.js"]
# Node permission model: the server may read /app and nothing else — no writes, no child
# processes, no workers, no native addons (the distroless entrypoint is /nodejs/bin/node).
CMD ["--permission", "--allow-fs-read=/app/", "/app/server/main.js"]
