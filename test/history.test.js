'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { scanRange, rangeFor, dayKey, billCount, History } = require('../lib/history');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-history-test-'));
const projectsDir = path.join(tmpRoot, 'projects');
const projectA = path.join(projectsDir, 'project-a');
const projectB = path.join(projectsDir, 'project-b');
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });

// Fixed reference "now" (local noon) so range math is deterministic.
const NOW = new Date(2026, 5, 15, 12, 0, 0); // Mon Jun 15 2026, 12:00 local

// Local ISO timestamp `dayOffset` days from NOW (noon → same calendar day).
function tsAt(dayOffset) {
  const d = new Date(2026, 5, 15 + dayOffset, 12, 0, 0);
  return d.toISOString();
}

// One assistant usage record. sonnet at 1M input = $3, so `inputM` million
// input tokens costs $3 * inputM — handy round numbers.
function entry({ ts, reqId, msgId, inputM = 1, model = 'claude-sonnet-5', type = 'assistant' }) {
  return JSON.stringify({
    type,
    timestamp: ts,
    requestId: reqId,
    message: { id: msgId, model, usage: { input_tokens: inputM * 1e6, output_tokens: 0 } },
  });
}

const approx = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

// ── Helpers ───────────────────────────────────────────────────────────────
assert.strictEqual(billCount(0), 0);
assert.strictEqual(billCount(99.99), 0);
assert.strictEqual(billCount(342.10), 3);
assert.strictEqual(dayKey(new Date(2026, 5, 15, 23, 59)), '2026-06-15');

// Range boundaries (half-open [start, end)).
const r7 = rangeFor('last7days', NOW);
assert.strictEqual(r7.start.getTime(), new Date(2026, 5, 9, 0, 0, 0, 0).getTime(), 'last7 start = today-6');
assert.strictEqual(r7.end.getTime(), new Date(2026, 5, 16, 0, 0, 0, 0).getTime(), 'last7 end = tomorrow');
const rMonth = rangeFor('thisMonth', NOW);
assert.strictEqual(rMonth.start.getTime(), new Date(2026, 5, 1, 0, 0, 0, 0).getTime(), 'thisMonth start = 1st');
const rYest = rangeFor('yesterday', NOW);
assert.strictEqual(rYest.start.getTime(), new Date(2026, 5, 14, 0, 0, 0, 0).getTime());
assert.strictEqual(rYest.end.getTime(), new Date(2026, 5, 15, 0, 0, 0, 0).getTime());
console.log('helpers + range math: OK');

// ── Fixtures across multiple days and files ─────────────────────────────────
// project-a/session1.jsonl: today x2 ($3 + $3), yesterday ($3), 8-days-ago ($30 - out of last7)
fs.writeFileSync(
  path.join(projectA, 'session1.jsonl'),
  [
    entry({ ts: tsAt(0), reqId: 'a', msgId: '1', inputM: 1 }),   // today $3
    entry({ ts: tsAt(0), reqId: 'a', msgId: '2', inputM: 1 }),   // today $3
    entry({ ts: tsAt(-1), reqId: 'a', msgId: '3', inputM: 1 }),  // yesterday $3
    entry({ ts: tsAt(-8), reqId: 'a', msgId: '4', inputM: 10 }), // 8 days ago $30
    '{ garbage',                                                 // must be skipped
    entry({ ts: tsAt(0), reqId: 'a', msgId: '5', inputM: 1, type: 'user' }), // wrong type
  ].join('\n') + '\n'
);

// project-b/session2.jsonl: yesterday (dup of a:3 → ignored), 2-days-ago ($3)
fs.writeFileSync(
  path.join(projectB, 'session2.jsonl'),
  [
    entry({ ts: tsAt(-1), reqId: 'a', msgId: '3', inputM: 1 }),  // DUP across files
    entry({ ts: tsAt(-2), reqId: 'b', msgId: '9', inputM: 1 }),  // 2 days ago $3
  ].join('\n') + '\n'
);

(async () => {
  // ── Grouping + dedup across files (last 7 days) ───────────────────────────
  const last7 = await scanRange({ projectsDir, rangeId: 'last7days', now: NOW });
  // days: today $6, yesterday $3 (dup ignored), 2-days-ago $3 → total $12
  assert.strictEqual(last7.entryCount, 4, `last7 entryCount: got ${last7.entryCount}`);
  approx(last7.totalCostUSD, 12, 'last7 total');
  assert.deepStrictEqual(
    last7.days.map((d) => d.date),
    ['2026-06-13', '2026-06-14', '2026-06-15'],
    'last7 day keys sorted ascending'
  );
  approx(last7.days.find((d) => d.date === '2026-06-15').costUSD, 6, 'today bucket');
  approx(last7.days.find((d) => d.date === '2026-06-14').costUSD, 3, 'yesterday bucket (dedup)');
  console.log('grouping + cross-file dedup + type/garbage filtering: OK');

  // ── Range boundary: today only ────────────────────────────────────────────
  const today = await scanRange({ projectsDir, rangeId: 'today', now: NOW });
  assert.strictEqual(today.entryCount, 2, 'today entries');
  approx(today.totalCostUSD, 6, 'today total');
  assert.deepStrictEqual(today.days.map((d) => d.date), ['2026-06-15']);

  // ── Range boundary: yesterday only ────────────────────────────────────────
  const yest = await scanRange({ projectsDir, rangeId: 'yesterday', now: NOW });
  assert.strictEqual(yest.entryCount, 1, 'yesterday entries (dedup, boundary)');
  approx(yest.totalCostUSD, 3, 'yesterday total');
  assert.deepStrictEqual(yest.days.map((d) => d.date), ['2026-06-14']);

  // ── Range boundary: last 30 days includes the 8-days-ago $30 entry ────────
  const last30 = await scanRange({ projectsDir, rangeId: 'last30days', now: NOW });
  approx(last30.totalCostUSD, 42, 'last30 total includes 8-days-ago');
  console.log('range boundaries (today / yesterday / 7 vs 30 day window): OK');

  // ── mtime optimization: a file last modified before the window is skipped ─
  const stale = path.join(projectA, 'stale.jsonl');
  fs.writeFileSync(stale, entry({ ts: tsAt(0), reqId: 'z', msgId: '99', inputM: 1 }) + '\n');
  const old = new Date(2026, 5, 1, 12, 0, 0); // June 1, well before "today"
  fs.utimesSync(stale, old, old);
  const todayAfterStale = await scanRange({ projectsDir, rangeId: 'today', now: NOW });
  assert.strictEqual(todayAfterStale.entryCount, 2, 'stale-mtime file must be skipped for today');
  fs.rmSync(stale);
  console.log('mtime skip optimization: OK');

  // ── History cache: same promise within TTL, force bypasses ────────────────
  const h = new History({ projectsDir, cacheTtlMs: 10_000 });
  const p1 = h.get('today', { now: NOW });
  const p2 = h.get('today', { now: NOW });
  assert.strictEqual(p1, p2, 'cached range returns the same in-flight promise');
  const p3 = h.get('today', { force: true, now: NOW });
  assert.notStrictEqual(p1, p3, 'force bypasses the cache');
  await Promise.all([p1, p3]);
  console.log('History cache: OK');

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nAll history tests passed.');
})().catch((err) => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.error(err);
  process.exit(1);
});
