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
 * A scan is a one-shot full read of every candidate file (unlike the live
 * monitor which reads incrementally). It is intentionally lazy and async so it
 * never blocks the tray, and results are cached briefly since scanning a month
 * of logs is not cheap.
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
 * Scan the logs for one range and return per-day totals.
 *
 * Entries are deduplicated by requestId:messageId across ALL files in the scan
 * (a session that spans several files must not double-count), filtered to the
 * range window by their own timestamp, and grouped by local calendar day.
 *
 * @returns {Promise<{
 *   rangeId: string, start: Date, end: Date,
 *   totalCostUSD: number, entryCount: number,
 *   days: Array<{date: string, costUSD: number, entryCount: number}>
 * }>} `days` is sorted ascending by date.
 */
async function scanRange({ projectsDir, rangeId, now = new Date() }) {
  const range = rangeFor(rangeId, now);
  const startMs = range.start.getTime();
  const endMs = range.end.getTime();

  const files = await discoverFiles(projectsDir, range.start);
  const seen = new Set();
  const dayMap = new Map(); // dayKey -> { costUSD, entryCount }
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

      if (seen.has(parsed.key)) continue;
      seen.add(parsed.key);

      const cost = costForEntry(parsed.usage, parsed.model);
      const key = dayKey(parsed.timestamp);
      const bucket = dayMap.get(key) || { costUSD: 0, entryCount: 0 };
      bucket.costUSD += cost;
      bucket.entryCount += 1;
      dayMap.set(key, bucket);

      totalCostUSD += cost;
      entryCount += 1;
    }
  }

  const days = [...dayMap.entries()]
    .map(([date, v]) => ({ date, costUSD: v.costUSD, entryCount: v.entryCount }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  return {
    rangeId,
    start: range.start,
    end: range.end,
    totalCostUSD,
    entryCount,
    days,
  };
}

/**
 * Thin cache around scanRange: keeps a result per range id for `cacheTtlMs`
 * (default 60s) and dedupes concurrent scans of the same range by handing back
 * the in-flight promise.
 */
class History {
  constructor({ projectsDir, cacheTtlMs = 60_000 } = {}) {
    this.projectsDir = projectsDir || path.join(os.homedir(), '.claude', 'projects');
    this.cacheTtlMs = cacheTtlMs;
    this._cache = new Map(); // rangeId -> { at: number, promise: Promise }
  }

  /** Returns a Promise for the range result, using a fresh cache entry if any.
   *  Pass `force` to bypass (and refresh) the cache. */
  get(rangeId, { force = false, now = new Date() } = {}) {
    const cached = this._cache.get(rangeId);
    if (!force && cached && Date.now() - cached.at < this.cacheTtlMs) {
      return cached.promise;
    }
    const promise = scanRange({ projectsDir: this.projectsDir, rangeId, now })
      .catch((err) => {
        // Don't cache failures.
        this._cache.delete(rangeId);
        throw err;
      });
    this._cache.set(rangeId, { at: Date.now(), promise });
    return promise;
  }

  invalidate(rangeId) {
    if (rangeId) this._cache.delete(rangeId);
    else this._cache.clear();
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
