# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.17] - 2026-10-11

### Added

- **New Optimize habit: bloated CLAUDE.md / AGENTS.md.** Flags when the
  instructions an agent loads into every request exceed ~200 lines, since every
  line is re-sent (and billed) on each turn. For Claude Code it resolves the
  effective chain — global `~/.claude/CLAUDE.md`, project `CLAUDE.md` /
  `.claude/CLAUDE.md` / `CLAUDE.local.md` up the tree, falling back to
  `AGENTS.md` when a project has no CLAUDE.md (as Claude Code does), plus
  recursive `@` imports. For Codex it reads the exact AGENTS.md block Codex
  logged for the session.

### Changed

- Falling money now burns up at the end of its fall (a bottom-up dissolve with
  an ember glow) instead of fading out.

## [1.0.16] - 2026-10-11

### Changed

- **Model prices refreshed for both providers** (verified 2026-10-11 against
  Anthropic's and OpenAI's published pricing, and LiteLLM's table).
  - Claude: added Opus 5.5 ($4/$20), Sonnet 5.5 ($2/$10), Haiku 5.5 and Fable /
    Mythos 5.1. Sonnet 5 now bills at $2/$10, its permanent price (it was still
    on the old $3/$15). Before this, Opus 5.5 fell through to the $5/$25
    default.
  - Codex: added gpt-6-sol / gpt-6.1-sol / gpt-6-astra / gpt-6-luna and the
    `codex-auto-review` reviewer (billed at gpt-5.6-luna rates, an estimate).
    Corrected gpt-5.6 Sol/Terra/Luna and gpt-5.4, which had drifted. Added the
    -pro, o-series and gpt-4.1 ids. Unknown ids now fall back to gpt-6-sol
    rates.
- Cache reads are now priced per model rather than always at 10% of input:
  0.05x on Opus 5.5, Sonnet 5.5 and gpt-6.1-sol; 0.025x on Fable / Mythos 5.1;
  0.25x on the o-series and gpt-4.1.
- Tiered pricing: Haiku 5.5 prompts over 100K tokens and OpenAI gpt-5.4+
  prompts over 272K tokens bill at the higher rates. For Codex this is judged
  per request, not on the day's running total.
- Fast-mode requests (`usage.speed: "fast"` on Opus 5.5 / 5 / 4.8) bill at 2x.
- Codex prompt-cache writes (`cache_write_input_tokens`, gpt-5.6 / gpt-6) bill
  at 1.25x input instead of as plain input.

### Fixed

- History tests no longer scan the developer's real `~/.codex` and Cowork
  directories (they were slow and could time out).

## [1.0.5 – 1.0.15]

### Added

- **OpenAI Codex spend is now tracked alongside Claude Code.** The app reads
  `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` in addition to the Claude Code
  logs and folds both into a single running total, so the tray figure, the
  dollar-fly and money-rain animations, the habit coach, and the (optional)
  collective-spend report all cover both agents. Codex logs differ from Claude
  Code's — the model lives on a separate `turn_context` line and token counts
  are reported cumulatively per session — so they get their own monitor that
  diffs successive readings; midnight-spanning sessions attribute only today's
  growth. Nothing to configure: with no Codex installed, the source simply
  contributes nothing.
- Per-tool spend breakdown ("Claude Code $X · Codex $Y") under **See your
  numbers**, since the combined total otherwise hides which agent spent what.

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
- **Adopted TypeScript 7 (the native compiler) and replaced ESLint with
  oxlint.** The root `typescript` devDependency is now `^7.0.2`; `bunx tsc
--noEmit` runs on the native compiler. ESLint had to go because
  `typescript-eslint` caps its peer range below TypeScript 6 and hard-crashes
  under TS 7. The `eslint`, `@eslint/js`, `globals`, and `typescript-eslint`
  devDependencies and `eslint.config.js` are removed; `bun run lint` now runs
  `oxlint` (config in `.oxlintrc.json`). Prettier is unchanged. Note: oxlint is
  a non-type-aware linter, so the type-aware lint rules that `typescript-eslint`
  provided are no longer enforced — `bunx tsc --noEmit` (strict mode) remains
  the type-correctness gate. `web/` stays on TypeScript `^5.9.3` for now because
  `@astrojs/check` (the Astro type checker) crashes under TS 7.

### Fixed

- Codex session "context size" was read off the cumulative session totals, so it
  grew without bound over a long session (a 50-turn session reported millions of
  tokens). It now comes from the per-request `last_token_usage`, the true prompt
  size. This also stops the inflated figure from being written into the stored
  analytics for past days, where it permanently pinned the context term of the
  Optimization Score and made the "long session" habit fire every day.
- The Codex monitor rebuilt the tray menu on every 3-second poll even when
  nothing had changed, which on macOS dismisses the menu while you are reading
  it. It now updates only when the numbers actually move.
- A Codex session resumed days after it started (`codex resume` keeps appending
  to the original rollout file, which lives under its original date directory)
  silently stopped being counted after one day.
- `gpt-5.1-codex-mini` was priced at the full Codex rate rather than the mini
  rate, overcharging Codex-mini usage roughly fivefold.
- Codex's synthetic first-turn messages (the environment blurb, `AGENTS.md`
  instructions) were counted as prompts you typed, inflating the per-session
  turn count the habit detectors read.

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
