# Multi-stage build for the Bun leaderboard server + Astro landing site.
#
# IMPORTANT: build with the REPO ROOT as the context so both web/ and server/
# are available, e.g.:  docker build -f server/Dockerfile .
# (Railway uses this via root railway.json -> dockerfilePath "server/Dockerfile".)

# ── Stage 1: build the Astro landing site (web/ -> web/dist) ─────────────────
# The web agent guarantees `bun run build` emits static files to web/dist.
FROM oven/bun:1-alpine AS web-build
WORKDIR /build
COPY web ./web
RUN cd web && bun install --frozen-lockfile && bun run build

# ── Stage 2: the zero-dependency Bun leaderboard server ──────────────────────
# The server has NO npm dependencies (bun:sqlite + bun builtins only), so there
# is no install step — we copy the TypeScript sources and the built site, which
# is served from STATIC_DIR. bun runs the .ts entrypoint directly.
FROM oven/bun:1-alpine AS runtime
ENV NODE_ENV=production
ENV STATIC_DIR=/app/public
WORKDIR /app
# su-exec lets the root entrypoint drop to the `bun` user after fixing volume
# ownership (Alpine main repo, ~10 KB, no npm dependency added).
RUN apk add --no-cache su-exec
COPY server/package.json ./
COPY server/index.ts server/db.ts ./
COPY server/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --from=web-build /build/web/dist /app/public
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
# NOTE: the container starts as root ONLY to run the entrypoint, which chowns
# the mounted /data volume (Railway mounts it root-owned, shadowing any
# build-time chown) and then execs the server as the non-root `bun` user via
# su-exec. The server process itself never runs as root — see docs/DECISIONS.md.
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["bun", "index.ts"]
