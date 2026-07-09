'use strict';

/**
 * Make It Rain — cloud daily-leaderboard server.
 *
 * Zero-dependency Node HTTP server (SQLite state via the built-in node:sqlite).
 * Run locally with:  node server/index.js   (listens on :8787 by default)
 * Deploys to Railway with:  railway up ./server
 *
 * Endpoints:
 *   POST /api/report        body { tag: string, total: number } -> { ok, total }
 *   GET  /api/leaderboard   -> { date, entries: [{ tag, total }] } (today only)
 *   GET  /api/stars         -> { stars: number|null } (GitHub stars, cached)
 *   GET  /                  -> static landing page (server/public/index.html)
 *   GET  /health            -> { ok: true }
 *
 * Privacy: only the anonymized tag + numeric total are accepted and stored. We
 * deliberately do NOT log IPs or persist request metadata. Leaderboard is per
 * UTC day and resets automatically (old days are pruned).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { LeaderboardDB } = require('./db');

const PORT = Number(process.env.PORT) || 8787;
const DATA_FILE = process.env.LEADERBOARD_DB || path.join(__dirname, 'data', 'leaderboard.db');
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY_BYTES = 4 * 1024; // reports are tiny; reject anything larger
const TAG_MAX_LENGTH = 32;
// Upper bound on a reported total. This is a self-reported board, so the cap is
// really about bounding absurd/troll values (and, as a bonus, rejecting the
// near-MAX_VALUE numbers that survive isFinite() but overflow to Infinity in
// `total * 100`). A day of Claude Code spend realistically lives in the tens or
// low hundreds of dollars; a $10,000/day default ceiling is generous while still
// keeping the board honest. Tunable via MAX_REPORT_TOTAL for edge cases.
const MAX_TOTAL = Number(process.env.MAX_REPORT_TOTAL) || 10000;

// ── Per-IP rate limiting for POST /api/report ───────────────────────────────
// Legit clients report at most hourly, so a generous ceiling (60 req/min/IP by
// default) never inconveniences real users while stopping a trivial single-
// source flood. Client IP comes from x-forwarded-for (Railway sits behind a
// proxy, so req.socket.remoteAddress is the proxy). XFF is client-influenceable,
// so this is best-effort: it blocks the naive single-origin flood, NOT a
// distributed one. Both the max and window are env-overridable.
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX) || 60;
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000;

// GitHub repo whose star count powers the "Star on GitHub" pill. The page can't
// call api.github.com directly (its CSP pins connect-src to 'self'), so the
// server fetches the count, caches it in memory, and exposes it same-origin at
// GET /api/stars. Unauthenticated GitHub allows 60 req/hr per IP; a 10-minute
// cache keeps us to ~6/hr and serves the last good value if GitHub is slow or
// down. Override the repo with GITHUB_REPO if this ever gets forked.
const GITHUB_REPO = process.env.GITHUB_REPO || 'gceico/claude-make-it-rain';
const STARS_TTL_MS = 10 * 60 * 1000;
const STARS_FETCH_TIMEOUT_MS = 4000;
const starsCache = { stars: null, fetchedAt: 0 };
let starsInFlight = null;

async function fetchStarCount() {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), STARS_FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(`https://api.github.com/repos/${GITHUB_REPO}`, {
      headers: {
        accept: 'application/vnd.github+json',
        'user-agent': 'make-it-rain-leaderboard',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`github status ${resp.status}`);
    const data = await resp.json();
    const n = data && data.stargazers_count;
    if (typeof n === 'number' && isFinite(n)) {
      starsCache.stars = n;
      starsCache.fetchedAt = Date.now();
    }
  } catch {
    // Fail silently: keep serving the last cached value (or null on cold start).
  } finally {
    clearTimeout(timer);
  }
  return starsCache.stars;
}

// Returns the cached count immediately when fresh; otherwise refreshes (de-duping
// concurrent refreshes) and never rejects — callers always get a { stars } shape.
async function getStarCount() {
  const fresh = Date.now() - starsCache.fetchedAt < STARS_TTL_MS;
  if (fresh && starsCache.stars !== null) return starsCache.stars;
  if (!starsInFlight) {
    starsInFlight = fetchStarCount().finally(() => { starsInFlight = null; });
  }
  return starsInFlight;
}

// Strict Content-Security-Policy for the leaderboard page. The page is a single
// self-contained file with one inline <script> and inline <style>, so inline is
// allowed, but every external/remote capability is denied — defense-in-depth on
// top of output encoding + server-side tag sanitization.
const CSP =
  "default-src 'none'; " +
  "script-src 'unsafe-inline'; " +
  "style-src 'unsafe-inline'; " +
  "connect-src 'self'; " +
  "img-src 'self' data:; " +
  "font-src data:; " +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'";

const db = new LeaderboardDB(DATA_FILE);

function sendJSON(res, status, obj, extraHeaders) {
  const body = JSON.stringify(obj);
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  res.writeHead(status, headers);
  res.end(body);
}

// Best-effort client IP: prefer the FIRST (leftmost) x-forwarded-for entry set
// by the proxy in front of us; fall back to the raw socket when the header is
// absent (e.g. local/direct connections). XFF is spoofable, so treat as a hint.
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

// Fixed-window counter keyed by client IP. Each entry holds the request count
// for the current window plus the timestamp it resets. On limit exceeded we
// return the seconds until reset so the caller can emit a Retry-After header.
const rateBuckets = new Map();

function checkRateLimit(ip, now = Date.now()) {
  let bucket = rateBuckets.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > RATE_LIMIT_MAX) {
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)) };
  }
  return { allowed: true };
}

// Memory safety: the IP map would otherwise grow without bound. A low-frequency
// background sweep drops entries whose window has fully expired. `.unref()` keeps
// this timer from holding the event loop open (so tests/CLI exit cleanly).
const rateSweeper = setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now >= bucket.resetAt) rateBuckets.delete(ip);
  }
}, RATE_LIMIT_WINDOW_MS);
rateSweeper.unref();

function sanitizeTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, TAG_MAX_LENGTH);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let done = false;
    const chunks = [];
    req.on('data', (c) => {
      if (done) return; // already over the limit — discard the rest, drain the socket
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        done = true;
        // Tagged so handleReport can distinguish this from a JSON parse error
        // and answer 413 instead of 400. We do NOT destroy the socket: letting
        // the stream drain naturally keeps the connection alive long enough to
        // write the 413 response back to the client.
        const err = new Error('body too large');
        err.code = 'BODY_TOO_LARGE';
        reject(err);
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } });
    req.on('error', (e) => { if (!done) { done = true; reject(e); } });
  });
}

async function handleReport(req, res) {
  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    if (err && err.code === 'BODY_TOO_LARGE') {
      return sendJSON(res, 413, { ok: false, error: 'body_too_large' });
    }
    return sendJSON(res, 400, { ok: false, error: 'invalid_json' });
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return sendJSON(res, 400, { ok: false, error: 'invalid_json' });
  }

  const tag = sanitizeTag(payload && payload.tag);
  let total = payload && payload.total;
  if (!tag) return sendJSON(res, 400, { ok: false, error: 'invalid_tag' });
  if (typeof total !== 'number' || !isFinite(total) || total < 0 || total > MAX_TOTAL) {
    return sendJSON(res, 400, { ok: false, error: 'invalid_total' });
  }
  total = Math.round(total * 100) / 100;

  const stored = db.report(tag, total);
  return sendJSON(res, 200, { ok: true, total: stored });
}

function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).toLowerCase();
    const type = ext === '.html' ? 'text/html; charset=utf-8'
      : ext === '.css' ? 'text/css; charset=utf-8'
      : ext === '.js' ? 'text/javascript; charset=utf-8'
      : ext === '.svg' ? 'image/svg+xml; charset=utf-8'
      : 'application/octet-stream';
    const headers = { 'content-type': type, 'x-content-type-options': 'nosniff' };
    if (ext === '.html') headers['content-security-policy'] = CSP;
    res.writeHead(200, headers);
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') { return sendJSON(res, 204, {}); }

  if (req.method === 'POST' && pathname === '/api/report') {
    const limit = checkRateLimit(clientIp(req));
    if (!limit.allowed) {
      return sendJSON(res, 429, { ok: false, error: 'rate_limited' }, { 'retry-after': String(limit.retryAfterSec) });
    }
    return handleReport(req, res);
  }
  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    return sendJSON(res, 200, { date: LeaderboardDB.today(), entries: db.leaderboard() });
  }
  if (req.method === 'GET' && pathname === '/api/stars') {
    return getStarCount().then((stars) => sendJSON(res, 200, { stars }));
  }
  if (req.method === 'GET' && pathname === '/health') return sendJSON(res, 200, { ok: true });
  if (req.method === 'GET') return serveStatic(res, pathname);

  return sendJSON(res, 404, { ok: false, error: 'not_found' });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Make It Rain leaderboard server listening on http://localhost:${PORT}`);
  });
}

module.exports = { server, db };
