# Contributing

Thanks for your interest in improving Make It Rain! This is a small project, so
the process is light.

## Getting started

The published app supports Node 18+, but development targets the current LTS
(pinned in `.nvmrc`, matching the server's deploy image):

```bash
git clone https://github.com/gceico/claude-make-it-rain
cd claude-make-it-rain
nvm use        # optional — picks up the Node version in .nvmrc
npm install
```

Run the app locally:

```bash
npm start
```

## Development workflow

- **Branch** off `main` (e.g. `feat/…`, `fix/…`).
- **Test** — the suite is plain Node, no framework:
  ```bash
  npm test
  ```
- **Lint** before opening a PR:
  ```bash
  npm run lint
  ```
- **Format** (optional; Prettier is configured):
  ```bash
  npm run format        # rewrite files
  npm run format:check  # verify only
  ```

CI runs the test suite on Linux, macOS, and Windows across supported Node
versions, plus the linter. Please make sure both are green.

## Project layout

| Path             | What it is                                             |
| ---------------- | ------------------------------------------------------ |
| `main.js`        | Electron main process — tray, overlay windows, IPC     |
| `preload.js`     | Context-isolated bridge to the overlay renderer        |
| `overlay.html`   | The full-screen money overlay renderer                 |
| `lib/`           | Pure logic: pricing, usage monitoring, leaderboard I/O |
| `bin/`           | CLI entry point                                        |
| `test/`          | Node test files (one per module)                       |
| `server/`        | The public daily-leaderboard server (deployed to Railway) |

## Guidelines

- Keep modules in `lib/` free of Electron imports so they stay unit-testable.
- Add or update a test when you change behavior.
- Don't commit secrets, tokens, or personal data. Report security issues
  privately (see [SECURITY.md](SECURITY.md)).

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
