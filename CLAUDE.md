# CLAUDE.md

## Overview

Make It Rain is an Electron menu-bar/tray app that watches Claude Code usage
logs (`~/.claude/projects/*/*.jsonl`) and shows the day's estimated spend, flying
a 💵 off the tray every whole dollar and raining money at $100 milestones. It can
optionally report an anonymized daily total (a random gamer tag + USD figure) to
a cloud leaderboard. The npm package is `@gceico/claude-make-it-rain` and it
installs a single CLI command, `claude-make-it-rain` (`bin/make-it-rain.js`,
which spawns Electron detached).

## Commands

| Task | Command |
| --- | --- |
| Run (foreground, logs) | `npm start` (alias `npm run dev`) |
| Run detached (like installed CLI) | `node bin/make-it-rain.js` |
| Test everything | `npm test` (runs `test:app` then `test:server`) |
| Test app only | `npm run test:app` (pure Node, Node 18+) |
| Test server only | `npm run test:server` (needs `node:sqlite`, Node 22+) |
| Lint | `npm run lint` (`eslint .`) |
| Format | `npm run format` / check with `npm run format:check` |

There is no bundler/build step. Lint and format tooling (eslint, prettier) are
real devDependencies and installed; `npm run lint` works.

## Architecture

- `main.js` — Electron main process: tray item, overlay window management, IPC,
  single-instance lock, and wiring of the monitor/leaderboard/update-checker.
- `bin/make-it-rain.js` — CLI launcher; spawns Electron (detached by default,
  `--foreground` to stay attached).
- `overlay.html` + `preload.js` — transparent, click-through, always-on-top
  fullscreen overlay that renders the dollar-fly and money-rain animations.
- `lib/` (pure Node, unit-testable, no Electron): `usage-monitor.js` (incremental
  JSONL tailing, dedup, daily reset), `entry-parser.js`, `pricing.js` (per-model
  USD/1M-token table), `milestones.js` ($10/$50 stack milestones), `history.js`,
  `leaderboard-client.js` (tag generation, config persistence, hourly fail-silent
  reporting), `update-checker.js`, `config.js`, `denominations.js`.
- `server/` — zero-dependency Node HTTP leaderboard backend: `index.js`
  (endpoints `POST /api/report`, `GET /api/leaderboard`, `GET /api/stars`,
  `GET /health`, static `/`), `db.js` (`node:sqlite` store), `public/` (landing
  page), plus `Dockerfile` and `railway.json`.
- `test/` — `node:test` suites (see below).

## Conventions & invariants

- CommonJS + `'use strict'` throughout. No TypeScript, no ESM, no bundler.
- Files carry header doc comments explaining intent.
- Prettier config: `singleQuote`, `printWidth: 80`, `trailingComma: "es5"`
  (enforced in CI via the `lint` job running `eslint`; `format:check` available
  locally).
- Dependency story: the app's only runtime dependency is `electron` (^43). The
  `server/` backend has ZERO npm dependencies — it uses the built-in `node:sqlite`
  and `node:http`. Keep it that way.

## Testing

- Tests are plain `node:test` files, run directly (e.g.
  `node test/usage-monitor.test.js`) — no jest/mocha/harness.
- `test:app` runs the Electron-free suites; `test:server` runs the two
  leaderboard suites that require `node:sqlite`.
- Debug/animation hooks are env vars honored by `main.js` when run via
  `npm start` (NOT used by the automated tests): `MIR_TEST_RAIN=1` (rain after
  1.5s), `MIR_TEST_STACK=<n>` (burst n stacks after 3s), `MIR_TEST_SHOT=/path.png`
  (screenshot the overlay), `MIR_TEST_USER_DATA=/path` (isolated userData dir).

## Gotchas

- `node:sqlite` landed in Node 22, so the server and `test:server` need Node ≥ 22,
  even though the desktop app supports Node 18+.
- CI sets `ELECTRON_SKIP_BINARY_DOWNLOAD=1` for `npm ci` (tests never open a
  window, so the ~100 MB Electron binary is skipped).
- Railway deploys the reference server from `server/` (`railway up ./server`),
  built from `server/Dockerfile` (`node:24-alpine`); a persistent volume mounts at
  `/data` with `LEADERBOARD_DB=/data/leaderboard.db`.
- Telemetry (leaderboard reporting) is ON by default, opt-out from the tray menu;
  disabling it stops all network activity. The client fails silently if the server
  is unreachable.

See `docs/DECISIONS.md` (if present) for deployment/security/anti-cheat rationale.
