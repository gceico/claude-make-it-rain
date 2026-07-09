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
// Upper bound on a reported total. A trillion USD/day is already absurd; the
// real reason for a cap is safety: totals near Number.MAX_VALUE survive the
// isFinite() check but overflow to Infinity in `total * 100`, which SQLite
// then stores and JSON serializes as `null`. Rejecting them keeps only clean,
// finite, renderable numbers in the store.
const MAX_TOTAL = 1e12;

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
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'";

const db = new LeaderboardDB(DATA_FILE);

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sanitizeTag(tag) {
  if (typeof tag !== 'string') return '';
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, TAG_MAX_LENGTH);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleReport(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req));
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

  if (req.method === 'POST' && pathname === '/api/report') return handleReport(req, res);
  if (req.method === 'GET' && pathname === '/api/leaderboard') {
    return sendJSON(res, 200, { date: LeaderboardDB.today(), entries: db.leaderboard() });
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
