# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Public daily leaderboard server (deployed to Railway) with a strict
  Content-Security-Policy and a same-origin SVG favicon.
- Repository health tooling: contribution guide, security policy, issue and pull
  request templates, Dependabot, ESLint, Prettier, and an EditorConfig.

### Changed

- Clarified Node.js support: the desktop app requires Node 18+, while the
  leaderboard server requires Node 22+ (it uses the `node:sqlite` builtin). CI
  runs the full suite on 22/24 and the app-only suite on 18/20.

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

[Unreleased]: https://github.com/gceico/claude-make-it-rain/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/gceico/claude-make-it-rain/releases/tag/v1.0.1
[1.0.0]: https://github.com/gceico/claude-make-it-rain/releases/tag/v1.0.0
