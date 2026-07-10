#!/bin/sh
# Docker entrypoint for the Make It Rain leaderboard server.
#
# Why this exists: Railway (and most managed hosts) mount the persistent volume
# at /data owned by root, which SHADOWS the image's build-time `chown bun:bun
# /data`. The non-root `bun` server process then cannot write the SQLite file,
# so the very first INSERT in POST /api/report fails with SQLITE_READONLY
# ("attempt to write a readonly database") and the endpoint returns 500.
#
# Fix: start as root, take ownership of the volume (the DB dir + any existing
# db/-wal/-shm files), then drop privileges to `bun` to run the server. The
# server itself still runs unprivileged — see docs/DECISIONS.md §1.4.
set -e

DB_PATH="${LEADERBOARD_DB:-/data/leaderboard.db}"
DATA_DIR="$(dirname "$DB_PATH")"

# Best-effort: never let an ownership hiccup crash boot. If chown fails (e.g.
# already correct, or an unusual read-only mount), the server surfaces the real
# error on first write.
if [ -d "$DATA_DIR" ]; then
  chown -R bun:bun "$DATA_DIR" 2>/dev/null || true
fi

# Drop to the unprivileged user and exec the server (CMD is passed as "$@").
exec su-exec bun "$@"
