# Make It Rain 💸

[![CI](https://github.com/gceico/claude-make-it-rain/actions/workflows/ci.yml/badge.svg)](https://github.com/gceico/claude-make-it-rain/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@gceico/make-it-rain)](https://www.npmjs.com/package/@gceico/make-it-rain)

![Make It Rain in action](https://raw.githubusercontent.com/gceico/claude-make-it-rain/main/img/make-it-rain.gif)

A menu bar app that tracks your Claude Code spend today. **Every $1 spent flies
a 💵 off the menu bar — and every $100 makes it rain.** 💸

Just a joke app: the dollar figure is a rough estimate from per-token pricing,
not an official number from Anthropic.

## Requirements

- Node.js 18+ (you have this if you run Claude Code)
- macOS, Windows, or Linux
- Claude Code writing session logs to `~/.claude/projects` (the default)

## Install

### From npm

```bash
npm install -g @gceico/make-it-rain
```

The installed CLI is called `make-it-rain` (the npm scope only affects the
package name, not the command).

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
npm link            # makes the global `make-it-rain` command point at this checkout
make-it-rain        # runs your local copy
# ...
npm unlink -g @gceico/make-it-rain   # undo when you're done
```

## Run

Installed globally:

```bash
make-it-rain
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
  and **Quit**.
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
- `overlay.html` + `preload.js` — transparent, click-through, always-on-top
  fullscreen overlay that renders the dollar-fly and money-rain animations,
  hiding itself when idle.
- `test/usage-monitor.test.js` — pricing math, dedup, day filtering,
  incremental/partial-line reads, crossing math.
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

Day job: I run [**Aibl.to**](https://aibl.to) with Nizar. We do hands-on
workshops where teams take the work they already know and turn it into AI
agents that compound.

If that sounds like your team, [come say hi](https://aibl.to).

— Gabriel
