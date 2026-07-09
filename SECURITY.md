# Security Policy

## Supported versions

Only the latest published version of `@gceico/claude-make-it-rain` receives
security fixes. Please upgrade before reporting.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

Report privately through GitHub's
[private vulnerability reporting](https://github.com/gceico/claude-make-it-rain/security/advisories/new)
(Security → Advisories → *Report a vulnerability*). If that is unavailable,
email the maintainer at ceicoschi.gabriel@gmail.com.

Please include:

- A description of the issue and its impact
- Steps to reproduce (a proof of concept if you have one)
- The affected version(s)

You can expect an acknowledgement within a few days. Once a fix ships, we're
happy to credit you in the release notes unless you'd prefer to stay anonymous.

## Scope & design notes

This is a satirical desktop app plus a small public leaderboard server. Things
worth knowing when assessing impact:

- **The app reads only local Claude Code session logs** under `~/.claude/projects`
  to estimate spend. It does not transmit prompt or file contents.
- **The leaderboard stores anonymous tags and a daily spend estimate** — no
  accounts, no personal data. Submissions are validated and clamped server-side.
- **The leaderboard page ships a strict `Content-Security-Policy`** (`default-src
  'none'`) and serves assets same-origin only.
- **Publishing to npm uses OIDC trusted publishing** with SHA-pinned GitHub
  Actions and provenance — there is no long-lived npm token to steal.
