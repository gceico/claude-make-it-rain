# Contributing

Thanks for your interest in improving Make It Rain! This is a small project, so
the process is light.

## Getting started

Development uses [Bun](https://bun.sh) (≥ 1.3 — the exact version is pinned in
`package.json` as `packageManager`) as the package manager, test runner, and
bundler. The sources are TypeScript. Electron embeds its own Node, so the build
step compiles TS to JavaScript that Electron loads; the _published_ CLI runs
under the user's Node (≥ 22).

```bash
git clone https://github.com/gceico/claude-make-it-rain
cd claude-make-it-rain
bun install
```

Run the app locally (builds first, then launches Electron):

```bash
bun start
```

## Development workflow

- **Branch** off `main` (e.g. `feat/…`, `fix/…`).
- **Build** — compile the TypeScript sources to `dist/` + `bin/`:
  ```bash
  bun run build
  ```
- **Test** — the suite runs on `bun test` (no external framework):
  ```bash
  bun run test
  ```
- **Type-check and lint** before opening a PR:
  ```bash
  bunx tsc --noEmit
  bun run lint
  ```
- **Format** (Prettier is configured):
  ```bash
  bun run format        # rewrite files
  bun run format:check  # verify only
  ```

CI runs the build and test suite on Linux, macOS, and Windows, plus the
type-check, linter, format check, and the Astro site build. Please make sure
they're all green.

## Project layout

| Path               | What it is                                                     |
| ------------------ | -------------------------------------------------------------- |
| `src/main.ts`      | Electron main process — tray, overlay windows, IPC             |
| `src/preload.ts`   | Context-isolated bridge to the overlay renderer                |
| `overlay.html`     | The full-screen money overlay renderer                         |
| `src/lib/`         | Pure logic: pricing, usage monitoring, leaderboard I/O         |
| `src/bin/`         | CLI entry point                                                |
| `scripts/build.ts` | `Bun.build` bundler (TS → `dist/` + `bin/make-it-rain.js`)     |
| `test/`            | `bun test` files (one per module)                              |
| `server/`          | The public daily-leaderboard server (Bun, deployed to Railway) |
| `web/`             | Astro landing page + live leaderboard, served by the server    |

## Guidelines

- Keep modules in `src/lib/` free of Electron imports so they stay
  unit-testable.
- Keep the `server/` backend dependency-free (`bun:sqlite` + `Bun.serve` only).
- Add or update a test when you change behavior.
- Don't commit secrets, tokens, or personal data. Report security issues
  privately (see [SECURITY.md](SECURITY.md)).

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
