'use strict';

const fs = require('fs');
const path = require('path');

/**
 * Tiny zero-dependency JSON-file store for the daily leaderboard.
 *
 * Shape on disk:
 *   { "days": { "2026-07-09": { "TurboLlama7392": 12.34, ... }, ... } }
 *
 * We keep the MAX total ever reported by a tag on a given day (the day's spend
 * is cumulative, so max == the latest complete figure and is robust to a client
 * that momentarily reports a lower number). Only anonymized tags + totals are
 * stored — no IPs, timestamps-per-user, or any other identifying data.
 */
class LeaderboardDB {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = { days: {} };
    this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') {
        this.data = parsed;
      }
    } catch {
      this.data = { days: {} };
    }
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(this.data));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      // Persistence is best-effort; keep serving from memory if disk fails.
      console.warn('leaderboard-db: save failed:', err.message);
    }
  }

  /** UTC calendar day, e.g. "2026-07-09". */
  static today(now = new Date()) {
    return now.toISOString().slice(0, 10);
  }

  /** Record a report; keeps the max total for (day, tag). */
  report(tag, total, day = LeaderboardDB.today()) {
    if (!this.data.days[day]) this.data.days[day] = {};
    const bucket = this.data.days[day];
    const prev = typeof bucket[tag] === 'number' ? bucket[tag] : 0;
    bucket[tag] = Math.max(prev, total);
    this._pruneOldDays(day);
    this._save();
    return bucket[tag];
  }

  /** Today's leaderboard, sorted high-to-low, capped at `limit`. */
  leaderboard(day = LeaderboardDB.today(), limit = 100) {
    const bucket = this.data.days[day] || {};
    return Object.entries(bucket)
      .map(([tag, total]) => ({ tag, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  /** Drop days other than today + yesterday so the file can't grow forever. */
  _pruneOldDays(today) {
    const keep = new Set([today, LeaderboardDB.today(new Date(Date.parse(today + 'T00:00:00Z') - 86400000))]);
    for (const day of Object.keys(this.data.days)) {
      if (!keep.has(day)) delete this.data.days[day];
    }
  }
}

module.exports = { LeaderboardDB };
