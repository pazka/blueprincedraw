# syntax=docker/dockerfile:1
# blueprincedraw: static Excalidraw front-end served by a ~200-line Node stdlib server.
# Box contract rules 1–4, 12: distroless, uid 10001, read-only, no state, base images pinned by digest.

FROM node:26.13.0-trixie-slim@sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072 AS build
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

FROM gcr.io/distroless/nodejs26-debian13:nonroot@sha256:9b945e92c1b5463a4b75f11e8417515e4bea7355f6adfd79ec220fbbe905dda8
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
# Node permission model: the server may read /app and nothing else (no writes, no child
# processes, no workers, no native addons). The distroless entrypoint is /nodejs/bin/node.
CMD ["--permission", "--allow-fs-read=/app/", "/app/server/main.js"]
