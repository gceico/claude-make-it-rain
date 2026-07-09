'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { costForEntry } = require('./pricing');
const { parseUsageEntry } = require('./entry-parser');

/**
 * Retroactive spend history built directly from the ~/.claude/projects/**\/*.jsonl
 * session logs — no local database. Because the logs already exist, users see
 * spend from before they installed the app.
 *
 * Scans are lazy and async so they never block the tray. Scanning a month of
 * logs is not cheap, so the History class pays that price at most once per
 * local day: completed days are immutable and get cached in a "ledger", and
 * refreshes only re-read files touched today.
 */

/** The selectable ranges, in menu order. */
const RANGES = [
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: 'last7days', label: 'Last 7 days' },
  { id: 'last30days', label: 'Last 30 days' },
  { id: 'thisMonth', label: 'This month' },
];

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

/** Local `YYYY-MM-DD` calendar-day key for grouping. */
function dayKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Half-open [start, end) window for a range id, computed against local time.
 * `end` is exclusive; ranges that include today end at the start of tomorrow.
 */
function rangeFor(id, now = new Date()) {
  const today = startOfDay(now);
  const tomorrow = addDays(today, 1);
  switch (id) {
    case 'today':
      return { start: today, end: tomorrow };
    case 'yesterday':
      return { start: addDays(today, -1), end: today };
    case 'last7days':
      return { start: addDays(today, -6), end: tomorrow };
    case 'last30days':
      return { start: addDays(today, -29), end: tomorrow };
    case 'thisMonth': {
      const s = new Date(today);
      s.setDate(1);
      return { start: s, end: tomorrow };
    }
    default:
      throw new Error('unknown range: ' + id);
  }
}

/** Number of $100 "rain bills" a dollar amount represents. */
function billCount(costUSD) {
  return Math.max(0, Math.floor(costUSD / 100));
}

/** All *.jsonl under projectsDir/<project>/ last modified at/after `since`.
 * A file whose mtime predates the window cannot contain in-window entries, so
 * skipping it is a safe optimization; per-entry timestamps still gate results. */
async function discoverFiles(projectsDir, since) {
  let projectDirs;
  try {
    projectDirs = await fs.promises.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const sinceMs = since.getTime();
  const result = [];
  for (const dirent of projectDirs) {
    if (!dirent.isDirectory() || dirent.name.startsWith('.')) continue;
    const projectDir = path.join(projectsDir, dirent.name);
    let files;
    try {
      files = await fs.promises.readdir(projectDir);
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith('.jsonl')) continue;
      const filePath = path.join(projectDir, name);
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        continue;
      }
      if (stat.mtimeMs >= sinceMs) result.push(filePath);
    }
  }
  return result;
}

/**
 * Core scan: read every candidate file (mtime >= startMs) fully, keep entries
 * whose own timestamp falls in the half-open [startMs, endMs) window, dedup by
 * requestId:messageId across ALL files (a session that spans several files
 * must not double-count), and group cost by local calendar day.
 *
 * `baseSeen` is an optional read-only set of dedup keys already counted by a
 * previous scan; entries with those keys are skipped (used so the incremental
 * "today" scan never recounts entries that a resumed session rewrote into a
 * freshly-touched file).
 *
 * @returns {Promise<{days: Map<string,{costUSD:number,entryCount:number}>,
 *                    seenKeys: Set<string>, totalCostUSD: number, entryCount: number}>}
 */
async function scanWindow({ projectsDir, startMs, endMs, baseSeen = null }) {
  const files = await discoverFiles(projectsDir, new Date(startMs));
  const seen = new Set();
  const days = new Map(); // dayKey -> { costUSD, entryCount }
  let totalCostUSD = 0;
  let entryCount = 0;

  for (const file of files) {
    let content;
    try {
      content = await fs.promises.readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split('\n')) {
      if (!line) continue;
      const parsed = parseUsageEntry(line);
      if (!parsed) continue;

      const t = parsed.timestamp.getTime();
      if (t < startMs || t >= endMs) continue;

      if (baseSeen && baseSeen.has(parsed.key)) continue;
      if (seen.has(parsed.key)) continue;
      seen.add(parsed.key);

      const cost = costForEntry(parsed.usage, parsed.model);
      const key = dayKey(parsed.timestamp);
      const bucket = days.get(key) || { costUSD: 0, entryCount: 0 };
      bucket.costUSD += cost;
      bucket.entryCount += 1;
      days.set(key, bucket);

      totalCostUSD += cost;
      entryCount += 1;
    }
  }

  return { days, seenKeys: seen, totalCostUSD, entryCount };
}

/** Formats a dayKey->bucket map as a result's sorted `days` array. */
function daysArray(dayMap) {
  return [...dayMap.entries()]
    .map(([date, v]) => ({ date, costUSD: v.costUSD, entryCount: v.entryCount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * One-shot full scan of a range (no caching). Kept as the plain reference
 * implementation; the History class below produces the same result shape but
 * reuses an immutable past-days ledger so repeat calls only re-read today's
 * files.
 *
 * @returns {Promise<{
 *   rangeId: string, start: Date, end: Date,
 *   totalCostUSD: number, entryCount: number,
 *   days: Array<{date: string, costUSD: number, entryCount: number}>
 * }>} `days` is sorted ascending by date.
 */
async function scanRange({ projectsDir, rangeId, now = new Date() }) {
  const range = rangeFor(rangeId, now);
  const { days, totalCostUSD, entryCount } = await scanWindow({
    projectsDir,
    startMs: range.start.getTime(),
    endMs: range.end.getTime(),
  });
  return {
    rangeId,
    start: range.start,
    end: range.end,
    totalCostUSD,
    entryCount,
    days: daysArray(days),
  };
}

/**
 * Range results with near-zero steady-state cost.
 *
 * Days before today are immutable — the logs only ever gain entries with new
 * timestamps, so a past calendar day's total never changes once that day is
 * over. History exploits that with a two-tier scan:
 *
 *  - A "ledger" covering [earliest range start, start of today) is built once
 *    and reused until local midnight rolls the day over. This is the only
 *    expensive scan.
 *  - Only "today" is rescanned on refresh (files with mtime >= start of
 *    today), deduped against the ledger's seen keys so entries a resumed
 *    session rewrote into a freshly-touched file are not double-counted, and
 *    cached for `cacheTtlMs`. `force` bypasses the today cache but never
 *    rebuilds the ledger.
 *
 * Assembled per-range results are additionally cached for `cacheTtlMs` so
 * concurrent menu rebuilds share one in-flight promise.
 */
class History {
  constructor({ projectsDir, cacheTtlMs = 60_000 } = {}) {
    this.projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    this.cacheTtlMs = cacheTtlMs;
    this._cache = new Map(); // rangeId -> { at, dayStartMs, promise }
    this._ledger = null;     // { promise, dayStartMs, startMs }
    this._today = null;      // { promise, at, dayStartMs }
  }

  /** Earliest window start any selectable range can ask for. */
  _earliestStartMs(now) {
    let min = Infinity;
    for (const r of RANGES) {
      min = Math.min(min, rangeFor(r.id, now).start.getTime());
    }
    return min;
  }

  /** Immutable past-days scan: [earliest range start, start of today). */
  _getLedger(now) {
    const dayStartMs = startOfDay(now).getTime();
    const startMs = this._earliestStartMs(now);
    const l = this._ledger;
    if (l && l.dayStartMs === dayStartMs && l.startMs <= startMs) return l.promise;

    const promise = scanWindow({
      projectsDir: this.projectsDir,
      startMs,
      endMs: dayStartMs,
    }).catch((err) => {
      // Don't cache failures.
      if (this._ledger && this._ledger.promise === promise) this._ledger = null;
      throw err;
    });
    this._ledger = { promise, dayStartMs, startMs };
    return promise;
  }

  /** Today-only scan (cheap): files touched today, deduped against the ledger.
   *  A still-running scan is reused even under `force` — it is as fresh as one
   *  started now, and this keeps a forced refresh of all five ranges (or rapid
   *  menu clicks) down to a single scan. */
  _getToday(now, force) {
    const dayStartMs = startOfDay(now).getTime();
    const t = this._today;
    if (t && t.dayStartMs === dayStartMs) {
      const fresh = Date.now() - t.at < this.cacheTtlMs;
      if (!t.settled || (!force && fresh)) return t.promise;
    }

    const entry = { at: Date.now(), dayStartMs, settled: false };
    entry.promise = this._getLedger(now)
      .then((ledger) =>
        scanWindow({
          projectsDir: this.projectsDir,
          startMs: dayStartMs,
          endMs: addDays(new Date(dayStartMs), 1).getTime(),
          baseSeen: ledger.seenKeys,
        })
      )
      .catch((err) => {
        // Don't cache failures.
        if (this._today === entry) this._today = null;
        throw err;
      });
    entry.promise.then(
      () => { entry.settled = true; },
      () => { entry.settled = true; }
    );
    this._today = entry;
    return entry.promise;
  }

  /** Ledger days ∩ range window, merged with a fresh today scan. */
  async _assemble(rangeId, now, force) {
    const range = rangeFor(rangeId, now);
    const dayStartMs = startOfDay(now).getTime();
    const dayMap = new Map();
    let totalCostUSD = 0;
    let entryCount = 0;

    if (range.start.getTime() < dayStartMs) {
      const ledger = await this._getLedger(now);
      const startKey = dayKey(range.start);
      for (const [key, bucket] of ledger.days) {
        if (key < startKey) continue; // the ledger only holds days before today
        dayMap.set(key, { ...bucket });
        totalCostUSD += bucket.costUSD;
        entryCount += bucket.entryCount;
      }
    }

    if (range.end.getTime() > dayStartMs) {
      const today = await this._getToday(now, force);
      for (const [key, bucket] of today.days) {
        dayMap.set(key, { ...bucket });
        totalCostUSD += bucket.costUSD;
        entryCount += bucket.entryCount;
      }
    }

    return {
      rangeId,
      start: range.start,
      end: range.end,
      totalCostUSD,
      entryCount,
      days: daysArray(dayMap),
    };
  }

  /** Returns a Promise for the range result, using a fresh cache entry if any.
   *  Pass `force` to rescan today's files; past days stay cached (they are
   *  immutable), so even a forced refresh is cheap. */
  get(rangeId, { force = false, now = new Date() } = {}) {
    const dayStartMs = startOfDay(now).getTime();
    const cached = this._cache.get(rangeId);
    if (
      !force &&
      cached &&
      cached.dayStartMs === dayStartMs &&
      Date.now() - cached.at < this.cacheTtlMs
    ) {
      return cached.promise;
    }
    const promise = this._assemble(rangeId, now, force).catch((err) => {
      // Don't cache failures.
      this._cache.delete(rangeId);
      throw err;
    });
    this._cache.set(rangeId, { at: Date.now(), dayStartMs, promise });
    return promise;
  }

  /** Drops the per-range result caches (and, with no args, the ledger too). */
  invalidate(rangeId) {
    if (rangeId) {
      this._cache.delete(rangeId);
    } else {
      this._cache.clear();
      this._ledger = null;
      this._today = null;
    }
  }
}

module.exports = {
  RANGES,
  History,
  scanRange,
  rangeFor,
  dayKey,
  billCount,
  startOfDay,
  addDays,
};
