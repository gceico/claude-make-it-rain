'use strict';

import { test, afterAll } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  scanRange,
  rangeFor,
  dayKey,
  billCount,
  History,
} from '../src/lib/history';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-history-test-'));
const projectsDir = path.join(tmpRoot, 'projects');
const projectA = path.join(projectsDir, 'project-a');
const projectB = path.join(projectsDir, 'project-b');
fs.mkdirSync(projectA, { recursive: true });
fs.mkdirSync(projectB, { recursive: true });

// Fixed reference "now" (local noon) so range math is deterministic.
const NOW = new Date(2026, 5, 15, 12, 0, 0); // Mon Jun 15 2026, 12:00 local

// Local ISO timestamp `dayOffset` days from NOW (noon → same calendar day).
function tsAt(dayOffset: number): string {
  const d = new Date(2026, 5, 15 + dayOffset, 12, 0, 0);
  return d.toISOString();
}

interface EntryArgs {
  ts: string;
  reqId: string;
  msgId: string;
  inputM?: number;
  model?: string;
  type?: string;
}

// One assistant usage record. sonnet at 1M input = $3, so `inputM` million
// input tokens costs $3 * inputM — handy round numbers.
function entry({
  ts,
  reqId,
  msgId,
  inputM = 1,
  model = 'claude-sonnet-5',
  type = 'assistant',
}: EntryArgs): string {
  return JSON.stringify({
    type,
    timestamp: ts,
    requestId: reqId,
    message: {
      id: msgId,
      model,
      usage: { input_tokens: inputM * 1e6, output_tokens: 0 },
    },
  });
}

const approx = (actual: number, expected: number, label: string) =>
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${label}: expected ${expected}, got ${actual}`
  );

// ── Helpers ───────────────────────────────────────────────────────────────
test('helpers + range math', () => {
  assert.strictEqual(billCount(0), 0);
  assert.strictEqual(billCount(99.99), 0);
  assert.strictEqual(billCount(342.1), 3);
  assert.strictEqual(dayKey(new Date(2026, 5, 15, 23, 59)), '2026-06-15');

  // Range boundaries (half-open [start, end)).
  const r7 = rangeFor('last7days', NOW);
  assert.strictEqual(
    r7.start.getTime(),
    new Date(2026, 5, 9, 0, 0, 0, 0).getTime(),
    'last7 start = today-6'
  );
  assert.strictEqual(
    r7.end.getTime(),
    new Date(2026, 5, 16, 0, 0, 0, 0).getTime(),
    'last7 end = tomorrow'
  );
  const rMonth = rangeFor('thisMonth', NOW);
  assert.strictEqual(
    rMonth.start.getTime(),
    new Date(2026, 5, 1, 0, 0, 0, 0).getTime(),
    'thisMonth start = 1st'
  );
  const rYest = rangeFor('yesterday', NOW);
  assert.strictEqual(
    rYest.start.getTime(),
    new Date(2026, 5, 14, 0, 0, 0, 0).getTime()
  );
  assert.strictEqual(
    rYest.end.getTime(),
    new Date(2026, 5, 15, 0, 0, 0, 0).getTime()
  );
});

// ── Fixtures across multiple days and files ─────────────────────────────────
// project-a/session1.jsonl: today x2 ($3 + $3), yesterday ($3), 8-days-ago ($30 - out of last7)
fs.writeFileSync(
  path.join(projectA, 'session1.jsonl'),
  [
    entry({ ts: tsAt(0), reqId: 'a', msgId: '1', inputM: 1 }), // today $3
    entry({ ts: tsAt(0), reqId: 'a', msgId: '2', inputM: 1 }), // today $3
    entry({ ts: tsAt(-1), reqId: 'a', msgId: '3', inputM: 1 }), // yesterday $3
    entry({ ts: tsAt(-8), reqId: 'a', msgId: '4', inputM: 10 }), // 8 days ago $30
    '{ garbage', // must be skipped
    entry({ ts: tsAt(0), reqId: 'a', msgId: '5', inputM: 1, type: 'user' }), // wrong type
  ].join('\n') + '\n'
);

// project-b/session2.jsonl: yesterday (dup of a:3 → ignored), 2-days-ago ($3)
fs.writeFileSync(
  path.join(projectB, 'session2.jsonl'),
  [
    entry({ ts: tsAt(-1), reqId: 'a', msgId: '3', inputM: 1 }), // DUP across files
    entry({ ts: tsAt(-2), reqId: 'b', msgId: '9', inputM: 1 }), // 2 days ago $3
  ].join('\n') + '\n'
);

// ── Grouping + dedup across files (last 7 days) ───────────────────────────
test('grouping + cross-file dedup + type/garbage filtering', async () => {
  const last7 = await scanRange({
    projectsDir,
    rangeId: 'last7days',
    now: NOW,
  });
  // days: today $6, yesterday $3 (dup ignored), 2-days-ago $3 → total $12
  assert.strictEqual(
    last7.entryCount,
    4,
    `last7 entryCount: got ${last7.entryCount}`
  );
  approx(last7.totalCostUSD, 12, 'last7 total');
  assert.deepStrictEqual(
    last7.days.map((d) => d.date),
    ['2026-06-13', '2026-06-14', '2026-06-15'],
    'last7 day keys sorted ascending'
  );
  approx(
    last7.days.find((d) => d.date === '2026-06-15')!.costUSD,
    6,
    'today bucket'
  );
  approx(
    last7.days.find((d) => d.date === '2026-06-14')!.costUSD,
    3,
    'yesterday bucket (dedup)'
  );
});

test('range boundaries (today / yesterday / 7 vs 30 day window)', async () => {
  // today only
  const today = await scanRange({ projectsDir, rangeId: 'today', now: NOW });
  assert.strictEqual(today.entryCount, 2, 'today entries');
  approx(today.totalCostUSD, 6, 'today total');
  assert.deepStrictEqual(
    today.days.map((d) => d.date),
    ['2026-06-15']
  );

  // yesterday only
  const yest = await scanRange({ projectsDir, rangeId: 'yesterday', now: NOW });
  assert.strictEqual(yest.entryCount, 1, 'yesterday entries (dedup, boundary)');
  approx(yest.totalCostUSD, 3, 'yesterday total');
  assert.deepStrictEqual(
    yest.days.map((d) => d.date),
    ['2026-06-14']
  );

  // last 30 days includes the 8-days-ago $30 entry
  const last30 = await scanRange({
    projectsDir,
    rangeId: 'last30days',
    now: NOW,
  });
  approx(last30.totalCostUSD, 42, 'last30 total includes 8-days-ago');
});

test('mtime skip optimization', async () => {
  const stale = path.join(projectA, 'stale.jsonl');
  fs.writeFileSync(
    stale,
    entry({ ts: tsAt(0), reqId: 'z', msgId: '99', inputM: 1 }) + '\n'
  );
  const old = new Date(2026, 5, 1, 12, 0, 0); // June 1, well before "today"
  fs.utimesSync(stale, old, old);
  const todayAfterStale = await scanRange({
    projectsDir,
    rangeId: 'today',
    now: NOW,
  });
  assert.strictEqual(
    todayAfterStale.entryCount,
    2,
    'stale-mtime file must be skipped for today'
  );
  fs.rmSync(stale);
});

test('History cache: same promise within TTL, force bypasses', async () => {
  const h = new History({ projectsDir, cacheTtlMs: 10_000 });
  const p1 = h.get('today', { now: NOW });
  const p2 = h.get('today', { now: NOW });
  assert.strictEqual(p1, p2, 'cached range returns the same in-flight promise');
  const p3 = h.get('today', { force: true, now: NOW });
  assert.notStrictEqual(p1, p3, 'force bypasses the cache');
  await Promise.all([p1, p3]);
});

// ── Immutable past-days ledger: only today's files re-read on refresh ─────
test('immutable past-days ledger (only today re-read on refresh)', async () => {
  // Make session2 look untouched since yesterday (its newest entry IS from
  // yesterday, so this mirrors reality: mtime >= newest entry timestamp).
  const session2 = path.join(projectB, 'session2.jsonl');
  const yestNoon = new Date(2026, 5, 14, 12, 30, 0);
  fs.utimesSync(session2, yestNoon, yestNoon);

  const reads: string[] = [];
  const realReadFile = fs.promises.readFile;
  // @ts-expect-error patching the readFile spy for the duration of this test
  fs.promises.readFile = function (...args: unknown[]) {
    reads.push(String(args[0]));
    // @ts-expect-error forwarding to the real implementation
    return realReadFile.apply(fs.promises, args);
  };

  try {
    const h2 = new History({ projectsDir, cacheTtlMs: 10_000 });
    const first = await h2.get('last7days', { now: NOW });
    approx(
      first.totalCostUSD,
      12,
      'ledger-backed last7 total matches full scan'
    );
    assert.ok(
      reads.some((f) => f.endsWith('session2.jsonl')),
      'initial ledger build must read past files'
    );

    // Forced refresh: past days come from the cached ledger; only files
    // touched today are re-read.
    reads.length = 0;
    const second = await h2.get('last7days', { force: true, now: NOW });
    approx(second.totalCostUSD, 12, 'forced refresh total unchanged');
    assert.ok(
      !reads.some((f) => f.endsWith('session2.jsonl')),
      'forced refresh must NOT re-read files untouched since yesterday'
    );
    assert.ok(
      reads.some((f) => f.endsWith('session1.jsonl')),
      'forced refresh re-reads today-touched files'
    );

    // New today entry is picked up; a late entry with a past-day timestamp is
    // ignored (completed days are treated as immutable).
    fs.appendFileSync(
      path.join(projectA, 'session1.jsonl'),
      entry({ ts: tsAt(0), reqId: 'c', msgId: '20', inputM: 1 }) +
        '\n' +
        entry({ ts: tsAt(-1), reqId: 'c', msgId: '21', inputM: 1 }) +
        '\n'
    );
    const third = await h2.get('last7days', { force: true, now: NOW });
    approx(
      third.totalCostUSD,
      15,
      'today picks up new entries; past days stay cached'
    );
    approx(
      third.days.find((d) => d.date === '2026-06-15')!.costUSD,
      9,
      'today bucket updated'
    );
    approx(
      third.days.find((d) => d.date === '2026-06-14')!.costUSD,
      3,
      'yesterday bucket immutable'
    );

    // A forced refresh of ALL ranges at once must share a single today scan.
    reads.length = 0;
    await Promise.all(
      ['today', 'yesterday', 'last7days', 'last30days', 'thisMonth'].map((id) =>
        h2.get(id, { force: true, now: NOW })
      )
    );
    const s1Reads = reads.filter((f) => f.endsWith('session1.jsonl')).length;
    assert.strictEqual(
      s1Reads,
      1,
      `expected 1 shared today scan, got ${s1Reads} reads of session1`
    );
  } finally {
    fs.promises.readFile = realReadFile;
  }
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
