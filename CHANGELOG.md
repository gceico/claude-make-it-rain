# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Ported the toolchain to Bun + TypeScript with an Astro website (targets
  2.0.0).** This is a breaking change for _contributors_ — end-user runtime
  behavior is unchanged (the published CLI still runs under Node ≥ 22).
  - Bun is now the package manager (`bun.lock`; `package-lock.json` removed),
    test runner (`bun test` / `bun:test`), and bundler. Development requires
    Bun ≥ 1.3.
  - Sources moved to TypeScript under `src/`; `bun run build`
    (`scripts/build.ts` via `Bun.build`) compiles them to CommonJS in `dist/` +
    `bin/make-it-rain.js`, keeping `electron` external. Electron still runs its
    embedded Node.
  - The leaderboard server is now a zero-dependency Bun server (`Bun.serve` +
    `bun:sqlite`, replacing `node:http` + `node:sqlite`). The on-disk SQLite
    format is unchanged, so existing data keeps working.
  - The landing page is now an Astro 5 static site under `web/`, built to a
    single fully-inlined HTML file (CSP-compatible) and served by the backend
    from `STATIC_DIR`. The Docker image is a multi-stage build from the repo
    root that bakes `web/dist` into the server image.
  - CI runs on `oven-sh/setup-bun` across Linux, macOS, and Windows (build,
    tests, `tsc --noEmit`, lint, format check, and the Astro build).

## [1.0.4] - 2026-07-09

### Changed

- Documentation improvements (README).

## [1.0.3] - 2026-07-09

### Added

- Leaderboard reset countdown and pretty date on the landing page.

### Changed

- Raised the minimum Node.js version to 22 for both the desktop app and the
  leaderboard server, dropping end-of-life Node 18 and 20.

### Fixed

- Stopped a stray macOS microphone permission prompt.
- Repaired the update-checker fetch test and removed dead assignments.

## [1.0.2] - 2026-07-09

### Added

- Public daily leaderboard server (deployed to Railway) with a strict
  Content-Security-Policy and a same-origin SVG favicon.
- Repository health tooling: contribution guide, security policy, issue and pull
  request templates, Dependabot, ESLint, Prettier, and an EditorConfig.

### Fixed

- Leaderboard tests now close the SQLite handle before deleting their temp
  files, fixing an `EBUSY` failure on Windows.

### Security

- Hardened the leaderboard against config/tag/total injection.
- npm publishing switched to OIDC trusted publishing with SHA-pinned GitHub
  Actions and provenance (no long-lived npm token).

## [1.0.1]

- Maintenance release.

## [1.0.0]

- Initial public release: menu bar app that estimates today's Claude Code spend
  and makes it rain.

[Unreleased]: https://github.com/gceico/claude-make-it-rain/compare/v1.0.4...HEAD
[1.0.4]: https://github.com/gceico/claude-make-it-rain/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/gceico/claude-make-it-rain/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/gceico/claude-make-it-rain/releases/tag/v1.0.2
[1.0.1]: https://github.com/gceico/claude-make-it-rain/releases/tag/v1.0.1
[1.0.0]: https://github.com/gceico/claude-make-it-rain/releases/tag/v1.0.0
