'use strict';

/**
 * End-to-end security tests for the leaderboard HTTP server.
 *
 * The client sanitizes tags before sending, but the SERVER must never trust
 * that — a raw curl/fetch POST bypasses the client entirely. These tests boot
 * the real server against a throwaway SQLite file and prove that:
 *   - a malicious tag is sanitized (stripped to [A-Za-z0-9_-]) before storage
 *     and never round-trips as markup through /api/leaderboard;
 *   - totals are coerced/rejected so nothing NaN/Infinity/negative/absurd or
 *     non-numeric ever reaches the store or the page;
 *   - responses carry nosniff, JSON is typed application/json, and the HTML
 *     page ships a Content-Security-Policy.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-server-test-'));
process.env.LEADERBOARD_DB = path.join(tmpDir, 'lb.db');
// Rate-limit ceiling for the in-process server. Set comfortably above the ~17
// POSTs the rest of this suite fires from 127.0.0.1 so those never trip, while
// the dedicated rate-limit test floods a DISTINCT client IP (via x-forwarded-
// for) so it exercises the limiter in isolation without affecting other cases.
const RATE_LIMIT_MAX = 30;
process.env.RATE_LIMIT_MAX = String(RATE_LIMIT_MAX);

const { server, db } = require('../server/index');

function request(method, urlPath, body, extraHeaders) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = data
      ? { 'content-type': 'application/json', 'content-length': data.length }
      : {};
    if (extraHeaders) Object.assign(headers, extraHeaders);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        method,
        path: urlPath,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// Same POST helper but with a raw (possibly non-JSON) body string.
function rawPost(urlPath, rawBody) {
  return new Promise((resolve) => {
    const addr = server.address();
    const data = Buffer.from(rawBody);
    const req = http.request(
      { host: '127.0.0.1', port: addr.port, method: 'POST', path: urlPath, headers: { 'content-length': data.length } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      }
    );
    // The server destroys the socket on an oversized body; surface that as a
    // non-acceptance (status 0) rather than a thrown error.
    req.on('error', () => resolve({ status: 0, body: '' }));
    req.write(data);
    req.end();
  });
}

(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  // ── Malicious tag is sanitized server-side, never stored/returned as markup ─
  {
    const payloads = [
      { tag: '<img src=x onerror=alert(1)>', want: 'imgsrcxonerroralert1' },
      { tag: '"><script>evil</script>', want: 'scriptevilscript' },
      { tag: "' onmouseover='alert(1)", want: 'onmouseoveralert1' },
    ];
    for (const { tag } of payloads) {
      const res = await request('POST', '/api/report', { tag, total: 1 });
      assert.strictEqual(res.status, 200, `accepted (sanitized) tag ${JSON.stringify(tag)}`);
    }
    const board = JSON.parse((await request('GET', '/api/leaderboard')).body);
    const tags = board.entries.map((e) => e.tag);
    for (const { want } of payloads) assert.ok(tags.includes(want), `stored sanitized: ${want}`);
    // No entry contains any HTML-significant character — the markup is gone.
    for (const t of tags) assert.ok(!/[<>"'&]/.test(t), `tag has no markup chars: ${JSON.stringify(t)}`);
    // No active markup survives anywhere in the JSON response (letters such as
    // the "onerror" in "imgsrcxonerroralert1" are inert without </<>"'=).
    const rawBoard = (await request('GET', '/api/leaderboard')).body;
    assert.ok(!rawBoard.includes('<script'), 'no <script in leaderboard JSON');
    assert.ok(!rawBoard.includes('onerror='), 'no onerror= handler in leaderboard JSON');
    assert.ok(!/<[a-z]/i.test(rawBoard), 'no HTML tag opener in leaderboard JSON');
    console.log('server: malicious tag sanitized + never round-trips as markup: OK');
  }

  // ── Empty-after-sanitize tag is rejected ────────────────────────────────────
  {
    const res = await request('POST', '/api/report', { tag: '💰🎉<>!@#', total: 1 });
    assert.strictEqual(res.status, 400, 'tag that sanitizes to empty is rejected');
    assert.strictEqual(JSON.parse(res.body).error, 'invalid_tag');
    console.log('server: empty-after-sanitize tag rejected: OK');
  }

  // ── Total coercion / rejection edge cases ───────────────────────────────────
  {
    const bad = [
      { total: 'Infinity', label: 'string "Infinity"' },
      { total: 'NaN', label: 'string "NaN"' },
      { total: -1, label: 'negative' },
      { total: { x: 1 }, label: 'object' },
      { total: null, label: 'null' },
      { total: 1.7976931348623157e308, label: 'huge finite (overflows *100 to Infinity)' },
      { total: 1e13, label: 'above MAX_TOTAL' },
    ];
    for (const { total, label } of bad) {
      const res = await request('POST', '/api/report', { tag: 'EdgeCase', total });
      assert.strictEqual(res.status, 400, `total rejected: ${label}`);
      assert.strictEqual(JSON.parse(res.body).error, 'invalid_total', `invalid_total for ${label}`);
    }
    // 1e999 parses to Infinity via JSON.parse -> rejected.
    const inf = await rawPost('/api/report', '{"tag":"EdgeCase","total":1e999}');
    assert.strictEqual(inf.status, 400, '1e999 (-> Infinity) rejected');

    // Valid totals are accepted and rounded to cents; nothing null/Infinity is
    // ever stored (regression guard for the overflow bug).
    assert.strictEqual(JSON.parse((await request('POST', '/api/report', { tag: 'RoundMe', total: 10.239 })).body).total, 10.24);
    const board = JSON.parse((await request('GET', '/api/leaderboard')).body);
    for (const e of board.entries) {
      assert.strictEqual(typeof e.total, 'number', `total is a number for ${e.tag}`);
      assert.ok(isFinite(e.total), `total is finite for ${e.tag}`);
    }
    console.log('server: total coercion (reject NaN/Inf/neg/absurd/non-number, round valid): OK');
  }

  // ── Daily total cap: $10k default (env-tunable via MAX_REPORT_TOTAL) ─────────
  {
    const over = await request('POST', '/api/report', { tag: 'CapCheck', total: 10001 });
    assert.strictEqual(over.status, 400, 'total just above the $10k cap is rejected');
    assert.strictEqual(JSON.parse(over.body).error, 'invalid_total', 'above-cap error is invalid_total');

    const under = await request('POST', '/api/report', { tag: 'CapCheck', total: 9999 });
    assert.strictEqual(under.status, 200, 'total below the cap is accepted');
    assert.strictEqual(JSON.parse(under.body).total, 9999, 'accepted total round-trips');
    console.log('server: total cap (reject 10001, accept 9999): OK');
  }

  // ── Oversized body is rejected by the 4KB guard (no crash, not stored) ──────
  {
    const huge = await rawPost('/api/report', JSON.stringify({ tag: 'A'.repeat(8000), total: 1 }));
    assert.notStrictEqual(huge.status, 200, 'oversized body not accepted');
    const board = JSON.parse((await request('GET', '/api/leaderboard')).body);
    assert.ok(!board.entries.some((e) => e.tag.startsWith('AAAA')), 'oversized tag never stored');
    console.log('server: oversized body guard holds: OK');
  }

  // ── Oversized body returns a proper 413 body_too_large (not 400 invalid_json) ─
  {
    // >MAX_BODY_BYTES (4KB) of valid JSON: the guard must answer 413, and the
    // tagged error must NOT be mislabeled as a JSON parse failure.
    const big = await rawPost('/api/report', JSON.stringify({ tag: 'B'.repeat(5000), total: 1 }));
    assert.strictEqual(big.status, 413, 'oversized body returns 413');
    assert.strictEqual(JSON.parse(big.body).error, 'body_too_large', 'oversized body error is body_too_large');
    console.log('server: oversized body returns 413 body_too_large: OK');
  }

  // ── Per-IP rate limiter on POST /api/report ─────────────────────────────────
  {
    // Flood a DISTINCT client IP via x-forwarded-for so the limiter is exercised
    // in isolation from the 127.0.0.1 traffic the rest of the suite generates.
    const floodHeaders = { 'x-forwarded-for': '198.51.100.7' };
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const ok = await request('POST', '/api/report', { tag: 'Flood', total: 1 }, floodHeaders);
      assert.strictEqual(ok.status, 200, `request ${i + 1} under the limit succeeds`);
    }
    const blocked = await request('POST', '/api/report', { tag: 'Flood', total: 1 }, floodHeaders);
    assert.strictEqual(blocked.status, 429, 'request over the limit is rate-limited');
    assert.strictEqual(JSON.parse(blocked.body).error, 'rate_limited', '429 body error is rate_limited');
    assert.ok(blocked.headers['retry-after'], '429 carries a Retry-After header');
    assert.ok(Number(blocked.headers['retry-after']) > 0, 'Retry-After is a positive number of seconds');
    assert.strictEqual(blocked.headers['x-content-type-options'], 'nosniff', '429 keeps nosniff header');

    // A different IP is unaffected (the limiter is per-IP, not global).
    const other = await request('POST', '/api/report', { tag: 'Other', total: 1 }, { 'x-forwarded-for': '203.0.113.9' });
    assert.strictEqual(other.status, 200, 'a different IP is not rate-limited');
    console.log('server: per-IP rate limiter (429 + Retry-After past limit, other IP OK): OK');
  }

  // ── Security headers ────────────────────────────────────────────────────────
  {
    const board = await request('GET', '/api/leaderboard');
    assert.ok(/application\/json/.test(board.headers['content-type']), 'leaderboard is application/json');
    assert.strictEqual(board.headers['x-content-type-options'], 'nosniff', 'JSON has nosniff');

    const page = await request('GET', '/');
    assert.ok(/text\/html/.test(page.headers['content-type']), 'page is text/html');
    assert.strictEqual(page.headers['x-content-type-options'], 'nosniff', 'HTML has nosniff');
    assert.ok(page.headers['content-security-policy'], 'HTML has a CSP');
    assert.ok(/default-src 'none'/.test(page.headers['content-security-policy']), 'CSP locks default-src');
    console.log('server: security headers (nosniff + JSON type + CSP on HTML): OK');
  }

  await new Promise((r) => server.close(r));
  db.close(); // release the SQLite handle so Windows can delete the temp file
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  console.log('\nAll leaderboard-server tests passed.');
})().catch((err) => {
  console.error(err);
  try { server.close(); } catch { /* ignore */ }
  process.exit(1);
});
