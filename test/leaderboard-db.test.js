'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-lb-db-test-'));
const dbPath = path.join(tmpRoot, 'nested', 'leaderboard.db');
process.env.LEADERBOARD_DB = dbPath;

const { LeaderboardDB } = require('../server/db');

const TODAY = LeaderboardDB.today();
const YESTERDAY = LeaderboardDB.today(new Date(Date.parse(TODAY + 'T00:00:00Z') - 86400000));
const OLD_DAY = LeaderboardDB.today(new Date(Date.parse(TODAY + 'T00:00:00Z') - 10 * 86400000));

// ── Parent dir is created recursively + report/leaderboard round-trip ─────────
{
  const db = new LeaderboardDB(dbPath);
  assert.ok(fs.existsSync(path.dirname(dbPath)), 'parent dir created recursively');

  const stored = db.report('TurboLlama7392', 12.34);
  assert.strictEqual(stored, 12.34, 'report returns the stored total');

  const board = db.leaderboard();
  assert.deepStrictEqual(board, [{ tag: 'TurboLlama7392', total: 12.34 }], 'round-trip');
  db.close();
  console.log('report + leaderboard round-trip: OK');
}

// ── Upsert: same tag reported twice keeps the MAX total ──────────────────────
{
  const db = new LeaderboardDB(dbPath);
  db.report('SpicyOtter1', 5);
  assert.strictEqual(db.report('SpicyOtter1', 20), 20, 'higher total wins');
  assert.strictEqual(db.report('SpicyOtter1', 8), 20, 'lower total does not clobber the max');
  const entry = db.leaderboard().find((e) => e.tag === 'SpicyOtter1');
  assert.strictEqual(entry.total, 20, 'stored total is the max ever seen');
  db.close();
  console.log('upsert keeps max (latest cumulative figure): OK');
}

// ── Sort order: high-to-low ──────────────────────────────────────────────────
{
  const day = '2000-01-01'; // isolated day, no interference
  const db = new LeaderboardDB(dbPath);
  db.report('Low', 1, day);
  db.report('High', 100, day);
  db.report('Mid', 50, day);
  const totals = db.leaderboard(day).map((e) => e.total);
  assert.deepStrictEqual(totals, [100, 50, 1], 'sorted high-to-low');
  db.close();
  console.log('sort order (descending by total): OK');
}

// ── 100 cap + default limit ──────────────────────────────────────────────────
{
  const day = '2000-02-02';
  const db = new LeaderboardDB(dbPath);
  for (let i = 0; i < 150; i++) db.report('tag' + i, i + 1, day);
  const board = db.leaderboard(day);
  assert.strictEqual(board.length, 100, 'capped at 100 by default');
  assert.strictEqual(board[0].total, 150, 'top entry is the highest total');
  assert.strictEqual(board[99].total, 51, '100th entry is the 100th-highest');
  // Explicit limit still honored.
  assert.strictEqual(db.leaderboard(day, 5).length, 5, 'explicit limit honored');
  db.close();
  console.log('100 cap + explicit limit: OK');
}

// ── Day isolation: a report on another day does not leak into today ──────────
{
  const db = new LeaderboardDB(dbPath);
  db.report('YesterdayTag', 999, YESTERDAY);
  const today = db.leaderboard(TODAY);
  assert.ok(!today.some((e) => e.tag === 'YesterdayTag'), 'yesterday does not leak into today');
  assert.ok(
    db.leaderboard(YESTERDAY).some((e) => e.tag === 'YesterdayTag'),
    'yesterday board still has its own entry'
  );
  db.close();
  console.log('day isolation: OK');
}

// ── Pruning: reporting today drops days older than yesterday ─────────────────
{
  const db = new LeaderboardDB(dbPath);
  db.report('AncientTag', 42, OLD_DAY); // lands, but next report prunes it
  assert.ok(db.leaderboard(OLD_DAY).some((e) => e.tag === 'AncientTag'), 'old day present');
  db.report('FreshTag', 1, TODAY); // pruneOldDays keeps only today + yesterday
  assert.strictEqual(db.leaderboard(OLD_DAY).length, 0, 'old day pruned after a fresh report');
  db.close();
  console.log('old-day pruning: OK');
}

// ── Tag credentials: claim once, verify, reject spoof, survive pruning ────────
{
  const db = new LeaderboardDB(dbPath);

  // First claim mints a raw secret; the tag now has a credential.
  const secret = db.claimTag('OwnerTag');
  assert.ok(typeof secret === 'string' && secret.length > 0, 'claimTag returns a non-empty secret');
  assert.strictEqual(db.claimTag('OwnerTag'), null, 're-claiming the same tag returns null');

  // Verify trichotomy: valid / invalid / unregistered.
  assert.strictEqual(db.verifyCredential('OwnerTag', secret), 'valid', 'correct secret is valid');
  assert.strictEqual(db.verifyCredential('OwnerTag', 'wrong'), 'invalid', 'wrong secret is invalid');
  assert.strictEqual(db.verifyCredential('OwnerTag', ''), 'invalid', 'empty secret is invalid');
  assert.strictEqual(db.verifyCredential('OwnerTag', null), 'invalid', 'non-string secret is invalid');
  assert.strictEqual(db.verifyCredential('NeverSeen', 'x'), 'unregistered', 'unknown tag is unregistered');

  // Credentials must survive the daily prune (which only touches `leaderboard`).
  db.report('AncientTag', 1, OLD_DAY);
  db.report('FreshTag', 1, TODAY); // triggers _pruneOldDays
  assert.strictEqual(db.verifyCredential('OwnerTag', secret), 'valid', 'credential survives pruning');
  db.close();
  console.log('tag credentials (claim once, verify trichotomy, prune-immune): OK');
}

// force + retries: on Windows the WAL sidecar files can linger a beat after close.
fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
delete process.env.LEADERBOARD_DB;
console.log('\nAll leaderboard-db tests passed.');
