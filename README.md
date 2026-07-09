# Make It Rain 💸

[![CI](https://github.com/gceico/claude-make-it-rain/actions/workflows/ci.yml/badge.svg)](https://github.com/gceico/claude-make-it-rain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gceico/claude-make-it-rain)](https://www.npmjs.com/package/@gceico/claude-make-it-rain)

![Make It Rain in action](https://raw.githubusercontent.com/gceico/claude-make-it-rain/main/img/make-it-rain.gif)

A menu bar app that tracks your Claude Code spend today. **Every $1 spent flies
a 💵 off the menu bar — and every $100 makes it rain.** 💸

The dollar figure is a rough estimate from per-token pricing.

## Requirements

- Node.js 18+ (you have this if you run Claude Code)
- macOS, Windows, or Linux
- Claude Code writing session logs to `~/.claude/projects` (the default)

## Install

### From npm

```bash
npm install -g @gceico/claude-make-it-rain
```

This installs the `claude-make-it-rain` command.

### From a git checkout

```bash
git clone https://github.com/gceico/claude-make-it-rain
cd claude-make-it-rain
npm install
```

### Local development install (link the global CLI to your checkout)

```bash
git clone https://github.com/gceico/claude-make-it-rain
cd claude-make-it-rain
npm install
npm link                     # makes the global `claude-make-it-rain` command point at this checkout
claude-make-it-rain          # runs your local copy
# ...
npm unlink -g @gceico/claude-make-it-rain   # undo when you're done
```

## Run

Installed globally:

```bash
claude-make-it-rain
```

That's it — the app detaches from the terminal and lives in your tray/menu
bar. You can close the terminal afterwards.

From a checkout:

```bash
npm start                        # foreground (logs in the terminal, Ctrl-C to quit)
node bin/make-it-rain.js         # detached, like the installed CLI
node bin/make-it-rain.js --foreground   # same launcher, but stays attached
```

On launch it scans today's session logs and prints a line like:

```
MakeItRain: today so far $13.92 (78 entries)
```

(Only visible when running in the foreground — the detached mode is silent.)

## Quit

Click the tray item and choose **Quit** (or Ctrl-C if running in the
foreground). Only one instance runs at a time — launching a second one exits
immediately.

## What you'll see

- A tray item like `💸 $12.34`, switching to `🤑` once today's spend hits
  $100. The dollar amount next to the icon is macOS-only; on Windows/Linux
  the amount lives in the tooltip and the context menu (a green square is
  shown as the icon).
- Click the tray item for a menu with today's total, today's input/output
  token counts, a **Make It Rain (test)** item to preview the rain animation,
  the daily-leaderboard controls (see privacy section below), and **Quit**.
- A 💵 flies off the tray item every time the running total crosses a whole
  dollar; crossing every $100 multiple plays a ~6-second full-screen shower
  of 💵💸💰🤑. The overlay is click-through and only exists while animating.

## How it works

- Polls `~/.claude/projects/*/*.jsonl` every 3 seconds, incrementally reading
  only newly appended bytes. The total resets automatically at local midnight.
- Every `assistant` message with a `usage` block recorded *today* (local
  time) is priced per-million-token rates keyed off the model id, with
  cache-read tokens at 10% of the input rate and cache-write tokens at
  1.25x/2x the input rate for 5-minute/1-hour ephemeral cache creation.
- Entries are deduplicated by `requestId:messageId` since the same entry can
  appear more than once across files.

## Daily leaderboard & privacy (GDPR)

Make It Rain has an optional **cloud leaderboard of the day**: a friendly ranking
of who made it rain hardest today, by anonymized tag.

### What is sent

Exactly two things, once an hour:

- your **anonymized gamer tag** (e.g. `TurboLlama7392`), generated randomly on
  first run and stored locally;
- **today's estimated total** in USD.

That's it. **No** account, email, IP-derived identity, file paths, project
names, model names, prompts, or any other data leaves your machine. The server
does not log IPs or per-user metadata, stores only `tag → max daily total`, and
resets every day (UTC) — old days are pruned automatically.

### It's opt-out, clearly disclosed, and easy to disable

Telemetry is **on by default** but fully under your control from the tray menu:

- **Share on daily leaderboard** — a checkbox to turn reporting on/off instantly.
- **New random tag** — reroll your anonymous tag any time.
- **View leaderboard…** — opens the landing page in your browser.
- **Leaderboard tag: …** — shows the exact tag being used.

Your choice is saved in a local config file (`config.json` under Electron's
`userData` directory — e.g. `~/Library/Application Support/make-it-rain/` on
macOS, `~/.config/make-it-rain/` on Linux, `%APPDATA%\make-it-rain\` on Windows).
You can also edit it by hand: set `"telemetryEnabled": false`, change
`"gamerTag"`, or repoint `"apiBaseUrl"`.

Because no personal data is collected and the tag is anonymous, random, and
user-changeable, there is nothing to identify you by — consistent with GDPR data
minimization. Disabling telemetry stops all network activity. If the server is
unreachable (the default URL is a placeholder), the client fails silently: no
errors, no crashes, no retry storms.

### Running the backend yourself

The server is a tiny, zero-dependency Node HTTP app under `server/` (not deployed
by this repo). Point the client at it via `apiBaseUrl` in `config.json`.

```bash
node server/index.js          # listens on http://localhost:8787
```

- `POST /api/report` — body `{ "tag": "...", "total": 12.34 }`
- `GET  /api/leaderboard` — today's top tags as JSON
- `GET  /` — the landing page (`server/public/index.html`)

State lives in a small JSON file (`server/data/leaderboard.json`, git-ignored).

## Testing & debug hooks

```bash
npm test                                  # unit tests (pure Node, no Electron window)
MIR_TEST_RAIN=1 npm start                 # trigger the $100 rain 1.5s after launch
MIR_TEST_SHOT=/tmp/overlay.png npm start  # save a PNG of the overlay 4s after launch
```

## Project layout

- `bin/make-it-rain.js` — CLI launcher; spawns Electron detached.
- `main.js` — tray item, overlay window management, monitor wiring, IPC,
  single-instance lock.
- `lib/usage-monitor.js` — incremental JSONL tailing, parsing, dedup, daily
  reset (pure Node, no Electron — unit-testable).
- `lib/pricing.js` — per-model USD/1M-token pricing table and per-entry cost
  calculation (pure Node).
- `lib/leaderboard-client.js` — anonymized-tag generation, config persistence,
  telemetry toggle, and hourly fail-silent reporting to the cloud leaderboard
  (pure Node, no Electron — unit-testable).
- `server/` — tiny zero-dependency Node HTTP backend (`index.js` + `db.js`) and
  the leaderboard landing page (`public/index.html`). Self-contained, not
  deployed by this repo.
- `overlay.html` + `preload.js` — transparent, click-through, always-on-top
  fullscreen overlay that renders the dollar-fly and money-rain animations,
  hiding itself when idle.
- `test/usage-monitor.test.js` — pricing math, dedup, day filtering,
  incremental/partial-line reads, crossing math.
- `test/leaderboard-client.test.js` — tag generation/sanitization, config
  first-run/stability/recovery, telemetry toggle, and fail-silent reporting.
- `.github/workflows/` — CI (tests on Linux/macOS/Windows × Node 18/20/22)
  and the npm publish pipeline.

## Releasing (maintainers)

Publishing is automated by `.github/workflows/publish.yml`, which runs the
tests and `npm publish` whenever a **GitHub Release** is published.

One-time setup:

1. Create an npm **automation** access token
   (npm → *Access Tokens* → *Generate* → *Automation*).
2. Add it to the repo as a secret named `NPM_TOKEN`
   (`gh secret set NPM_TOKEN`).

To cut a release:

```bash
npm version patch          # bumps package.json + creates a git tag (e.g. v1.0.1)
git push --follow-tags
gh release create v1.0.1 --generate-notes   # this triggers the publish workflow
```

The first publish of the scoped package goes out as public (configured via
`publishConfig.access` in `package.json`, and `--access public` in the
workflow). Provenance is enabled, so the package links back to the exact
commit and workflow run that built it.

## Caveats

- The cost shown is a satirical estimate based on the pricing table baked
  into `lib/pricing.js`; it is not pulled from any live pricing API and may
  not match actual billing.
- If `~/.claude/projects` doesn't exist or has no session logs for today, the
  app simply shows `$0.00` and keeps polling.
- No state is persisted across restarts — it rescans today's logs on launch.
- Animations render on the primary display only.

## Who's behind this

I'm Gabriel. I build things like this for fun and for my own work, and ship the
ones that turn out good.

Check [One's Skills](https://github.com/gceico/ones-skills) for my own Claude Skills collection.

I also run AI Workshops and help people turn their expertise into compounded value.
Come say hi at [Aibl.to](https://aibl.to/)

— Gabriel C.
