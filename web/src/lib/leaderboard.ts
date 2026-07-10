/**
 * Make It Rain — client-side leaderboard/stars/rain logic.
 *
 * Typed port of the original single-file inline script. Runs in the browser on
 * the statically-built page; every API call is same-origin and relative so it
 * works when the backend serves web/dist from its own origin. All network calls
 * fail silently / degrade gracefully so the page is never broken by a missing
 * or slow backend.
 */

// ── API contract (mirrors server: GET /api/leaderboard, /api/stars) ──────────
export interface LeaderboardEntry {
  tag: string;
  total: number;
}

export interface LeaderboardData {
  date: string;
  entries: LeaderboardEntry[];
}

export interface StarsData {
  stars: number | null;
}

const medals = ['🥇', '🥈', '🥉'] as const;
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
      /* fail silently — the pill still links to the repo */
    });
}

// ── Board ────────────────────────────────────────────────────────────────────
function rowHTML(e: LeaderboardEntry, i: number): string {
  const cls =
    'row' + (i === 0 ? ' champ' : i === 1 ? ' top2' : i === 2 ? ' top3' : '');
  const rank =
    i < 3 ? '<span class="medal">' + medals[i] + '</span>' : String(i + 1);
  return (
    '<div class="' +
    cls +
    '">' +
    '<div class="rank">' +
    rank +
    '</div>' +
    '<div class="tag">' +
    esc(e.tag) +
    '</div>' +
    '<div class="amt">' +
    money(e.total) +
    '</div>' +
    '</div>'
  );
}

function render(data: LeaderboardData): void {
  const dateEl = byId('date');
  if (dateEl) dateEl.textContent = prettyDate(data.date);
  const board = byId('board');
  if (!board) return;
  board.classList.remove('skel');
  board.removeAttribute('aria-busy');

  const entries = (data.entries || []).filter(
    (e): e is LeaderboardEntry =>
      !!e && typeof e.total === 'number' && isFinite(e.total)
  );

  if (!entries.length) {
    board.innerHTML =
      '<div class="state">' +
      '<span class="big">☔️</span>' +
      '<span class="lead">Nobody has made it rain yet today.</span><br>' +
      'Fire up Claude Code and be the first on the board.' +
      '</div>';
    return;
  }

  // Headline: today's combined spend across everyone on the board.
  const total = entries.reduce((s, e) => s + e.total, 0);
  const tallyAmt = byId('tallyAmt');
  if (tallyAmt) tallyAmt.textContent = money(total);
  const tallyCount = byId('tallyCount');
  if (tallyCount)
    tallyCount.textContent = entries.length.toLocaleString('en-US');
  const tallyNoun = byId('tallyNoun');
  if (tallyNoun)
    tallyNoun.textContent = entries.length === 1 ? 'spender' : 'spenders';
  byId('tally')?.classList.add('show');

  board.innerHTML = entries.map(rowHTML).join('');

  if (!reduceMotion) {
    const rows = board.querySelectorAll<HTMLElement>('.row');
    for (let i = 0; i < rows.length; i++) {
      rows[i].classList.add('reveal');
      rows[i].style.animationDelay = Math.min(i * 55, 700) + 'ms';
    }
  }
}

function showError(): void {
  const board = byId('board');
  if (!board) return;
  board.classList.remove('skel');
  board.removeAttribute('aria-busy');
  board.innerHTML =
    '<div class="state">' +
    '<span class="big">🌥️</span>' +
    '<span class="lead">Couldn\'t load the leaderboard.</span><br>' +
    'Give it a moment and refresh.' +
    '</div>';
}

function loadBoard(): void {
  fetch('/api/leaderboard')
    .then((r) => {
      if (!r.ok) throw new Error('bad status');
      return r.json() as Promise<LeaderboardData>;
    })
    .then(render)
    .catch(showError);
}

// ── Countdown to the daily reset (next UTC midnight) ─────────────────────────
function pad(n: number): string {
  return (n < 10 ? '0' : '') + n;
}

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
  let ms = next - now.getTime();
  if (ms <= 0) {
    loadBoard();
    ms = 0;
  } // rolled past midnight — refresh the board
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
  loadBoard();
  tickCountdown();
  setInterval(tickCountdown, 1000);
}
