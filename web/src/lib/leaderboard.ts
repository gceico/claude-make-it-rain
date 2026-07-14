/**
 * Make It Rain landing-page client logic.
 *
 * Reframed from a "who spent the most" scoreboard into a collective-awareness
 * page: the headline is the community's combined spend, a graph shows WHEN the
 * world spends through the day (hourly peaks/valleys), and tangible equivalences
 * ("≈ a trip to Greece") make the number mean something. Opening the page with
 * `?tag=<yourTag>` adds a personal reflection panel — your spend, your treats,
 * your share of the collective, and the question the whole app is really asking:
 * was it worth building it?
 *
 * Every API call is same-origin and relative so it works when the backend serves
 * web/dist from its own origin, and all network calls fail silently / degrade
 * gracefully so a missing or slow backend never breaks the page.
 */

import {
  treats,
  bigTicketFraction,
  bigTicketReached,
  localDayIndex,
} from './equivalences';

// ── API contract (mirrors server) ────────────────────────────────────────────
export interface LeaderboardEntry {
  tag: string;
  total: number;
}

export interface LeaderboardData {
  date: string;
  entries: LeaderboardEntry[];
}

export interface HourBucket {
  hour: number;
  spend: number;
}

export interface CollectiveData {
  date: string;
  total: number;
  activeTags: number;
  hours: HourBucket[];
  you?: { tag: string; total: number };
}

export interface StarsData {
  stars: number | null;
}

const reduceMotion =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function money(n: number): string {
  const v = Number(n) || 0;
  return (
    '$' +
    v.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

function esc(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

/* "2026-07-09" (the server's UTC day) -> "July 9, 2026". Parsed as UTC so the
   displayed date never drifts a day in the viewer's local timezone. */
function prettyDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return iso || '';
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return d.toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function byId(id: string): HTMLElement | null {
  return document.getElementById(id);
}

/** The `tag` query param, sanitized to the same charset the server accepts. */
function tagParam(): string {
  try {
    const raw = new URLSearchParams(window.location.search).get('tag') || '';
    return raw.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  } catch {
    return '';
  }
}

// ── Ambient falling money ────────────────────────────────────────────────────
function seedRain(): void {
  if (reduceMotion) return;
  const rain = byId('rain');
  if (!rain) return;
  const glyphs = ['💵', '💸', '💰', '🤑', '💴'];
  const N = window.innerWidth < 560 ? 9 : 15;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < N; i++) {
    const b = document.createElement('span');
    b.className = 'bill';
    b.textContent = glyphs[i % glyphs.length];
    const depth = Math.random(); // 0 = far/small/faint, 1 = near
    b.style.left = Math.random() * 100 + 'vw';
    b.style.fontSize = (14 + depth * 30).toFixed(0) + 'px';
    b.style.setProperty('--o', (0.1 + depth * 0.28).toFixed(2));
    b.style.setProperty(
      '--drift',
      (-40 + Math.random() * 80).toFixed(0) + 'px'
    );
    b.style.setProperty(
      '--spin',
      (120 + Math.random() * 240).toFixed(0) + 'deg'
    );
    if (depth < 0.45) b.style.filter = 'blur(1px)';
    const dur = 15 - depth * 6 + Math.random() * 6; // nearer = a touch faster
    b.style.animationDuration = dur.toFixed(1) + 's';
    b.style.animationDelay = (-Math.random() * dur).toFixed(1) + 's';
    frag.appendChild(b);
  }
  rain.appendChild(frag);
}

// ── GitHub stars (fetched server-side, same-origin) ──────────────────────────
function loadStars(): void {
  fetch('/api/stars')
    .then((r) => (r.ok ? (r.json() as Promise<StarsData>) : null))
    .then((d) => {
      const count = byId('starCount');
      if (!count) return;
      if (!d || typeof d.stars !== 'number') return; // leave pill as plain "Star"
      const num = byId('starNum');
      if (num) num.textContent = d.stars.toLocaleString('en-US');
      count.classList.remove('pending');
    })
    .catch(() => {
      /* fail silently, the pill still links to the repo */
    });
}

// ── Collective spend: headline + curve + personal reflection ─────────────────
function pad2(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

/** Build the collective-spend curve as inline SVG (no deps; CSP-safe). */
function buildChart(hours: HourBucket[]): string {
  const W = 700;
  const H = 190;
  const padX = 10;
  const padTop = 16;
  const padBottom = 26;
  const n = hours.length; // 24
  const max = Math.max(1, ...hours.map((h) => h.spend));
  const x = (i: number) => padX + (i / (n - 1)) * (W - 2 * padX);
  const y = (v: number) => H - padBottom - (v / max) * (H - padTop - padBottom);

  const pts = hours.map((h, i) => [x(i), y(h.spend)] as const);
  const line = pts
    .map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1))
    .join(' ');
  const area =
    `M${x(0).toFixed(1)} ${(H - padBottom).toFixed(1)} ` +
    pts.map((p) => `L${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') +
    ` L${x(n - 1).toFixed(1)} ${(H - padBottom).toFixed(1)} Z`;

  // Mark the current UTC hour so "now" is legible on the curve.
  const nowHour = Math.min(23, Math.max(0, new Date().getUTCHours()));
  const nowPt = pts[nowHour]!;

  // A few hour ticks along the bottom (0, 6, 12, 18h UTC).
  const ticks = [0, 6, 12, 18, 23]
    .map(
      (h) =>
        `<text class="c-tick" x="${x(h).toFixed(1)}" y="${H - 8}">${pad2(
          h
        )}h</text>`
    )
    .join('');

  return (
    `<svg class="c-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" ` +
    `role="img" aria-label="Collective spend by UTC hour">` +
    `<defs><linearGradient id="cGrad" x1="0" y1="0" x2="0" y2="1">` +
    `<stop offset="0" stop-color="var(--accent)" stop-opacity="0.34"/>` +
    `<stop offset="1" stop-color="var(--accent)" stop-opacity="0"/>` +
    `</linearGradient></defs>` +
    `<path class="c-area" d="${area}" fill="url(#cGrad)"/>` +
    `<path class="c-line" d="${line}" fill="none"/>` +
    `<circle class="c-now" cx="${nowPt[0].toFixed(1)}" cy="${nowPt[1].toFixed(
      1
    )}" r="4.5"/>` +
    ticks +
    `</svg>`
  );
}

/** Human summary of the curve, e.g. "Busiest around 15:00 UTC". */
function peakSummary(hours: HourBucket[]): string {
  let peak = -1;
  let peakSpend = 0;
  for (const h of hours) {
    if (h.spend > peakSpend) {
      peakSpend = h.spend;
      peak = h.hour;
    }
  }
  if (peak < 0 || peakSpend <= 0) return 'Quiet so far today.';
  return `Busiest around ${pad2(peak)}:00 UTC.`;
}

function renderCollective(data: CollectiveData): void {
  const dateEl = byId('date');
  if (dateEl) dateEl.textContent = prettyDate(data.date);

  const total =
    typeof data.total === 'number' && isFinite(data.total) ? data.total : 0;
  const count = typeof data.activeTags === 'number' ? data.activeTags : 0;

  // Headline: the community's combined spend today (not a single top spender).
  const tallyAmt = byId('tallyAmt');
  if (tallyAmt) tallyAmt.textContent = money(total);
  const tallyCount = byId('tallyCount');
  if (tallyCount) tallyCount.textContent = count.toLocaleString('en-US');
  const tallyNoun = byId('tallyNoun');
  if (tallyNoun) tallyNoun.textContent = count === 1 ? 'builder' : 'builders';
  byId('tally')?.classList.add('show');

  const eqEl = byId('collectiveEq');
  if (eqEl) {
    const big = bigTicketReached(total, localDayIndex());
    eqEl.textContent = big ? `Together, that's ≈ ${big.text} ${big.emoji}` : '';
  }

  // Graph.
  const graph = byId('graph');
  const body = byId('graphBody');
  const sub = byId('graphSub');
  if (graph && body) {
    const hours = Array.isArray(data.hours) ? data.hours : [];
    if (total > 0 && hours.length) {
      body.innerHTML = buildChart(hours);
      if (sub) sub.textContent = peakSummary(hours);
      graph.hidden = false;
    } else {
      graph.hidden = true;
    }
  }

  if (data.you) renderReflection(data.you, total);
}

/** Personal reflection panel, shown only when the page is opened with ?tag=. */
function renderReflection(
  you: { tag: string; total: number },
  collectiveTotal: number
): void {
  const panel = byId('reflect');
  if (!panel) return;
  const yours =
    typeof you.total === 'number' && isFinite(you.total) ? you.total : 0;

  if (yours <= 0) {
    panel.innerHTML =
      '<p class="reflect-tag">' +
      esc(you.tag) +
      '</p>' +
      '<p class="reflect-none">No spend logged under this tag today. ' +
      'Nothing to answer for — yet. ☔️</p>';
    panel.hidden = false;
    return;
  }

  const day = localDayIndex();
  const treat = treats(yours, day);
  const slice = bigTicketFraction(yours, day);
  const share =
    collectiveTotal > 0
      ? Math.max(0.1, Math.round((yours / collectiveTotal) * 1000) / 10)
      : 0;

  const lines: string[] = [];
  lines.push('<p class="reflect-eyebrow">your day, ' + esc(you.tag) + '</p>');
  lines.push('<p class="reflect-amt">' + money(yours) + '</p>');
  const items: string[] = [];
  if (treat) {
    items.push(
      '<li><span class="re-emoji">' +
        treat.emoji +
        "</span> that's about <b>" +
        esc(treat.text) +
        '</b> — gone</li>'
    );
  }
  if (slice) {
    items.push(
      '<li><span class="re-emoji">' +
        slice.emoji +
        '</span> ≈ <b>' +
        esc(slice.text) +
        '</b></li>'
    );
  }
  if (share > 0) {
    items.push(
      '<li><span class="re-emoji">🌧️</span> <b>' +
        share +
        '%</b> of everything the community spent today</li>'
    );
  }
  lines.push('<ul class="reflect-list">' + items.join('') + '</ul>');
  lines.push('<p class="reflect-kicker">Was it worth building it?</p>');

  panel.innerHTML = lines.join('');
  panel.hidden = false;
  if (!reduceMotion) panel.classList.add('reveal');
}

function loadCollective(): void {
  const tag = tagParam();
  const url = tag
    ? '/api/collective?tag=' + encodeURIComponent(tag)
    : '/api/collective';
  fetch(url)
    .then((r) => {
      if (!r.ok) throw new Error('bad status');
      return r.json() as Promise<CollectiveData>;
    })
    .then(renderCollective)
    .catch(() => {
      /* fail silently — the board + rain still render */
    });
}

// ── Contributor list ("everyone raining today", not a podium) ─────────────────
function rowHTML(e: LeaderboardEntry): string {
  return (
    '<div class="row">' +
    '<div class="tag">' +
    esc(e.tag) +
    '</div>' +
    '<div class="amt">' +
    money(e.total) +
    '</div>' +
    '</div>'
  );
}

function renderBoard(data: LeaderboardData): void {
  const board = byId('board');
  if (!board) return;
  board.classList.remove('skel');
  board.removeAttribute('aria-busy');

  const entries = (data.entries || []).filter(
    (e): e is LeaderboardEntry =>
      !!e && typeof e.total === 'number' && isFinite(e.total)
  );

  const heading = byId('boardHeading');
  if (!entries.length) {
    if (heading) heading.hidden = true;
    board.innerHTML =
      '<div class="state">' +
      '<span class="big">☔️</span>' +
      '<span class="lead">No one is raining yet today.</span><br>' +
      'Fire up Claude Code and start the drizzle.' +
      '</div>';
    return;
  }

  if (heading) heading.hidden = false;
  board.innerHTML = entries.map(rowHTML).join('');

  if (!reduceMotion) {
    const rows = board.querySelectorAll<HTMLElement>('.row');
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.add('reveal');
      rows[i].style.animationDelay = Math.min(i * 55, 700) + 'ms';
    }
  }
}

function showBoardError(): void {
  const board = byId('board');
  if (!board) return;
  board.classList.remove('skel');
  board.removeAttribute('aria-busy');
  const heading = byId('boardHeading');
  if (heading) heading.hidden = true;
  board.innerHTML =
    '<div class="state">' +
    '<span class="big">🌥️</span>' +
    '<span class="lead">Couldn\'t load the board.</span><br>' +
    'Give it a moment and refresh.' +
    '</div>';
}

function loadBoard(): void {
  fetch('/api/leaderboard')
    .then((r) => {
      if (!r.ok) throw new Error('bad status');
      return r.json() as Promise<LeaderboardData>;
    })
    .then(renderBoard)
    .catch(showBoardError);
}

// ── Countdown to the daily reset (next UTC midnight) ─────────────────────────
function pad(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

// Seeded eagerly so the first tick doesn't spuriously re-fetch.
let lastUtcDay = new Date().toISOString().slice(0, 10);

function tickCountdown(): void {
  const now = new Date();
  const next = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0
  );
  const ms = next - now.getTime();
  // next is always strictly after now, so ms stays positive; detect the UTC-day
  // rollover by comparing the calendar day rather than waiting for ms to reach 0.
  const day = now.toISOString().slice(0, 10);
  if (day !== lastUtcDay) {
    lastUtcDay = day;
    loadCollective();
    loadBoard();
  }
  const s = Math.floor(ms / 1000);
  const el = byId('countdown');
  if (el)
    el.textContent =
      pad(Math.floor(s / 3600)) +
      ':' +
      pad(Math.floor(s / 60) % 60) +
      ':' +
      pad(s % 60);
}

export function init(): void {
  seedRain();
  loadStars();
  loadCollective();
  loadBoard();
  tickCountdown();
  setInterval(tickCountdown, 1000);
}
