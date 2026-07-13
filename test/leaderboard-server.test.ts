/**
 * End-to-end security tests for the leaderboard HTTP server (Bun + bun:test).
 *
 * The client sanitizes tags before sending, but the SERVER must never trust
 * that — a raw curl/fetch POST bypasses the client entirely. These tests boot
 * the real server against a throwaway SQLite file on an ephemeral port and prove:
 *   - a malicious tag is sanitized (stripped to [A-Za-z0-9_-]) before storage
 *     and never round-trips as markup through /api/leaderboard;
 *   - totals are coerced/rejected so nothing NaN/Infinity/negative/absurd or
 *     non-numeric ever reaches the store or the page;
 *   - responses carry nosniff, JSON is typed application/json, and the HTML
 *     page ships a Content-Security-Policy.
 */

import { test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type RunningServer } from '../server/index.ts';

const tmpDir = mkdtempSync(join(tmpdir(), 'mir-server-test-'));
const dbPath = join(tmpDir, 'lb.db');
const staticDir = join(tmpDir, 'public');

// Rate-limit ceiling for the in-process server. Set comfortably above the ~19
// POSTs the rest of this suite fires from 127.0.0.1 so those never trip, while
// the dedicated rate-limit test floods a DISTINCT client IP (via x-forwarded-
// for) so it exercises the limiter in isolation without affecting other cases.
const RATE_LIMIT_MAX = 30;

let running: RunningServer;
let baseUrl: string;

beforeAll(() => {
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(
    join(staticDir, 'index.html'),
    '<!doctype html><title>Make It Rain</title><h1>Leaderboard</h1>'
  );

  running = serve({
    port: 0,
    hostname: '127.0.0.1',
    dbPath,
    staticDir,
    rateLimitMax: RATE_LIMIT_MAX,
  });
  baseUrl = `http://127.0.0.1:${running.server.port}`;
});

afterAll(() => {
  running.stop();
  running.db.close();
  rmSync(tmpDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

interface Res {
  status: number;
  headers: Headers;
  body: string;
}

async function request(
  method: string,
  urlPath: string,
  body?: unknown,
  extraHeaders?: Record<string, string>
): Promise<Res> {
  const headers: Record<string, string> = {};
  let data: string | undefined;
  if (body !== undefined) {
    data = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  if (extraHeaders) Object.assign(headers, extraHeaders);
  const res = await fetch(baseUrl + urlPath, { method, headers, body: data });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

// Same POST helper but with a raw (possibly non-JSON / oversized) body string.
async function rawPost(urlPath: string, rawBody: string): Promise<Res> {
  const res = await fetch(baseUrl + urlPath, { method: 'POST', body: rawBody });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

test('malicious tag is sanitized server-side and never round-trips as markup', async () => {
  const payloads = [
    { tag: '<img src=x onerror=alert(1)>', want: 'imgsrcxonerroralert1' },
    { tag: '"><script>evil</script>', want: 'scriptevilscript' },
    { tag: "' onmouseover='alert(1)", want: 'onmouseoveralert1' },
  ];
  for (const { tag } of payloads) {
    const res = await request('POST', '/api/report', { tag, total: 1 });
    expect(res.status).toBe(200);
  }
  const board = JSON.parse((await request('GET', '/api/leaderboard')).body);
  const tags: string[] = board.entries.map((e: { tag: string }) => e.tag);
  for (const { want } of payloads) expect(tags).toContain(want);
  for (const t of tags) expect(/[<>"'&]/.test(t)).toBe(false);

  const rawBoard = (await request('GET', '/api/leaderboard')).body;
  expect(rawBoard.includes('<script')).toBe(false);
  expect(rawBoard.includes('onerror=')).toBe(false);
  expect(/<[a-z]/i.test(rawBoard)).toBe(false);
});

test('tag that sanitizes to empty is rejected', async () => {
  const res = await request('POST', '/api/report', {
    tag: '💰🎉<>!@#',
    total: 1,
  });
  expect(res.status).toBe(400);
  expect(JSON.parse(res.body).error).toBe('invalid_tag');
});

test('total coercion: reject NaN/Inf/neg/absurd/non-number, round valid', async () => {
  const bad = [
    { total: 'Infinity', label: 'string "Infinity"' },
    { total: 'NaN', label: 'string "NaN"' },
    { total: -1, label: 'negative' },
    { total: { x: 1 }, label: 'object' },
    { total: null, label: 'null' },
    {
      total: 1.7976931348623157e308,
      label: 'huge finite (overflows *100 to Infinity)',
    },
    { total: 1e13, label: 'above MAX_TOTAL' },
  ];
  for (const { total, label } of bad) {
    const res = await request('POST', '/api/report', {
      tag: 'EdgeCase',
      total,
    });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_total');
    void label;
  }
  // 1e999 parses to Infinity via JSON.parse -> rejected.
  const inf = await rawPost('/api/report', '{"tag":"EdgeCase","total":1e999}');
  expect(inf.status).toBe(400);

  // Valid totals are accepted and rounded to cents.
  const rounded = JSON.parse(
    (await request('POST', '/api/report', { tag: 'RoundMe', total: 10.239 }))
      .body
  );
  expect(rounded.total).toBe(10.24);

  const board = JSON.parse((await request('GET', '/api/leaderboard')).body);
  for (const e of board.entries as { tag: string; total: number }[]) {
    expect(typeof e.total).toBe('number');
    expect(isFinite(e.total)).toBe(true);
  }
});

test('daily total cap: reject 10001, accept 9999', async () => {
  const over = await request('POST', '/api/report', {
    tag: 'CapCheck',
    total: 10001,
  });
  expect(over.status).toBe(400);
  expect(JSON.parse(over.body).error).toBe('invalid_total');

  const under = await request('POST', '/api/report', {
    tag: 'CapCheck',
    total: 9999,
  });
  expect(under.status).toBe(200);
  expect(JSON.parse(under.body).total).toBe(9999);
});

test('oversized body returns 413 body_too_large and is never stored', async () => {
  const huge = await rawPost(
    '/api/report',
    JSON.stringify({ tag: 'A'.repeat(8000), total: 1 })
  );
  expect(huge.status).toBe(413);
  expect(JSON.parse(huge.body).error).toBe('body_too_large');
  const board = JSON.parse((await request('GET', '/api/leaderboard')).body);
  expect(
    board.entries.some((e: { tag: string }) => e.tag.startsWith('AAAA'))
  ).toBe(false);
});

test('per-IP rate limiter (429 + Retry-After past limit, other IP OK)', async () => {
  // Flood a DISTINCT client IP via x-forwarded-for so the limiter is exercised
  // in isolation from the 127.0.0.1 traffic the rest of the suite generates.
  const floodHeaders = { 'x-forwarded-for': '198.51.100.7' };
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const ok = await request(
      'POST',
      '/api/report',
      { tag: 'Flood', total: 1 },
      floodHeaders
    );
    expect(ok.status).toBe(200);
  }
  const blocked = await request(
    'POST',
    '/api/report',
    { tag: 'Flood', total: 1 },
    floodHeaders
  );
  expect(blocked.status).toBe(429);
  expect(JSON.parse(blocked.body).error).toBe('rate_limited');
  expect(blocked.headers.get('retry-after')).toBeTruthy();
  expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
  expect(blocked.headers.get('x-content-type-options')).toBe('nosniff');

  const other = await request(
    'POST',
    '/api/report',
    { tag: 'Other', total: 1 },
    { 'x-forwarded-for': '203.0.113.9' }
  );
  expect(other.status).toBe(200);
});

test('rate limiter keys on the proxy-appended (rightmost) XFF entry', async () => {
  // A client can prepend arbitrary entries to x-forwarded-for; only the
  // RIGHTMOST one is appended by the trusted proxy in front of the server. If
  // the limiter keyed on the leftmost entry, each request below would land in
  // its own bucket and the flood would never trip 429.
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    const ok = await request(
      'POST',
      '/api/report',
      { tag: 'Spoof', total: 1 },
      { 'x-forwarded-for': `10.0.${i}.1, 192.0.2.50` }
    );
    expect(ok.status).toBe(200);
  }
  const blocked = await request(
    'POST',
    '/api/report',
    { tag: 'Spoof', total: 1 },
    { 'x-forwarded-for': '10.99.99.99, 192.0.2.50' }
  );
  expect(blocked.status).toBe(429);
  expect(JSON.parse(blocked.body).error).toBe('rate_limited');
});

test('security headers (nosniff + JSON type + CSP on HTML)', async () => {
  const board = await request('GET', '/api/leaderboard');
  expect(
    /application\/json/.test(board.headers.get('content-type') || '')
  ).toBe(true);
  expect(board.headers.get('x-content-type-options')).toBe('nosniff');

  const page = await request('GET', '/');
  expect(/text\/html/.test(page.headers.get('content-type') || '')).toBe(true);
  expect(page.headers.get('x-content-type-options')).toBe('nosniff');
  const csp = page.headers.get('content-security-policy') || '';
  expect(csp).toBeTruthy();
  expect(/default-src 'none'/.test(csp)).toBe(true);
  // Same-origin bundle + inline JSON-LD are allowed; remote scripts stay denied.
  expect(/script-src 'self' 'unsafe-inline'/.test(csp)).toBe(true);
});

test('GET /api/collective returns date, total, activeTags and a 24-bucket series', async () => {
  await request('POST', '/api/report', { tag: 'CollectiveOne', total: 12 });
  await request('POST', '/api/report', { tag: 'CollectiveTwo', total: 8 });

  const res = await request('GET', '/api/collective');
  expect(res.status).toBe(200);
  const data = JSON.parse(res.body);
  expect(typeof data.date).toBe('string');
  expect(typeof data.total).toBe('number');
  expect(data.total).toBeGreaterThanOrEqual(20);
  expect(typeof data.activeTags).toBe('number');
  expect(Array.isArray(data.hours)).toBe(true);
  expect(data.hours.length).toBe(24);
  const sum = data.hours.reduce(
    (s: number, h: { spend: number }) => s + h.spend,
    0
  );
  expect(Math.round(sum * 100) / 100).toBe(Math.round(data.total * 100) / 100);
  // No ?tag= -> no personal echo.
  expect(data.you).toBeUndefined();
});

test('GET /api/collective?tag= echoes a sanitized personal total', async () => {
  await request('POST', '/api/report', { tag: 'MeTag', total: 15 });
  const res = await request(
    'GET',
    '/api/collective?tag=' + encodeURIComponent('<b>MeTag</b>')
  );
  expect(res.status).toBe(200);
  const data = JSON.parse(res.body);
  // Tag is sanitized server-side to [A-Za-z0-9_-] before lookup.
  expect(data.you).toBeDefined();
  expect(data.you.tag).toBe('bMeTagb');
  expect(typeof data.you.total).toBe('number');
});

test('non-JSON report body is rejected with 400 invalid_json', async () => {
  const res = await rawPost('/api/report', 'not json');
  expect(res.status).toBe(400);
  expect(JSON.parse(res.body).error).toBe('invalid_json');
});

test('GET /health returns 200 { ok: true }', async () => {
  const res = await request('GET', '/health');
  expect(res.status).toBe(200);
  expect(JSON.parse(res.body)).toEqual({ ok: true });
});

test('unknown POST path falls through to 404 not_found', async () => {
  // Does not hit POST /api/report, so the rate limiter is never invoked.
  const res = await request('POST', '/api/nonexistent');
  expect(res.status).toBe(404);
  expect(JSON.parse(res.body).error).toBe('not_found');
});

test('static serving never escapes staticDir (traversal + containment)', async () => {
  // The DB file lives one level above staticDir; none of these shapes may
  // reach it. Bun's fetch client normalizes both '%2e%2e' and literal '../'
  // out of the path before it hits the wire, so over HTTP these arrive as
  // '/lb.db' and 404 inside staticDir (the DB is not in staticDir).
  const encoded = await request('GET', '/%2e%2e/lb.db');
  expect(encoded.status).toBe(404);
  expect(encoded.body.includes('SQLite')).toBe(false);

  const literal = await request('GET', '/../lb.db');
  expect(literal.status).toBe(404);
  expect(literal.body.includes('SQLite')).toBe(false);

  // The startsWith containment branch itself is unreachable through a
  // normalizing HTTP client, so drive the handler directly: a Request keeps
  // pathname '//', which strips to rel '' so filePath equals staticDir with
  // no trailing separator — the exact shape the guard exists for.
  const containment = await running.app.fetch(
    new Request(`${baseUrl}//`),
    running.server
  );
  expect(containment.status).toBe(403);
  expect((await containment.text()).includes('SQLite')).toBe(false);
});
