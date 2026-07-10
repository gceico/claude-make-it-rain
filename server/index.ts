/**
 * Make It Rain — cloud daily-leaderboard server (Bun + TypeScript).
 *
 * Zero-dependency Bun HTTP server (SQLite state via the built-in bun:sqlite).
 * Run locally with:  bun index.ts   (listens on :8787 by default)
 * Deploys to Railway from the Dockerfile (see server/Dockerfile).
 *
 * Endpoints:
 *   POST /api/report        body { tag: string, total: number } -> { ok, total }
 *   GET  /api/leaderboard   -> { date, entries: [{ tag, total }] } (today only)
 *   GET  /api/stars         -> { stars: number|null } (GitHub stars, cached)
 *   GET  /                  -> static landing page (STATIC_DIR, see below)
 *   GET  /health            -> { ok: true }
 *
 * Privacy: only the anonymized tag + numeric total are accepted and stored. We
 * deliberately do NOT log IPs or persist request metadata. Leaderboard is per
 * UTC day and resets automatically (old days are pruned).
 */

import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { LeaderboardDB } from './db.ts';

// Minimal structural view of the Bun `Server` passed to a fetch handler: we only
// read the client socket address off it. Kept structural (rather than importing
// the generic `Server` type) so it stays valid across bun-types versions.
interface RequestIpServer {
  requestIP(req: Request): { address: string } | null;
}

const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 4 * 1024; // reports are tiny; reject anything larger
const TAG_MAX_LENGTH = 32;
const STARS_TTL_MS = 10 * 60 * 1000;
const STARS_FETCH_TIMEOUT_MS = 4000;

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
  'font-src data:; ' +
  "base-uri 'none'; " +
  "form-action 'none'; " +
  "frame-ancestors 'none'";

export interface AppConfig {
  /** Path to the SQLite file. Defaults to LEADERBOARD_DB env / server/data. */
  dbPath?: string;
  /**
   * Directory to serve static files from. Default resolution when omitted:
   * STATIC_DIR env if set, else server/public if it exists, else web/dist
   * (the Astro build output, baked into the Docker image at /app/public).
   */
  staticDir?: string;
  /** Upper bound on a reported total. */
  maxTotal?: number;
  /** Fixed-window per-IP request ceiling for POST /api/report. */
  rateLimitMax?: number;
  /** Rate-limit window length in ms. */
  rateLimitWindowMs?: number;
  /** GitHub repo powering GET /api/stars. */
  githubRepo?: string;
}

export interface App {
  readonly db: LeaderboardDB;
  fetch(req: Request, server: RequestIpServer): Promise<Response> | Response;
  /** Stop the background rate-limit sweeper (does NOT close the DB). */
  dispose(): void;
}

// Default static dir resolution: STATIC_DIR env > server/public (if present) >
// web/dist (the Astro build output). The last is returned even if it does not
// exist yet, so serveStatic simply 404s until the site is built/baked in.
function resolveStaticDir(): string {
  if (process.env.STATIC_DIR) return process.env.STATIC_DIR;
  const pub = join(import.meta.dir, 'public');
  if (existsSync(pub)) return pub;
  return join(import.meta.dir, '..', 'web', 'dist');
}

function jsonResponse(
  status: number,
  obj: unknown,
  extraHeaders?: Record<string, string>
): Response {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'cache-control': 'no-store',
  };
  if (extraHeaders) Object.assign(headers, extraHeaders);
  return new Response(JSON.stringify(obj), { status, headers });
}

// Best-effort client IP: prefer the FIRST (leftmost) x-forwarded-for entry set
// by the proxy in front of us; fall back to the raw socket when the header is
// absent (e.g. local/direct connections). XFF is spoofable, so treat as a hint.
function clientIp(req: Request, server: RequestIpServer): string {
  const xff = req.headers.get('x-forwarded-for');
  if (xff && xff.length > 0) {
    return xff.split(',')[0]!.trim();
  }
  return server.requestIP(req)?.address || '';
}

function sanitizeTag(tag: unknown): string {
  if (typeof tag !== 'string') return '';
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, TAG_MAX_LENGTH);
}

const STATIC_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
};

async function serveStatic(
  staticDir: string,
  pathname: string
): Promise<Response> {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const filePath = normalize(join(staticDir, rel));
  if (!filePath.startsWith(staticDir)) {
    return new Response('Forbidden', { status: 403 });
  }
  const file = Bun.file(filePath);
  if (!(await file.exists())) {
    return new Response('Not found', { status: 404 });
  }
  const ext = extname(filePath).toLowerCase();
  const type = STATIC_TYPES[ext] || 'application/octet-stream';
  const headers: Record<string, string> = {
    'content-type': type,
    'x-content-type-options': 'nosniff',
  };
  if (ext === '.html') headers['content-security-policy'] = CSP;
  return new Response(file, { status: 200, headers });
}

interface RateBucket {
  count: number;
  resetAt: number;
}

interface RateResult {
  allowed: boolean;
  retryAfterSec?: number;
}

export function createApp(config: AppConfig = {}): App {
  const db = new LeaderboardDB(config.dbPath);

  // Upper bound on a reported total. This is a self-reported board, so the cap
  // is really about bounding absurd/troll values (and, as a bonus, rejecting the
  // near-MAX_VALUE numbers that survive isFinite() but overflow to Infinity in
  // `total * 100`). A $10,000/day default ceiling is generous while still keeping
  // the board honest. Tunable via MAX_REPORT_TOTAL for edge cases.
  const maxTotal =
    config.maxTotal ?? (Number(process.env.MAX_REPORT_TOTAL) || 10000);

  // Per-IP rate limiting for POST /api/report. Legit clients report at most
  // hourly, so a generous ceiling (60 req/min/IP by default) never inconveniences
  // real users while stopping a trivial single-source flood.
  const rateLimitMax =
    config.rateLimitMax ?? (Number(process.env.RATE_LIMIT_MAX) || 60);
  const rateLimitWindowMs =
    config.rateLimitWindowMs ??
    (Number(process.env.RATE_LIMIT_WINDOW_MS) || 60_000);

  // GitHub repo whose star count powers the "Star on GitHub" pill. The page can't
  // call api.github.com directly (its CSP pins connect-src to 'self'), so the
  // server fetches the count, caches it in memory, and exposes it same-origin at
  // GET /api/stars. Unauthenticated GitHub allows 60 req/hr per IP; a 10-minute
  // cache keeps us to ~6/hr and serves the last good value if GitHub is slow.
  const githubRepo =
    config.githubRepo ??
    (process.env.GITHUB_REPO || 'gceico/claude-make-it-rain');

  const staticDir = config.staticDir ?? resolveStaticDir();

  // ── Stars cache (per app instance) ─────────────────────────────────────────
  const starsCache: { stars: number | null; fetchedAt: number } = {
    stars: null,
    fetchedAt: 0,
  };
  let starsInFlight: Promise<number | null> | null = null;

  async function fetchStarCount(): Promise<number | null> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STARS_FETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(`https://api.github.com/repos/${githubRepo}`, {
        headers: {
          accept: 'application/vnd.github+json',
          'user-agent': 'make-it-rain-leaderboard',
        },
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error(`github status ${resp.status}`);
      const data = (await resp.json()) as { stargazers_count?: unknown };
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

  // Returns the cached count immediately when fresh; otherwise refreshes
  // (de-duping concurrent refreshes) and never rejects.
  function getStarCount(): Promise<number | null> | number {
    const fresh = Date.now() - starsCache.fetchedAt < STARS_TTL_MS;
    if (fresh && starsCache.stars !== null) return starsCache.stars;
    if (!starsInFlight) {
      starsInFlight = fetchStarCount().finally(() => {
        starsInFlight = null;
      });
    }
    return starsInFlight;
  }

  // ── Rate limiting (per app instance) ───────────────────────────────────────
  const rateBuckets = new Map<string, RateBucket>();

  function checkRateLimit(ip: string, now: number = Date.now()): RateResult {
    let bucket = rateBuckets.get(ip);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + rateLimitWindowMs };
      rateBuckets.set(ip, bucket);
    }
    bucket.count += 1;
    if (bucket.count > rateLimitMax) {
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
      };
    }
    return { allowed: true };
  }

  // Memory safety: sweep entries whose window has fully expired. `.unref()` keeps
  // this timer from holding the event loop open (so tests/CLI exit cleanly).
  const rateSweeper = setInterval(() => {
    const now = Date.now();
    for (const [ip, bucket] of rateBuckets) {
      if (now >= bucket.resetAt) rateBuckets.delete(ip);
    }
  }, rateLimitWindowMs);
  rateSweeper.unref();

  async function handleReport(req: Request): Promise<Response> {
    let raw: string;
    try {
      const buf = await req.arrayBuffer();
      if (buf.byteLength > MAX_BODY_BYTES) {
        return jsonResponse(413, { ok: false, error: 'body_too_large' });
      }
      raw = new TextDecoder().decode(buf);
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid_json' });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      return jsonResponse(400, { ok: false, error: 'invalid_json' });
    }

    const obj: Record<string, unknown> =
      payload && typeof payload === 'object'
        ? (payload as Record<string, unknown>)
        : {};

    const tag = sanitizeTag(obj.tag);
    const totalRaw = obj.total;
    if (!tag) return jsonResponse(400, { ok: false, error: 'invalid_tag' });
    if (
      typeof totalRaw !== 'number' ||
      !isFinite(totalRaw) ||
      totalRaw < 0 ||
      totalRaw > maxTotal
    ) {
      return jsonResponse(400, { ok: false, error: 'invalid_total' });
    }
    const total = Math.round(totalRaw * 100) / 100;

    const stored = db.report(tag, total);
    return jsonResponse(200, { ok: true, total: stored });
  }

  async function fetchHandler(
    req: Request,
    server: RequestIpServer
  ): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    if (req.method === 'OPTIONS') {
      return jsonResponse(204, {});
    }

    if (req.method === 'POST' && pathname === '/api/report') {
      const limit = checkRateLimit(clientIp(req, server));
      if (!limit.allowed) {
        return jsonResponse(
          429,
          { ok: false, error: 'rate_limited' },
          { 'retry-after': String(limit.retryAfterSec) }
        );
      }
      return handleReport(req);
    }
    if (req.method === 'GET' && pathname === '/api/leaderboard') {
      return jsonResponse(200, {
        date: LeaderboardDB.today(),
        entries: db.leaderboard(),
      });
    }
    if (req.method === 'GET' && pathname === '/api/stars') {
      const stars = await getStarCount();
      return jsonResponse(200, { stars });
    }
    if (req.method === 'GET' && pathname === '/health') {
      return jsonResponse(200, { ok: true });
    }
    if (req.method === 'GET') {
      return serveStatic(staticDir, pathname);
    }

    return jsonResponse(404, { ok: false, error: 'not_found' });
  }

  return {
    db,
    fetch: fetchHandler,
    dispose() {
      clearInterval(rateSweeper);
    },
  };
}

export interface RunningServer {
  server: ReturnType<typeof Bun.serve>;
  db: LeaderboardDB;
  app: App;
  stop(): void;
}

/** Build the app and start a Bun.serve listener. */
export function serve(
  config: AppConfig & { port?: number; hostname?: string } = {}
): RunningServer {
  const app = createApp(config);
  const server = Bun.serve({
    port: config.port ?? (Number(process.env.PORT) || DEFAULT_PORT),
    hostname: config.hostname,
    // Bound so oversized bodies never buffer without limit; the 4KB app guard
    // (returning 413 body_too_large) handles anything under this.
    maxRequestBodySize: 1024 * 1024,
    fetch: app.fetch,
  });
  return {
    server,
    db: app.db,
    app,
    stop() {
      app.dispose();
      server.stop(true);
    },
  };
}

// Boot only when run directly (`bun index.ts`), not when imported by tests.
if (import.meta.main) {
  const { server } = serve();
  console.log(
    `Make It Rain leaderboard server listening on ${server.url.href}`
  );
}
