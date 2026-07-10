# Architecture & Decision Log

This is an ADR-lite decision log for the cloud **daily leaderboard** and the
work around it: how the reference server is deployed, how the npm package is
published, the security/privacy posture of both client and server, and the
anti-cheat design. It is meant to orient a new contributor — each decision
points at the exact file, endpoint, or environment variable that implements it
so you can go straight to the code.

Scope note: the desktop app itself (tray, overlay, usage monitor, pricing) is
described in the top-level `README.md`. This document covers the leaderboard,
deployment, publishing, and hardening decisions.

Each entry follows the same shape: **Context → Decision → Rationale →
Tradeoffs / accepted risks** (plus **Status** where useful).

Code references below are relative to the repository root: the server lives in
`server/`, the client-side leaderboard code in `lib/leaderboard-client.js`, and
the publish pipeline in `.github/workflows/publish.yml`.

---

## 1. Deployment & Infrastructure

### 1.1 Ship server, infra, and client in ONE open-source repo

**Context.** The project is a telemetry app: the desktop client reports a number
to a server the maintainer runs. A user reasonably wants to know exactly what is
collected and how.

**Decision.** Keep the desktop client, the leaderboard server (`server/`), the
landing page (`server/public/index.html`), and the deploy config
(`server/Dockerfile`, `railway.json`, `server/railway.json`) all in the same
public repository.

**Rationale.** For a telemetry app, transparency is the honest default — anyone
can read exactly what leaves their machine (`lib/leaderboard-client.js`) and
exactly what the server accepts and stores (`server/index.js`, `server/db.js`).
The endpoint is assumed to be publicly discoverable anyway (it is printed in the
client source and served on a public page), which is _why_ the server has
rate limiting and input hardening rather than relying on obscurity.

**Tradeoffs / accepted risks.** Secrets must never live in the repo — deploy
credentials, volume config, and any Railway env vars are configured in the
Railway dashboard, not in-tree. A publicly known endpoint invites abuse, which
the hardening in §3 is designed to absorb.

**Status.** Shipped.

### 1.2 Host the reference server on Railway

**Context.** The server is a tiny, always-available HTTP service that needs
persistent disk and a public URL, at near-zero cost.

**Decision.** Deploy the reference server to [Railway](https://railway.com). The
in-repo config is `server/railway.json` (Docker build) and the root `railway.json`
(see §1.5). Health is checked at `GET /health` (`healthcheckPath`,
`healthcheckTimeout: 60`), and `restartPolicyType` is `ON_FAILURE`.

**Rationale.** Railway gives a container + persistent volume + TLS + a public
hostname with minimal setup, and supports scale-to-zero (`sleepApplication`, see
§1.4) to keep an idle hobby service cheap.

**Tradeoffs / accepted risks.**

- The Railway service is (per project operational setup, configured in Railway
  and _not_ in the repo) GitHub-connected to `main` with auto-deploy on push.
  Implication: merging to `main` ships to production immediately — there is no
  manual gate, so `main` must stay deployable.
- Region, plan, and project/service names are Railway-side settings and are
  **not** recorded in any repo config file, so they are not documented here to
  avoid inventing specifics.

**Status.** Shipped.

### 1.3 Storage: built-in `node:sqlite` on a persistent volume

**Context.** The board needs durable state but the project prizes a
zero-npm-dependency server.

**Decision.** Store state in SQLite via Node's **built-in** `node:sqlite`
(`DatabaseSync`), implemented in `server/db.js` — no npm packages. The DB file
path is `LEADERBOARD_DB` (default `server/data/leaderboard.db`; the reference
deploy sets it to a file on the mounted volume, `/data/leaderboard.db` per the
README). Schema is one row per `(day, tag)` with a `REAL` total; a report keeps
the **MAX** total ever seen for that `(day, tag)` (spend is cumulative, so max is
robust to a client momentarily reporting a lower figure). `journal_mode = WAL`;
all access is via prepared statements (no string interpolation into SQL).

The board is **per UTC calendar day** (`LeaderboardDB.today()` slices the ISO
date) and **auto-prunes** to today + yesterday on every write
(`_pruneOldDays`), so the DB cannot grow without bound and old days disappear.

**Rationale.** Built-in SQLite keeps the server dependency-free (nothing to
`npm install`, nothing to audit, faster/cheaper container) while still giving
durable, queryable state. Daily reset + prune keeps it a fun _of-the-day_ board
and bounds storage.

**Tradeoffs / accepted risks.** `node:sqlite` is only available on **Node ≥ 22**
(it did not exist in Node 18/20). The server therefore requires Node ≥ 22, and
the desktop app now shares that baseline (Node 18 and 20 are both end-of-life).
Yesterday's data is discarded — this is intentional, not an archive.

**Status.** Shipped.

### 1.4 Container: minimal non-root Dockerfile, scale-to-zero

**Context.** A zero-dependency server needs no build step and no `npm install`,
so the image can be tiny.

**Decision.** `server/Dockerfile` is a multi-stage build `FROM
oven/bun:1-alpine`, sets `NODE_ENV=production`, copies only
`package.json index.ts db.ts` and the built `web/dist` (→ `/app/public`), and
starts with `bun index.ts` — no `npm install` for the server. The server process
runs as the non-root `bun` user. A small `docker-entrypoint.sh` runs first as
root to `chown` the mounted `/data` volume, then drops to `bun` via `su-exec`
before exec'ing the server. `railway.json` sets `numReplicas: 1` and
`sleepApplication: true` (scale-to-zero when idle).

**Rationale.** No dependencies means no install layer; Alpine + a single process
keeps the image small and fast to boot (which matters for scale-to-zero cold
starts). Running the server as non-root is basic container hygiene. Sleeping when
idle keeps a hobby service near free.

The root-then-drop entrypoint fixes a real outage (issue #26): a build-time
`chown bun:bun /data` is **shadowed** when Railway mounts the persistent volume
at `/data` root-owned, so the non-root server could not write the SQLite file —
every `POST /api/report` crashed with `SQLITE_READONLY` ("attempt to write a
readonly database") and returned 500. Taking ownership at boot (as root) and
then dropping privileges keeps the server unprivileged while guaranteeing the
volume is writable regardless of how the host mounts it. `su-exec` is a ~10 KB
Alpine package (no npm dependency added, so the zero-npm-dependency invariant
holds).

**Tradeoffs / accepted risks.** Scale-to-zero adds cold-start latency to the
first request after idle; acceptable for a leaderboard that clients poll at most
hourly and that fails silently on the client if slow/unreachable.

**Status.** Shipped.

### 1.5 One `railway.json`, Dockerfile built from the repo root

**Context.** Historically there were **two** Railway config files (a `RAILPACK`
one at the repo root and a `DOCKERFILE` one in `server/`), and the deploy
command had to target `server/` (`railway up ./server`) for the intended
Dockerfile build to win. The Bun/TypeScript/Astro port made the Docker build
context the **repo root** (the image bakes the Astro site from `web/` into the
server image), which made the two-config split actively dangerous: deploying
from `server/` could no longer work at all, since `web/` would be outside the
build context.

**Decision.** There is now a **single** `railway.json` at the repo root:
`builder: DOCKERFILE` with `dockerfilePath: "server/Dockerfile"`, healthcheck
`/health`, `numReplicas: 1`, and `sleepApplication: true`. `server/railway.json`
was deleted. Deploys run from the **repo root** — the GitHub Actions workflow
(`.github/workflows/deploy-server.yml`) does exactly `railway up --service
claude-make-it-rain --ci` from the checkout root, and a manual deploy is the
same command from the repo root. A root `.dockerignore` keeps the uploaded
context small.

**Rationale.** One config, one context, one command — the previous footgun
(same code deploying two different ways depending on the directory you ran
`railway up` from) is gone, and the scale-to-zero Dockerfile build is always
the one that applies.

**Tradeoffs / accepted risks.** Anyone following the old `railway up ./server`
instruction will now fail fast (no `railway.json` and no reachable `web/` in
that context) rather than silently deploying the wrong build — an acceptable
trade for a single source of truth.

**Status.** Shipped (reworked in the Bun port, 2026-07-10).

### 1.6 Reference host behind `aiburn.dev`

**Context.** Early builds pointed at the default Railway hostname; the project
later moved to a custom domain.

**Decision.** The client default (`DEFAULT_API_BASE_URL` in
`lib/leaderboard-client.js`) is `https://aiburn.dev`. Older persisted defaults —
`https://make-it-rain.example.com` and the old Railway URL
`https://claude-make-it-rain-production.up.railway.app` — are listed in
`LEGACY_PLACEHOLDER_URLS` and treated as "unset" so those installs migrate to the
current default; genuine user-set custom URLs are preserved. (See §3.7 for the
scheme allow-list that also guards this value.)

**Rationale.** A stable, memorable custom domain decouples the public URL from
the hosting provider, and the migration list means existing installs silently
adopt it without a config edit.

**Status.** Shipped.

---

## 2. Release & Publishing

### 2.1 npm publish via Trusted Publishing (OIDC) — no stored token

**Context.** Publishing to npm from CI traditionally needs a long-lived
`NPM_TOKEN` secret, which is a standing credential that can leak.

**Decision.** `.github/workflows/publish.yml` authenticates to npm using **npm
Trusted Publishing (OIDC)**. There is **no** npm token and no `.npmrc` credential
anywhere in the workflow. The job declares `permissions: id-token: write` (plus
`contents: read` for checkout); GitHub mints a short-lived OIDC token that npm
verifies against the Trusted Publisher configured for the package on npmjs.com.
npm Trusted Publishing needs npm ≥ 11.5.1; the workflow runs on Node 24, whose
bundled npm is already new enough, so it is used as-is (an in-place
`npm install -g npm@latest` self-upgrade is deliberately avoided — it corrupts
npm's own dependency tree and breaks `--provenance`). The publish step
is `npm publish --access public --provenance` (`--access public` is required for
the scoped package `@gceico/claude-make-it-rain`; `--provenance` produces a signed
provenance attestation linking the artifact to the commit + workflow run).

**Rationale.** No stored secret to leak or rotate; the credential is short-lived
and scoped to the run; provenance gives supply-chain traceability. This replaced
the previous token-based publish flow.

**Tradeoffs / accepted risks.** Requires one-time out-of-band setup on npmjs.com
(a Trusted Publisher entry naming this repo + workflow filename); a rename of the
repo or workflow file breaks publishing until the Trusted Publisher is updated.

**Status.** Shipped.

### 2.2 Trigger on version-tag push, with a version guard

**Context.** Releases must publish the _right_ version, and only real releases
should publish.

**Decision.** The workflow triggers on `push:` of tags matching `v*`
(`on: push: tags: ['v*']`). The documented flow is
`npm version patch && git push --follow-tags`; publishing a GitHub Release also
works because creating a Release pushes the tag. A guard step compares
`package.json` `version` against the tag (`GITHUB_REF_NAME` with a leading `v`
stripped) and aborts the publish if they differ. The workflow sets up Node 24 (for
`npm publish` itself) and Bun, installs with `bun install --frozen-lockfile`
(`ELECTRON_SKIP_BINARY_DOWNLOAD=1` since the tests never open a window), runs
`bun run build`, and runs `bun run test` before publishing.

**Rationale.** Tag-push is an unambiguous release signal, and the version guard
prevents shipping a package whose `package.json` version disagrees with the tag.

**Tradeoffs / accepted risks.** The workflow that runs is the one present at the
tagged commit, so the pipeline and the version guard must already be correct in
the commit you tag.

> **Discrepancy flagged:** the `README.md` "Releasing (maintainers)" section is
> **stale** — it still describes the _old_ token-based flow (create an npm
> automation token, add it as an `NPM_TOKEN` secret) and says publishing fires
> "whenever a GitHub Release is published." The live workflow uses OIDC (no
> token) and triggers on tag push. This doc reflects the workflow; the README
> section should be updated separately.

**Status.** Shipped.

---

## 3. Security & Privacy

### 3.1 Privacy by design: minimal, anonymous, opt-out telemetry

**Context.** The client sends data to a server, which triggers privacy/GDPR
concerns.

**Decision.** The **only** data that leaves the machine is an anonymized,
user-changeable "gamer tag" (e.g. `TurboLlama7392`, generated locally) plus
today's estimated USD total. No account, no email, no IP-derived identity, no
file paths, no project or model names, no prompts. See the header comment in
`lib/leaderboard-client.js`. Telemetry is **on by default** but disclosed (README
"Daily leaderboard & privacy" section + tray menu) and switchable off with one
click, persisted to `config.json`. All network activity fails silently — one
attempt per tick, short timeout, no backoff/retry storm.

**Rationale.** Data minimization: if the only identifier is a random,
user-changeable handle, there is nothing to identify a person by. Opt-out with
clear disclosure keeps the fun default while respecting user control.

**Tradeoffs / accepted risks.** On-by-default telemetry is a deliberate choice
justified by full disclosure + one-click off + anonymity.

**Status.** Shipped.

### 3.2 Server does not log or persist IPs / request metadata

**Context.** The privacy promise in §3.1 has to hold on the server too.

**Decision.** The server deliberately does not log IPs or persist any per-request
/ per-user metadata; it stores only `tag → max daily total` per day. See the
header comment in `server/index.js` and the schema comment in `server/db.js`.
(The client IP is read transiently, in memory, only for rate limiting — see
§3.5 — never written to disk.)

**Rationale.** Keeps the server consistent with the client's data-minimization
promise; there is no user-identifying data at rest.

**Status.** Shipped.

### 3.3 Input hardening: tag sanitization, total validation, `MAX_TOTAL` cap

**Context.** `POST /api/report` accepts arbitrary JSON from anyone.

**Decision (`handleReport` in `server/index.js`).**

- **Tag:** `sanitizeTag` strips to `[A-Za-z0-9_-]` and truncates to
  `TAG_MAX_LENGTH` (32). Empty result → `400 invalid_tag`. (The client applies
  the same sanitization in `lib/leaderboard-client.js`.)
- **Total:** must be a finite `number`, `>= 0`, and `<= MAX_TOTAL`; otherwise
  `400 invalid_total`. Accepted totals are rounded to cents.
- **`MAX_TOTAL` cap:** `Number(process.env.MAX_REPORT_TOTAL) || 10000` — a
  $10,000/day default ceiling.

**Rationale.** Sanitizing the tag makes it safe to render and store. The cap
bounds absurd/troll values _and_ rejects near-`Number.MAX_VALUE` numbers that
pass `isFinite()` but would overflow to `Infinity` when multiplied (e.g.
`total * 100`).

**Tradeoffs / accepted risks.** The cap is a blunt bound, not a truth check — a
user can still report any value up to the cap (see §4.1).

**Status.** Shipped.

### 3.4 Body size cap → `413`

**Context.** An attacker could stream an enormous request body.

**Decision.** `readBody` enforces `MAX_BODY_BYTES` (a constant, `4 * 1024` =
4 KB — reports are tiny). Over-limit bodies reject with a tagged
`BODY_TOO_LARGE` error, which `handleReport` answers as `413 body_too_large`
(distinct from the `400 invalid_json` parse error). The socket is drained rather
than destroyed so the `413` response can be written back.

**Rationale.** Bounds memory per request and returns the semantically correct
status (the label was previously wrong).

**Status.** Shipped.

### 3.5 Best-effort per-IP rate limiter on `POST /api/report`

**Context.** A public endpoint can be flooded.

**Decision.** A fixed-window per-IP counter (`checkRateLimit` /`rateBuckets` in
`server/index.js`): default `RATE_LIMIT_MAX` = 60 requests per
`RATE_LIMIT_WINDOW_MS` = 60,000 ms (60/min/IP), both env-overridable. Exceeding
it returns `429 rate_limited` with a `Retry-After` header. The client IP is the
**leftmost** entry of `x-forwarded-for` (Railway sits behind a proxy, so
`req.socket.remoteAddress` is the proxy), falling back to the socket address. A
low-frequency background sweeper drops expired buckets so the map stays
memory-bounded; the sweeper is `.unref()`'d so it never keeps the process alive
(tests/CLI exit cleanly).

**Rationale.** Legit clients report at most hourly, so 60/min/IP never
inconveniences a real user while stopping a trivial single-source flood.

**Tradeoffs / accepted risks.** `x-forwarded-for` is client-influenceable, so
this is explicitly **best-effort** — it stops a naive single-origin flood, **not**
a distributed/spoofed one. Consciously accepted.

**Status.** Shipped.

### 3.6 HTTP headers: strict CSP + `nosniff`

**Context.** The landing page renders user-supplied tags.

**Decision.** The HTML page (`serveStatic`) is served with a strict
Content-Security-Policy and `X-Content-Type-Options: nosniff`. The exact CSP
(`CSP` constant in `server/index.js`):

```
default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';
connect-src 'self'; img-src 'self' data:; font-src data:; base-uri 'none';
form-action 'none'; frame-ancestors 'none'
```

Every external/remote capability is denied; the page is a single self-contained
file (one inline `<script>`, inline `<style>`, a data-URI font, a same-origin
favicon). JSON responses also carry `nosniff`.

**Rationale.** Defense-in-depth on top of output encoding (§3.8): even if markup
slipped through, `default-src 'none'` + `connect-src 'self'` blocks exfiltration
and remote loads. `connect-src 'self'` is specifically what forces the
server-side stars proxy in §3.9.

**Tradeoffs / accepted risks.** The CSP uses `'unsafe-inline'` for script and
style because the page is a single self-contained file (no external bundle to
hash/nonce). Consciously accepted for a one-page site.

**Status.** Shipped.

### 3.7 Client URL scheme allow-list for `apiBaseUrl`

**Context.** `apiBaseUrl` from `config.json` is fed to **both** `fetch()` and
`shell.openExternal()` (the tray "View leaderboard…" action). A tampered/corrupt
config could otherwise point it at `javascript:`, `file:`, `data:`, etc.

**Decision.** `isSafeHttpUrl` (`lib/leaderboard-client.js`) accepts a value only
if it parses as an absolute URL with protocol `http:` or `https:`; anything else
falls back to `DEFAULT_API_BASE_URL`. This runs in `normalizeConfig`, alongside
the legacy-placeholder migration (§1.6).

**Rationale.** Because the value reaches the OS default handler via
`shell.openExternal`, an unchecked scheme is a real local-exploit vector; the
allow-list is a security boundary, not just validation.

**Status.** Shipped.

### 3.8 XSS-safe leaderboard rendering

**Context.** Tags are attacker-influenced and rendered in the browser.

**Decision (`server/public/index.html` script).** Tags are escaped via a
`textContent` round-trip (`esc()` sets `div.textContent = s` and reads back
`div.innerHTML`) before being placed in row markup. Money is coerced numerically
(`money()` uses `Number(n) || 0` then `toLocaleString`), and entries are filtered
to finite numbers before render. Server-side tag sanitization (§3.3) already
constrains what can be stored, so this is layered defense.

**Rationale.** Escaping user text + numeric coercion of money means no
attacker-controlled string is ever interpreted as markup, independent of the CSP.

**Status.** Shipped.

### 3.9 Server-side GitHub stars proxy (`GET /api/stars`)

**Context.** The page shows a live GitHub star count, but its CSP pins
`connect-src 'self'` (§3.6) — the page cannot call `api.github.com` directly.

**Decision.** The **server** fetches the stargazer count for `GITHUB_REPO`
(default `gceico/claude-make-it-rain`), caches it in memory for ~10 minutes,
de-dupes concurrent refreshes, times out after a few seconds, and **fails
silently** (serves the last good value, or `null` on cold start). It is exposed
same-origin at `GET /api/stars`.

**Rationale.** Satisfies the strict CSP without loosening `connect-src`; the
cache keeps well within GitHub's unauthenticated 60 req/hr/IP limit and survives
a slow/down GitHub without breaking the page.

**Status.** Shipped.

---

## 4. Anti-cheat & Integrity

### 4.1 Self-inflation of your OWN total is accepted as unsolvable

**Context.** The total is self-reported by the client; the server has no
independent source of truth for anyone's Claude Code spend.

**Decision.** Do not attempt to prevent a user from inflating their **own**
number. It is fundamentally unsolvable for a self-reported metric.

**Rationale.** This is a fun/vanity board, not a system of record. The only
defenses that make sense are bounding absurd values (the `MAX_TOTAL` cap, §3.3)
and slowing floods (the rate limiter, §3.5).

**Tradeoffs / accepted risks.** Someone can report any value up to the cap.
Consciously accepted.

**Status.** Shipped (as an accepted non-goal).

### 4.2 Tag spoofing: backend-issued per-tag credentials

**Context.** Distinct from §4.1: because tags are public, someone could report
under **another** person's tag to grief or impersonate them. The team iterated —
first designing HMAC-signed credentials + server-side tag masking, then dropping
that, then re-adopting the simplest workable version.

**Decision (design).** Backend-issued per-tag credentials:

- `POST /api/register` mints a random secret for an **unclaimed** tag. The secret
  is stored **hashed**, never in raw form.
- `POST /api/report` must present a valid secret for a **registered** tag, or it
  is rejected (`401`, not recorded).
- **Unregistered** tags are accepted on trust **by default** — a soft,
  zero-friction migration so existing installs keep working — **unless** a
  `REQUIRE_SIGNED` env flag is set, which flips the server to reject any report
  for an unregistered tag.

**Rationale.** The simplest scheme that stops casual tag spoofing without a login
or an account: registration claims a tag, and only the holder of that tag's
secret can report under it. Storing only the hash means a server/DB compromise
never leaks usable secrets. Default-soft keeps the migration friction-free;
`REQUIRE_SIGNED` is the lever to harden later.

**Tradeoffs / accepted risks.** While unregistered tags are trusted (the default),
a still-unclaimed tag can be spoofed — that gap is the reason `REQUIRE_SIGNED`
exists.

**Status.** **Implemented on branch `feat/tag-credentials` — NOT yet merged.**
This design is documented here for the record; the code is not on `main` /
`feat/railway-deploy`, and `server/index.js` on this branch has no
`/api/register` endpoint or `REQUIRE_SIGNED` flag.

### 4.3 Land-grab caveat (first-come tag claiming)

**Context.** Tags are shown publicly on the leaderboard, and registration is
first-come (§4.2).

**Decision / accepted risk.** Someone could register a rival's still-unregistered
tag before that rival upgrades to a credentialed client — an intrinsic property
of any first-come-claim scheme. Rate limiting (§3.5) only slows bulk attempts. For
a vanity board this is accepted; `REQUIRE_SIGNED` is the lever if it ever needs
tightening.

**Status.** Accepted (design consequence of §4.2).

### 4.4 The shipped integrity floor today

**Context.** §4.2 is not merged yet, so what actually protects the board right
now?

**Decision.** Today's integrity floor is the combination that _is_ live: the
`MAX_TOTAL` cap (§3.3) + input validation + the best-effort per-IP rate limiter
(§3.5). Tag credentials (§4.2) layer on top once merged.

**Status.** Shipped.

---

## Operational knobs

Environment variables actually read by the code on this branch (server unless
noted). Constants that are _not_ env-tunable are listed for completeness.

| Name                        | Default                      | Where                                          | Purpose                                                                                                                             |
| --------------------------- | ---------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `PORT`                      | `8787`                       | `server/index.js`                              | HTTP listen port                                                                                                                    |
| `LEADERBOARD_DB`            | `server/data/leaderboard.db` | `server/index.js`, `server/db.js`              | SQLite file path (reference deploy: `/data/leaderboard.db` on the volume)                                                           |
| `MAX_REPORT_TOTAL`          | `10000`                      | `server/index.js`                              | Upper bound on an accepted total (the `MAX_TOTAL` cap)                                                                              |
| `RATE_LIMIT_MAX`            | `60`                         | `server/index.js`                              | Max `POST /api/report` requests per IP per window                                                                                   |
| `RATE_LIMIT_WINDOW_MS`      | `60000`                      | `server/index.js`                              | Rate-limit window length (ms)                                                                                                       |
| `GITHUB_REPO`               | `gceico/claude-make-it-rain` | `server/index.js`                              | Repo whose star count powers `GET /api/stars`                                                                                       |
| `NODE_ENV`                  | `production`                 | `server/Dockerfile`                            | Standard Node environment flag                                                                                                      |
| `REQUIRE_SIGNED`            | _(unset)_                    | —                                              | **Planned** (§4.2): reject reports for unregistered tags. **Not present in code on this branch** — lives on `feat/tag-credentials`. |
| `MAX_BODY_BYTES` (constant) | `4096` (4 KB)                | `server/index.js`                              | Max request body size → `413`. **Not env-tunable** (a source constant).                                                             |
| `TAG_MAX_LENGTH` (constant) | `32`                         | `server/index.js`, `lib/leaderboard-client.js` | Tag length cap. **Not env-tunable**.                                                                                                |

Client-side (`lib/leaderboard-client.js`) config lives in `config.json`, not env:
`gamerTag`, `telemetryEnabled` (default `true`), `apiBaseUrl` (default
`https://aiburn.dev`, scheme-allow-listed per §3.7), and `reportIntervalMs`
(default hourly, floored at 60,000 ms).

---

## 5. Toolchain: the Bun + TypeScript + Astro port (2026-07-10)

The sections above were written when the codebase was Node + CommonJS with a
`node:sqlite` server and a hand-written HTML landing page under `server/public`.
On 2026-07-10 the project moved to a Bun + TypeScript toolchain with an Astro
site. Runtime behavior for end users is unchanged; the shift is dev-facing. File
references in the sections above (e.g. `server/index.js`, `lib/…`) predate the
rename to `server/index.ts` / `src/lib/…` and are kept as historical record.

### 5.1 Bun as the single toolchain

**Context.** The project juggled npm (package manager), `node:test` (tests), and
had no bundler — sources were shipped as-is.

**Decision.** Use **Bun** (pinned via `packageManager: bun@1.3.12`) as the
package manager (`bun.lock`, `package-lock.json` deleted), test runner
(`bun test` / `bun:test`), and bundler (`Bun.build`). `engines.node >= 22` stays
because the _published_ CLI runs under the user's Node.

**Rationale.** One fast tool for install, test, and build; TypeScript runs with
no separate transpile config; the server can execute `.ts` directly.

**Tradeoffs.** Contributors need Bun installed. CI uses `oven-sh/setup-bun`
(pinned to `@v2` until Dependabot SHA-pins it, matching the other actions).

### 5.2 Electron keeps its embedded Node → a compile step

**Context.** Electron cannot run on Bun; it embeds its own Node.

**Decision.** `scripts/build.ts` uses `Bun.build` to compile the TS sources to
**standalone CommonJS** — `dist/main.js`, `dist/preload.js`, and
`bin/make-it-rain.js` (node shebang injected, `chmod +x`) — with `electron`
kept **external** (a runtime `require`, never inlined). `main` points at
`dist/main.js`. `dist/` is gitignored and rebuilt by `bun run build`;
`bin/make-it-rain.js` is a committed artifact so `npx` works. `npm publish`
builds via the `prepublishOnly` hook, which is why the publish workflow sets up
Bun alongside Node.

### 5.3 `bun:sqlite` is drop-in for the existing DB

**Context.** The server stored state with `node:sqlite`; the on-disk DB lives on
the Railway `/data` volume.

**Decision.** Switch to `bun:sqlite`. The SQLite **file format is unchanged**, so
the existing `/data/leaderboard.db` keeps working with no migration. The
zero-npm-dependency invariant (§1.4) is preserved — `bun:sqlite` and `Bun.serve`
are builtins.

### 5.4 Astro static site, fully inlined for CSP

**Context.** The landing page shipped as a hand-written file under
`server/public` and had to satisfy the strict CSP (§3.6): no external
scripts/styles/fonts.

**Decision.** Rebuild the page as an **Astro 5** static site in `web/` (only
dependency: `astro`). `bun run build` emits a **single fully-inlined HTML file**

- favicon to `web/dist` — no external requests, so the existing
  `default-src 'none'` CSP still holds. `server/public` was deleted; the server
  now resolves static assets via `STATIC_DIR` → `server/public` (if present) →
  `web/dist`.

### 5.5 Multi-stage Docker build from the repo root

**Context.** The server image previously built `server/` alone; the site now
lives in a separate `web/` package that must be built and baked in.

**Decision.** `server/Dockerfile` is a **multi-stage** build (`oven/bun:1-alpine`)
run with the **repo root** as context: stage 1 builds `web/` (Astro → `web/dist`),
stage 2 runs the zero-dependency server with `STATIC_DIR=/app/public`. Both the
root and `server/` `railway.json` use `builder: DOCKERFILE` /
`dockerfilePath: server/Dockerfile`. The deploy workflow's path filter now
includes `web/**`, so a site-only change still redeploys.
