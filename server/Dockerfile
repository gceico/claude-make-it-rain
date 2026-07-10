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
COPY server/package.json ./
COPY server/index.ts server/db.ts ./
COPY --from=web-build /build/web/dist /app/public
# Pre-create the volume mount point owned by the runtime user: a fresh volume
# mounted at /data inherits this ownership, so the non-root server can create
# LEADERBOARD_DB=/data/leaderboard.db on first boot (an existing volume with
# data keeps whatever ownership it already has).
RUN mkdir -p /data && chown bun:bun /data
USER bun
CMD ["bun", "index.ts"]
