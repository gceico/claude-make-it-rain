/**
 * Make It Rain — cloud daily-leaderboard SQLite store (Bun + TypeScript).
 *
 * Tiny zero-dependency SQLite store for the daily leaderboard, backed by Bun's
 * built-in `bun:sqlite` module (no npm dependencies). The on-disk file is a
 * standard SQLite3 database, so a file previously written by Node's `node:sqlite`
 * (e.g. the production DB at /data/leaderboard.db) opens and keeps working here
 * unchanged: same tables, columns, and WAL journal mode.
 *
 * Schema: one row per (day, tag) with a numeric total. We keep the MAX total
 * ever reported by a tag on a given day (the day's spend is cumulative, so max
 * == the latest complete figure and is robust to a client that momentarily
 * reports a lower number). Only anonymized tags + totals are stored — no IPs,
 * timestamps-per-user, or any other identifying data.
 */

import { Database, type Statement } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LeaderboardEntry {
  tag: string;
  total: number;
}

interface TotalRow {
  total: number;
}

const DEFAULT_DB = join(import.meta.dir, 'data', 'leaderboard.db');

export class LeaderboardDB {
  readonly filePath: string;
  private readonly db: Database;
  private readonly reportStmt: Statement;
  private readonly getStmt: Statement;
  private readonly boardStmt: Statement;
  private readonly pruneStmt: Statement;

  constructor(filePath?: string) {
    this.filePath = filePath || process.env.LEADERBOARD_DB || DEFAULT_DB;
    mkdirSync(dirname(this.filePath), { recursive: true });

    this.db = new Database(this.filePath, { create: true });
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
    this.reportStmt = this.db.query(
      'INSERT INTO leaderboard (day, tag, total) VALUES (?, ?, ?) ' +
        'ON CONFLICT(day, tag) DO UPDATE SET total = MAX(total, excluded.total);'
    );
    this.getStmt = this.db.query(
      'SELECT total FROM leaderboard WHERE day = ? AND tag = ?;'
    );
    this.boardStmt = this.db.query(
      'SELECT tag, total FROM leaderboard WHERE day = ? ORDER BY total DESC LIMIT ?;'
    );
    this.pruneStmt = this.db.query(
      'DELETE FROM leaderboard WHERE day NOT IN (?, ?);'
    );
  }

  /** UTC calendar day, e.g. "2026-07-09". */
  static today(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /** Record a report; keeps the max total for (day, tag). Returns stored total. */
  report(
    tag: string,
    total: number,
    day: string = LeaderboardDB.today()
  ): number {
    this.reportStmt.run(day, tag, total);
    this.pruneOldDays(day);
    const row = this.getStmt.get(day, tag) as TotalRow | null;
    return row ? row.total : total;
  }

  /** Today's leaderboard, sorted high-to-low, capped at `limit`. */
  leaderboard(
    day: string = LeaderboardDB.today(),
    limit = 100
  ): LeaderboardEntry[] {
    const rows = this.boardStmt.all(day, limit) as LeaderboardEntry[];
    return rows.map((r) => ({ tag: r.tag, total: r.total }));
  }

  /** Drop days other than today + yesterday so the DB can't grow forever. */
  private pruneOldDays(today: string): void {
    const yesterday = LeaderboardDB.today(
      new Date(Date.parse(today + 'T00:00:00Z') - 86400000)
    );
    this.pruneStmt.run(today, yesterday);
  }

  /**
   * Close the underlying database handle. Frees the file so it can be deleted —
   * matters on Windows, where an open SQLite handle blocks unlinking the file.
   */
  close(): void {
    this.db.close();
  }
}
