'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

/** SHA-256 of a string, hex-encoded. */
function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
}

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

    // Anti-spoofing: a tag can only be reported by whoever first claimed it.
    // On first sight of a tag we mint a random secret, store only its SHA-256
    // hash here, and hand the raw secret back to that client once. Later reports
    // must present the matching secret. This table is deliberately NOT pruned
    // (unlike `leaderboard`): a credential must outlive daily resets and server
    // redeploys, so it lives forever in the persistent DB.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS tag_credentials (' +
        'tag TEXT PRIMARY KEY, ' +
        'secret_hash TEXT NOT NULL, ' +
        'created_day TEXT NOT NULL' +
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
    // NOTE: prune targets `leaderboard` ONLY. Credentials are never pruned.
    this._pruneStmt = this.db.prepare('DELETE FROM leaderboard WHERE day NOT IN (?, ?);');

    // Credential statements. INSERT is a no-op if the tag was already claimed,
    // so the read-back tells us whether we actually won the claim.
    this._claimStmt = this.db.prepare(
      'INSERT INTO tag_credentials (tag, secret_hash, created_day) VALUES (?, ?, ?) ' +
        'ON CONFLICT(tag) DO NOTHING;'
    );
    this._credStmt = this.db.prepare('SELECT secret_hash FROM tag_credentials WHERE tag = ?;');
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

  /**
   * Claim a tag: mint a fresh secret and store its hash the first time a tag is
   * seen. Returns the RAW secret (shown once, never persisted) on success, or
   * `null` if the tag was already claimed by someone else.
   *
   * Race-safe: `INSERT ... ON CONFLICT DO NOTHING` is atomic, and we then read
   * the stored hash back. If it isn't the hash we just tried to write, another
   * writer won the claim first, so we return null.
   */
  claimTag(tag, day = LeaderboardDB.today()) {
    const secret = crypto.randomBytes(24).toString('base64url');
    const hash = sha256hex(secret);
    this._claimStmt.run(tag, hash, day);
    const row = this._credStmt.get(tag);
    if (!row || row.secret_hash !== hash) return null; // someone else claimed it
    return secret;
  }

  /**
   * Verify a presented secret against a tag's stored credential.
   * Returns 'unregistered' when the tag has no credential row, 'valid' when the
   * secret's SHA-256 matches, and 'invalid' otherwise (including missing/empty
   * or non-string secrets). Uses a constant-time compare on the hex digests.
   */
  verifyCredential(tag, secret) {
    const row = this._credStmt.get(tag);
    if (!row) return 'unregistered';
    if (typeof secret !== 'string' || secret.length === 0) return 'invalid';
    const presented = Buffer.from(sha256hex(secret), 'hex');
    const stored = Buffer.from(row.secret_hash, 'hex');
    if (presented.length !== stored.length) return 'invalid';
    return crypto.timingSafeEqual(presented, stored) ? 'valid' : 'invalid';
  }

  /** Drop days other than today + yesterday so the DB can't grow forever. */
  _pruneOldDays(today) {
    const yesterday = LeaderboardDB.today(new Date(Date.parse(today + 'T00:00:00Z') - 86400000));
    this._pruneStmt.run(today, yesterday);
  }

  /**
   * Close the underlying database handle. Frees the file so it can be deleted —
   * matters on Windows, where an open SQLite handle blocks unlinking the file.
   */
  close() {
    this.db.close();
  }
}

module.exports = { LeaderboardDB };
