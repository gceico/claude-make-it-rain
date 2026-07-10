/**
 * Unit tests for the leaderboard SQLite store (Bun + bun:sqlite).
 *
 * Exercises the store directly (no HTTP): recursive dir creation, report/board
 * round-trip, max-total upsert, descending sort, the 100 cap + explicit limit,
 * per-day isolation, and old-day pruning. Uses an ephemeral temp DB file.
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

  expect(db.leaderboard()).toEqual([{ tag: 'TurboLlama7392', total: 12.34 }]);
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

test('sorts high-to-low by total', () => {
  const day = '2000-01-01'; // isolated day, no interference
  const db = new LeaderboardDB(dbPath);
  db.report('Low', 1, day);
  db.report('High', 100, day);
  db.report('Mid', 50, day);
  const totals = db.leaderboard(day).map((e) => e.total);
  expect(totals).toEqual([100, 50, 1]);
  db.close();
});

test('caps the board at 100 by default and honors an explicit limit', () => {
  const day = '2000-02-02';
  const db = new LeaderboardDB(dbPath);
  for (let i = 0; i < 150; i++) db.report('tag' + i, i + 1, day);
  const board = db.leaderboard(day);
  expect(board.length).toBe(100);
  expect(board[0]!.total).toBe(150);
  expect(board[99]!.total).toBe(51);
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
