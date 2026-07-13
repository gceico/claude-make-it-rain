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
 *
 * A second table, `hourly(day, hour, spend)`, powers the collective-spend graph:
 * as each report arrives we add only its POSITIVE increment (new total minus the
 * tag's previously-stored total) to the bucket for the current UTC hour. That
 * keeps the graph honest — `SUM(hourly.spend) == SUM(leaderboard.total)` for a
 * day — while storing only an aggregate curve, never per-user timestamps. This is
 * the awareness centerpiece: it shows WHEN the community spends (working-hour
 * peaks, overnight valleys), not WHO spent the most.
 */

import { Database, type Statement } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface LeaderboardEntry {
  tag: string;
  total: number;
}

/** One bucket of the collective-spend curve: spend recorded during `hour` (UTC). */
export interface HourlyBucket {
  hour: number;
  spend: number;
}

interface TotalRow {
  total: number;
}

interface SpendRow {
  spend: number;
}

interface HourRow {
  hour: number;
  spend: number;
}

const DEFAULT_DB = join(import.meta.dir, 'data', 'leaderboard.db');

export class LeaderboardDB {
  readonly filePath: string;
  private readonly db: Database;
  private readonly reportStmt: Statement;
  private readonly getStmt: Statement;
  private readonly boardStmt: Statement;
  private readonly pruneStmt: Statement;
  private readonly bumpHourStmt: Statement;
  private readonly hourlyStmt: Statement;
  private readonly totalStmt: Statement;
  private readonly countStmt: Statement;
  private readonly pruneHourlyStmt: Statement;

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
    // Aggregate-only collective-spend curve: one row per (day, hour). No tags,
    // no per-user timestamps — just how much the whole community spent in each
    // UTC hour of the day.
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS hourly (' +
        'day TEXT NOT NULL, ' +
        'hour INTEGER NOT NULL, ' +
        'spend REAL NOT NULL, ' +
        'PRIMARY KEY (day, hour)' +
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
    // Alphabetical (A–Z, case-insensitive), NOT by amount: the board is a flat
    // "everyone raining today" list, not a spend ranking. LIMIT is a safety bound.
    this.boardStmt = this.db.query(
      'SELECT tag, total FROM leaderboard WHERE day = ? ORDER BY tag COLLATE NOCASE ASC LIMIT ?;'
    );
    this.pruneStmt = this.db.query(
      'DELETE FROM leaderboard WHERE day NOT IN (?, ?);'
    );
    this.bumpHourStmt = this.db.query(
      'INSERT INTO hourly (day, hour, spend) VALUES (?, ?, ?) ' +
        'ON CONFLICT(day, hour) DO UPDATE SET spend = spend + excluded.spend;'
    );
    this.hourlyStmt = this.db.query(
      'SELECT hour, spend FROM hourly WHERE day = ? ORDER BY hour ASC;'
    );
    this.totalStmt = this.db.query(
      'SELECT COALESCE(SUM(total), 0) AS spend FROM leaderboard WHERE day = ?;'
    );
    this.countStmt = this.db.query(
      'SELECT COUNT(*) AS spend FROM leaderboard WHERE day = ?;'
    );
    this.pruneHourlyStmt = this.db.query(
      'DELETE FROM hourly WHERE day NOT IN (?, ?);'
    );
  }

  /** UTC calendar day, e.g. "2026-07-09". */
  static today(now: Date = new Date()): string {
    return now.toISOString().slice(0, 10);
  }

  /**
   * Record a report; keeps the max total for (day, tag). Returns stored total.
   *
   * The POSITIVE increment over this tag's previously-stored total is added to
   * the current UTC hour's collective bucket, so the hourly curve reflects when
   * spend actually happened. A client that restarts and re-reports a lower (or
   * equal) number contributes a zero delta and never double-counts.
   */
  report(
    tag: string,
    total: number,
    day: string = LeaderboardDB.today(),
    now: Date = new Date()
  ): number {
    const prevRow = this.getStmt.get(day, tag) as TotalRow | null;
    const prev = prevRow ? prevRow.total : 0;
    const delta = total > prev ? total - prev : 0;
    if (delta > 0) {
      this.bumpHourStmt.run(day, now.getUTCHours(), delta);
    }
    this.reportStmt.run(day, tag, total);
    this.pruneOldDays(day);
    const row = this.getStmt.get(day, tag) as TotalRow | null;
    return row ? row.total : total;
  }

  /** Today's contributors, sorted alphabetically (A–Z), capped at `limit`. */
  leaderboard(
    day: string = LeaderboardDB.today(),
    limit = 100
  ): LeaderboardEntry[] {
    return this.boardStmt.all(day, limit) as LeaderboardEntry[];
  }

  /**
   * The collective-spend curve for a day: 24 zero-filled buckets (hour 0..23),
   * so the graph always has a full x-axis even before spend arrives.
   */
  hourlySeries(day: string = LeaderboardDB.today()): HourlyBucket[] {
    const rows = this.hourlyStmt.all(day) as HourRow[];
    const buckets: HourlyBucket[] = [];
    for (let h = 0; h < 24; h++) buckets.push({ hour: h, spend: 0 });
    for (const r of rows) {
      if (r.hour >= 0 && r.hour < 24) buckets[r.hour]!.spend = r.spend;
    }
    return buckets;
  }

  /** Sum of every tag's total for a day (the collective headline figure). */
  collectiveTotal(day: string = LeaderboardDB.today()): number {
    const row = this.totalStmt.get(day) as SpendRow | null;
    return row ? row.spend : 0;
  }

  /** How many distinct tags reported spend on a day. */
  activeTags(day: string = LeaderboardDB.today()): number {
    const row = this.countStmt.get(day) as SpendRow | null;
    return row ? row.spend : 0;
  }

  /** A single tag's stored total for a day, or 0 if it hasn't reported. */
  tagTotal(tag: string, day: string = LeaderboardDB.today()): number {
    const row = this.getStmt.get(day, tag) as TotalRow | null;
    return row ? row.total : 0;
  }

  /** Drop days other than today + yesterday so the DB can't grow forever. */
  private pruneOldDays(today: string): void {
    const yesterday = LeaderboardDB.today(
      new Date(Date.parse(today + 'T00:00:00Z') - 86400000)
    );
    this.pruneStmt.run(today, yesterday);
    this.pruneHourlyStmt.run(today, yesterday);
  }

  /**
   * Close the underlying database handle. Frees the file so it can be deleted —
   * matters on Windows, where an open SQLite handle blocks unlinking the file.
   */
  close(): void {
    this.db.close();
  }
}
