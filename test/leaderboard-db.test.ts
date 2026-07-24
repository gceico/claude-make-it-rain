/**
 * Unit tests for the leaderboard SQLite store (Bun + bun:sqlite).
 *
 * Exercises the store directly (no HTTP): recursive dir creation, report/board
 * round-trip, max-total upsert, descending sort, the 100 cap + explicit limit,
 * per-day isolation, and old-day pruning. Also covers the collective-spend
 * aggregate: hourly delta accumulation, the 24-bucket series, collectiveTotal /
 * activeTags / tagTotal, and hourly pruning. Uses an ephemeral temp DB file.
 */

import { test, expect, afterAll } from 'bun:test';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LeaderboardDB } from '../server/db.ts';

const tmpRoot = mkdtempSync(join(tmpdir(), 'mir-lb-db-test-'));
const dbPath = join(tmpRoot, 'nested', 'leaderboard.db');

const TODAY = LeaderboardDB.today();
const YESTERDAY = LeaderboardDB.today(
  new Date(Date.parse(TODAY + 'T00:00:00Z') - 86400000)
);
const OLD_DAY = LeaderboardDB.today(
  new Date(Date.parse(TODAY + 'T00:00:00Z') - 10 * 86400000)
);

afterAll(() => {
  rmSync(tmpRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
});

test('creates parent dir recursively + report/leaderboard round-trip', () => {
  const db = new LeaderboardDB(dbPath);
  expect(existsSync(dirname(dbPath))).toBe(true);

  const stored = db.report('TurboLlama7392', 12.34);
  expect(stored).toBe(12.34);

  expect(db.leaderboard()).toEqual([
    { tag: 'TurboLlama7392', total: 12.34, saved: 0, optimized: false },
  ]);
  db.close();
});

test('upsert keeps the MAX total (latest cumulative figure)', () => {
  const db = new LeaderboardDB(dbPath);
  db.report('SpicyOtter1', 5);
  expect(db.report('SpicyOtter1', 20)).toBe(20);
  expect(db.report('SpicyOtter1', 8)).toBe(20);
  const entry = db.leaderboard().find((e) => e.tag === 'SpicyOtter1');
  expect(entry?.total).toBe(20);
  db.close();
});

test('sorts alphabetically (A-Z, case-insensitive), not by amount', () => {
  const day = '2000-01-01'; // isolated day, no interference
  const db = new LeaderboardDB(dbPath);
  db.report('charlie', 1, day);
  db.report('Alpha', 100, day); // biggest spender, but not first
  db.report('bravo', 50, day);
  const tags = db.leaderboard(day).map((e) => e.tag);
  expect(tags).toEqual(['Alpha', 'bravo', 'charlie']);
  db.close();
});

test('caps the board at 100 by default and honors an explicit limit', () => {
  const day = '2000-02-02';
  const db = new LeaderboardDB(dbPath);
  for (let i = 0; i < 150; i++) db.report('tag' + i, i + 1, day);
  const board = db.leaderboard(day);
  expect(board.length).toBe(100);
  // Alphabetical order holds within the returned page (all-lowercase ASCII, so
  // a plain code-unit sort matches SQLite's COLLATE NOCASE ordering).
  const tags = board.map((e) => e.tag);
  expect([...tags].sort()).toEqual(tags);
  expect(db.leaderboard(day, 5).length).toBe(5);
  db.close();
});

test('isolates days: a report on another day does not leak into today', () => {
  const db = new LeaderboardDB(dbPath);
  db.report('YesterdayTag', 999, YESTERDAY);
  const today = db.leaderboard(TODAY);
  expect(today.some((e) => e.tag === 'YesterdayTag')).toBe(false);
  expect(db.leaderboard(YESTERDAY).some((e) => e.tag === 'YesterdayTag')).toBe(
    true
  );
  db.close();
});

test('prunes days older than yesterday on a fresh report', () => {
  const db = new LeaderboardDB(dbPath);
  db.report('AncientTag', 42, OLD_DAY); // lands, but next report prunes it
  expect(db.leaderboard(OLD_DAY).some((e) => e.tag === 'AncientTag')).toBe(
    true
  );
  db.report('FreshTag', 1, TODAY); // pruneOldDays keeps only today + yesterday
  expect(db.leaderboard(OLD_DAY).length).toBe(0);
  db.close();
});

// ── Collective-spend aggregate ────────────────────────────────────────────────

test('hourly buckets accumulate positive deltas; sum equals collectiveTotal', () => {
  const day = '2001-03-03';
  const db = new LeaderboardDB(dbPath);
  const at = (h: number) => new Date(Date.UTC(2001, 2, 3, h));
  db.report('A', 2, day, at(9)); // +2 in hour 9
  db.report('A', 5, day, at(10)); // +3 in hour 10
  db.report('A', 4, day, at(11)); // lower re-report -> +0, no double count
  db.report('B', 3, day, at(10)); // +3 in hour 10

  const series = db.hourlySeries(day);
  expect(series.length).toBe(24);
  expect(series[9]!.spend).toBe(2);
  expect(series[10]!.spend).toBe(6);
  expect(series[11]!.spend).toBe(0);

  const sum = series.reduce((s, b) => s + b.spend, 0);
  expect(sum).toBe(db.collectiveTotal(day));
  expect(db.collectiveTotal(day)).toBe(8); // A=5, B=3
  db.close();
});

test('hourlySeries returns 24 zero-filled buckets for an empty day', () => {
  const db = new LeaderboardDB(dbPath);
  const series = db.hourlySeries('1999-09-09');
  expect(series.length).toBe(24);
  expect(series.every((b, i) => b.hour === i && b.spend === 0)).toBe(true);
  db.close();
});

test('collectiveTotal, activeTags and tagTotal report per-day aggregates', () => {
  const day = '2001-04-04';
  const db = new LeaderboardDB(dbPath);
  db.report('One', 10, day);
  db.report('Two', 25, day);
  db.report('One', 40, day); // cumulative update, still one tag

  expect(db.collectiveTotal(day)).toBe(65); // 40 + 25
  expect(db.activeTags(day)).toBe(2);
  expect(db.tagTotal('One', day)).toBe(40);
  expect(db.tagTotal('Nobody', day)).toBe(0);
  db.close();
});

// ── savedUSD: the ONE Optimize-release telemetry addition ──────────────────

test('report(): savedUSD is a latest-wins per-(day,tag) snapshot, not MAX', () => {
  const day = '2002-05-05';
  const db = new LeaderboardDB(dbPath);
  db.report('SaverOne', 10, day, new Date(), 2.5);
  db.report('SaverTwo', 20, day, new Date(), 1.5);
  expect(db.collectiveSavedTotal(day)).toBe(4);

  // Re-reporting takes the LATEST value — a lower figure overwrites (so a stale
  // one-off spike can't pin the day). SaverOne 2.5 -> 1.0, total 4 -> 2.5.
  db.report('SaverOne', 15, day, new Date(), 1.0);
  expect(db.collectiveSavedTotal(day)).toBe(2.5);

  // A higher value likewise just replaces. SaverOne 1.0 -> 5, total -> 6.5.
  db.report('SaverOne', 16, day, new Date(), 5);
  expect(db.collectiveSavedTotal(day)).toBe(6.5);
  db.close();
});

test('report(): omitting/invalid savedUSD never records anything (back-compatible)', () => {
  const day = '2002-06-06';
  const db = new LeaderboardDB(dbPath);
  db.report('NoSavings', 10, day);
  expect(db.collectiveSavedTotal(day)).toBe(0);
  db.report('BadSavings', 5, day, new Date(), -1);
  expect(db.collectiveSavedTotal(day)).toBe(0);
  db.close();
});

test('collectiveSavedTotal for an empty day is 0', () => {
  const db = new LeaderboardDB(dbPath);
  expect(db.collectiveSavedTotal('1998-08-08')).toBe(0);
  db.close();
});

test('leaderboard() surfaces per-tag saved + optimized; optimized sticks once true', () => {
  const day = '2002-07-07';
  const db = new LeaderboardDB(dbPath);
  // optimized true with 0 saved (tools just installed) still records the flag.
  db.report('OptTag', 10, day, new Date(), 0, true);
  db.report('PlainTag', 5, day, new Date(), 2.5, false);

  const board = db.leaderboard(day);
  const opt = board.find((e) => e.tag === 'OptTag');
  const plain = board.find((e) => e.tag === 'PlainTag');
  expect(opt).toEqual({ tag: 'OptTag', total: 10, saved: 0, optimized: true });
  expect(plain).toEqual({
    tag: 'PlainTag',
    total: 5,
    saved: 2.5,
    optimized: false,
  });

  // A later report without the flag must not clear an already-true optimized.
  db.report('OptTag', 12, day, new Date(), 1);
  const opt2 = db.leaderboard(day).find((e) => e.tag === 'OptTag');
  expect(opt2).toEqual({ tag: 'OptTag', total: 12, saved: 1, optimized: true });
  db.close();
});

test('prunes hourly buckets for days older than yesterday', () => {
  const db = new LeaderboardDB(dbPath);
  db.report('OldSpend', 30, OLD_DAY);
  expect(db.collectiveTotal(OLD_DAY)).toBe(30);
  db.report('TodaySpend', 1, TODAY); // triggers prune of old day
  expect(db.hourlySeries(OLD_DAY).every((b) => b.spend === 0)).toBe(true);
  expect(db.collectiveTotal(OLD_DAY)).toBe(0);
  db.close();
});

test('prunes savings for days older than yesterday', () => {
  const db = new LeaderboardDB(dbPath);
  db.report('OldSaver', 30, OLD_DAY, new Date(), 5);
  expect(db.collectiveSavedTotal(OLD_DAY)).toBe(5);
  db.report('TodaySaver', 1, TODAY, new Date(), 1); // triggers prune of old day
  expect(db.collectiveSavedTotal(OLD_DAY)).toBe(0);
  db.close();
});
