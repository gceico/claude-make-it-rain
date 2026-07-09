'use strict';

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

/**
 * Tiny zero-dependency SQLite store for the daily leaderboard, backed by the
 * built-in `node:sqlite` module (no npm dependencies).
 *
 * Schema: one row per (day, tag) with a numeric total. We keep the MAX total
 * ever reported by a tag on a given day (the day's spend is cumulative, so max
 * == the latest complete figure and is robust to a client that momentarily
 * reports a lower number). Only anonymized tags + totals are stored — no IPs,
 * timestamps-per-user, or any other identifying data.
 */
class LeaderboardDB {
  constructor(filePath) {
    this.filePath =
      filePath || process.env.LEADERBOARD_DB || path.join(__dirname, 'data', 'leaderboard.db');
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    this.db = new DatabaseSync(this.filePath);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS leaderboard (' +
        'day TEXT NOT NULL, ' +
        'tag TEXT NOT NULL, ' +
        'total REAL NOT NULL, ' +
        'PRIMARY KEY (day, tag)' +
        ');'
    );

    // Prepared statements only — no string interpolation into SQL.
    this._reportStmt = this.db.prepare(
      'INSERT INTO leaderboard (day, tag, total) VALUES (?, ?, ?) ' +
        'ON CONFLICT(day, tag) DO UPDATE SET total = MAX(total, excluded.total);'
    );
    this._getStmt = this.db.prepare('SELECT total FROM leaderboard WHERE day = ? AND tag = ?;');
    this._boardStmt = this.db.prepare(
      'SELECT tag, total FROM leaderboard WHERE day = ? ORDER BY total DESC LIMIT ?;'
    );
    this._pruneStmt = this.db.prepare('DELETE FROM leaderboard WHERE day NOT IN (?, ?);');
  }

  /** UTC calendar day, e.g. "2026-07-09". */
  static today(now = new Date()) {
    return now.toISOString().slice(0, 10);
  }

  /** Record a report; keeps the max total for (day, tag). Returns stored total. */
  report(tag, total, day = LeaderboardDB.today()) {
    this._reportStmt.run(day, tag, total);
    this._pruneOldDays(day);
    const row = this._getStmt.get(day, tag);
    return row ? row.total : total;
  }

  /** Today's leaderboard, sorted high-to-low, capped at `limit`. */
  leaderboard(day = LeaderboardDB.today(), limit = 100) {
    return this._boardStmt.all(day, limit).map((r) => ({ tag: r.tag, total: r.total }));
  }

  /** Drop days other than today + yesterday so the DB can't grow forever. */
  _pruneOldDays(today) {
    const yesterday = LeaderboardDB.today(new Date(Date.parse(today + 'T00:00:00Z') - 86400000));
    this._pruneStmt.run(today, yesterday);
  }
}

module.exports = { LeaderboardDB };
