'use strict';

import { test, afterAll } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageMonitor } from '../src/lib/usage-monitor';
import type { Snapshot } from '../src/lib/usage-monitor';
import { costForEntry, pricingForModel } from '../src/lib/pricing';
import { dollarsCrossed, crossedHundred } from '../src/lib/milestones';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-test-'));
const projectsDir = path.join(tmpRoot, 'projects');
const projectDir = path.join(projectsDir, 'my-project');
fs.mkdirSync(projectDir, { recursive: true });

const now = new Date();
const todayISO = now.toISOString();
const yesterdayISO = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

interface EntryArgs {
  ts: string;
  model?: string | null;
  reqId: string;
  msgId?: string;
  input: number;
  output: number;
  cacheRead?: number;
  cacheCreate?: number;
  breakdown?: Record<string, number> | null;
  type?: string;
}

function entry({
  ts,
  model,
  reqId,
  msgId,
  input,
  output,
  cacheRead = 0,
  cacheCreate = 0,
  breakdown = null,
  type = 'assistant',
}: EntryArgs): string {
  const usage: Record<string, unknown> = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
  if (breakdown) usage.cache_creation = breakdown;
  return JSON.stringify({
    type,
    timestamp: ts,
    requestId: reqId,
    message: { id: msgId, model, usage },
  });
}

// ── Pricing unit checks ──────────────────────────────────────────────────────
// Current model coverage, verified against Anthropic's published per-model
// pricing (2026-10-11). Keeps the tool from drifting away from `/cost` / ccusage.
test('pricing model coverage + cost math', () => {
  const rates = (model: string) => {
    const p = pricingForModel(model);
    return [
      p.inputPerMillion,
      p.outputPerMillion,
      p.cacheReadMultiplier ?? 0.1,
    ];
  };
  // [input, output, cache-read multiplier]
  assert.deepStrictEqual(rates('claude-fable-5-1'), [10, 50, 0.025]);
  assert.deepStrictEqual(rates('claude-mythos-5-1'), [10, 50, 0.025]);
  assert.deepStrictEqual(rates('claude-fable-5'), [10, 50, 0.1]);
  assert.deepStrictEqual(rates('claude-mythos-5'), [10, 50, 0.1]);
  assert.deepStrictEqual(rates('claude-opus-5-5'), [4, 20, 0.05]);
  assert.deepStrictEqual(rates('claude-opus-5'), [5, 25, 0.1]);
  assert.deepStrictEqual(rates('claude-opus-4-8'), [5, 25, 0.1]);
  assert.deepStrictEqual(rates('claude-opus-4-7'), [5, 25, 0.1]);
  assert.deepStrictEqual(rates('claude-opus-4-6'), [5, 25, 0.1]);
  assert.deepStrictEqual(rates('claude-opus-4-5-20251101'), [5, 25, 0.1]);
  assert.deepStrictEqual(rates('claude-sonnet-5-5'), [2, 10, 0.05]);
  // Sonnet 5's $2/$10 launch price is now its standard price.
  assert.deepStrictEqual(rates('claude-sonnet-5'), [2, 10, 0.1]);
  assert.deepStrictEqual(rates('claude-sonnet-4-6'), [3, 15, 0.1]);
  assert.deepStrictEqual(rates('claude-sonnet-4-5-20250929'), [3, 15, 0.1]);
  assert.deepStrictEqual(rates('claude-haiku-5-5'), [0.1, 0.5, 0.1]);
  assert.deepStrictEqual(rates('claude-haiku-4-5-20251001'), [1, 5, 0.1]);
  // Fast mode exists only on Opus 5.5 / 5 / 4.8.
  assert.strictEqual(pricingForModel('claude-opus-5-5').fastMultiplier, 2);
  assert.strictEqual(pricingForModel('claude-opus-5').fastMultiplier, 2);
  assert.strictEqual(pricingForModel('claude-opus-4-8').fastMultiplier, 2);
  assert.strictEqual(
    pricingForModel('claude-opus-4-7').fastMultiplier,
    undefined
  );
  // Haiku 3.5 ($0.8/$4) and Claude 3 Haiku ($0.25/$1.25) are distinct tiers;
  // the real ids are 'claude-3-5-haiku-*' and 'claude-3-haiku-*'.
  assert.deepStrictEqual(pricingForModel('claude-3-5-haiku-20241022'), {
    inputPerMillion: 0.8,
    outputPerMillion: 4,
  });
  assert.deepStrictEqual(pricingForModel('claude-3-haiku-20240307'), {
    inputPerMillion: 0.25,
    outputPerMillion: 1.25,
  });
  // Old Opus 4.0/4.1 kept their historical $15/$75 rate.
  assert.deepStrictEqual(pricingForModel('claude-opus-4-1'), {
    inputPerMillion: 15,
    outputPerMillion: 75,
  });
  // Synthetic / local markers are never billed → $0 (ccusage skips them). Prior
  // behaviour charged them at the default rate, over-counting spend.
  assert.deepStrictEqual(pricingForModel('<synthetic>'), {
    inputPerMillion: 0,
    outputPerMillion: 0,
  });
  assert.strictEqual(
    costForEntry(
      {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadInputTokens: 1e6,
        cacheCreationInputTokens: 1e6,
        cacheCreationBreakdown: null,
      },
      '<synthetic>'
    ),
    0,
    'synthetic entries must cost $0 even with tokens'
  );
  // Unknown *real* model id (and null) falls back to Opus-tier so it doesn't vanish.
  assert.deepStrictEqual(pricingForModel('claude-brand-new-9'), {
    inputPerMillion: 5,
    outputPerMillion: 25,
  });
  assert.deepStrictEqual(pricingForModel(null), {
    inputPerMillion: 5,
    outputPerMillion: 25,
  });

  const approx = (actual: number, expected: number, label: string) =>
    assert.ok(
      Math.abs(actual - expected) < 1e-9,
      `${label}: expected ${expected}, got ${actual}`
    );

  // 1M in + 1M out on sonnet = $3 + $15
  approx(
    costForEntry(
      {
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreationBreakdown: null,
      },
      'claude-sonnet-4-6'
    ),
    18,
    'sonnet in+out'
  );
  // cache read at 10% of input rate: 1M cache-read on sonnet = $0.30
  approx(
    costForEntry(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 1e6,
        cacheCreationInputTokens: 0,
        cacheCreationBreakdown: null,
      },
      'claude-sonnet-4-6'
    ),
    0.3,
    'cache read'
  );
  // breakdown: 5m at 1.25x, 1h at 2x input rate
  approx(
    costForEntry(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 999,
        cacheCreationBreakdown: {
          ephemeral5mInputTokens: 1e6,
          ephemeral1hInputTokens: 1e6,
        },
      },
      'claude-sonnet-4-6'
    ),
    3 * 1.25 + 3 * 2,
    'cache creation breakdown'
  );
  // no breakdown: cache creation defaults to the 5m rate (1.25x input)
  approx(
    costForEntry(
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 1e6,
        cacheCreationBreakdown: null,
      },
      'claude-sonnet-4-6'
    ),
    3 * 1.25,
    'cache creation without breakdown = 5m rate'
  );

  const usage = (o: Partial<Parameters<typeof costForEntry>[0]>) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreationBreakdown: null,
    ...o,
  });
  // Per-model cache-read multipliers: Opus 5.5 0.05x, Fable 5.1 0.025x.
  approx(
    costForEntry(usage({ cacheReadInputTokens: 1e6 }), 'claude-opus-5-5'),
    0.2,
    'opus 5.5 cache read = $0.20'
  );
  approx(
    costForEntry(usage({ cacheReadInputTokens: 1e6 }), 'claude-fable-5-1'),
    0.25,
    'fable 5.1 cache read = $0.25'
  );
  approx(
    costForEntry(usage({ cacheReadInputTokens: 1e6 }), 'claude-fable-5'),
    1,
    'fable 5 cache read = $1'
  );
  // Haiku 5.5: base rates up to 100K prompt tokens, $0.50/$2.50 above —
  // cache reads count toward the threshold and reprice too.
  approx(
    costForEntry(
      usage({ inputTokens: 100_000, outputTokens: 1e6 }),
      'claude-haiku-5-5'
    ),
    0.01 + 0.5,
    'haiku 5.5 at the threshold stays on base rates'
  );
  approx(
    costForEntry(
      usage({
        inputTokens: 1_000,
        cacheReadInputTokens: 200_000,
        outputTokens: 1e6,
      }),
      'claude-haiku-5-5'
    ),
    (1_000 * 0.5 + 200_000 * 0.05) / 1e6 + 2.5,
    'haiku 5.5 over 100K reprices the whole request'
  );
  // Fast mode: 2x every category on models that have it; ignored elsewhere.
  approx(
    costForEntry(
      usage({
        inputTokens: 1e6,
        outputTokens: 1e6,
        cacheReadInputTokens: 1e6,
        speed: 'fast',
      }),
      'claude-opus-5-5'
    ),
    2 * (4 + 20 + 0.2),
    'opus 5.5 fast = 2x'
  );
  approx(
    costForEntry(usage({ inputTokens: 1e6, speed: 'fast' }), 'claude-opus-4-6'),
    5,
    'fast on a model without fast mode bills standard'
  );
  approx(
    costForEntry(
      usage({ inputTokens: 1e6, speed: 'standard' }),
      'claude-opus-5'
    ),
    5,
    'standard speed = base'
  );
});

// ── Monitor scan: dedup, day filter, type filter, cost math ────────────────
const file = path.join(projectDir, 'session1.jsonl');
let monitor: UsageMonitor;

test('initial scan (dedup, day filter, type filter, cost math)', () => {
  const lines = [
    // counted: 100k in / 10k out on sonnet = 0.3 + 0.15 = $0.45
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'r1',
      msgId: 'm1',
      input: 100_000,
      output: 10_000,
    }),
    // duplicate of the same requestId:messageId — must be ignored
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'r1',
      msgId: 'm1',
      input: 100_000,
      output: 10_000,
    }),
    // yesterday — must be ignored
    entry({
      ts: yesterdayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'r2',
      msgId: 'm2',
      input: 500_000,
      output: 500_000,
    }),
    // non-assistant — must be ignored
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'r3',
      msgId: 'm3',
      input: 1e6,
      output: 1e6,
      type: 'user',
    }),
    // counted: fable, 1M cache-read = 10 * 0.1 = $1.00
    entry({
      ts: todayISO,
      model: 'claude-fable-5',
      reqId: 'r4',
      msgId: 'm4',
      input: 0,
      output: 0,
      cacheRead: 1_000_000,
    }),
    // malformed line — must be skipped without crashing
    '{not json',
  ];
  fs.writeFileSync(file, lines.join('\n') + '\n');

  monitor = new UsageMonitor({ projectsDir });
  monitor.tick(true);

  const s1 = monitor.snapshot;
  assert.strictEqual(
    s1.entryCount,
    2,
    `expected 2 entries, got ${s1.entryCount}`
  );
  assert.strictEqual(s1.inputTokens, 100_000);
  assert.strictEqual(s1.outputTokens, 10_000);
  assert.ok(
    Math.abs(s1.totalCostUSD - 1.45) < 1e-9,
    `expected $1.45, got ${s1.totalCostUSD}`
  );
});

// ── Incremental append with a partial line across ticks ─────────────────────
test('incremental append + partial-line buffering', () => {
  // counted: 200k out on sonnet = $3.00; written in two chunks split mid-line.
  const appended =
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'r5',
      msgId: 'm5',
      input: 0,
      output: 200_000,
    }) + '\n';
  const half = Math.floor(appended.length / 2);
  fs.appendFileSync(file, appended.slice(0, half));
  monitor.tick(false);
  assert.strictEqual(
    monitor.snapshot.entryCount,
    2,
    'partial line must not be counted yet'
  );

  fs.appendFileSync(file, appended.slice(half));
  const updates: Array<{ prev: number; snap: unknown }> = [];
  monitor.onUpdate = (prev, snap) => {
    updates.push({ prev, snap });
  };
  monitor.tick(false);

  const s2 = monitor.snapshot;
  assert.strictEqual(s2.entryCount, 3);
  assert.ok(
    Math.abs(s2.totalCostUSD - 4.45) < 1e-9,
    `expected $4.45, got ${s2.totalCostUSD}`
  );
  assert.ok(updates.length > 0, 'onUpdate must fire when the total changes');
  assert.ok(Math.abs(updates[0].prev - 1.45) < 1e-9);
});

// ── Dollar-crossing math used by main.ts (lib/milestones.ts) ─────────────────
test('crossing math', () => {
  assert.strictEqual(dollarsCrossed(1.45, 4.45), 3, '3 whole dollars crossed');
  assert.strictEqual(crossedHundred(95, 105), true, '$100 boundary crossed');
  assert.strictEqual(
    crossedHundred(50, 99),
    false,
    'no $100 boundary crossed below $100'
  );
});

// ── Deterministic dedup on re-read (file truncation/rotation) ───────────────
// An id-less entry must not double-count when the file shrinks below the
// consumed offset and gets re-read from the start. The stable top-level `uuid`
// is the dedup fallback; a random UUID here would recount on the re-scan.
test('deterministic dedup on re-read', () => {
  const projectsDir2 = path.join(tmpRoot, 'projects2');
  const projectDir2 = path.join(projectsDir2, 'rotated-project');
  fs.mkdirSync(projectDir2, { recursive: true });
  const file2 = path.join(projectDir2, 'session2.jsonl');

  // Entry with NO message.id, only a top-level uuid. 1M output on sonnet = $15.
  const idlessEntry = JSON.stringify({
    type: 'assistant',
    timestamp: todayISO,
    requestId: 'rr1',
    uuid: 'stable-uuid-1',
    message: {
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 0, output_tokens: 1_000_000 },
    },
  });
  // Filler makes the initial file large so the later rewrite is strictly shorter,
  // forcing the offset-reset / re-read path in processFile.
  const filler = entry({
    ts: todayISO,
    model: 'claude-sonnet-4-6',
    reqId: 'rr2',
    msgId: 'mm2',
    input: 0,
    output: 0,
  });
  fs.writeFileSync(file2, idlessEntry + '\n' + filler + '\n');

  const monitor2 = new UsageMonitor({ projectsDir: projectsDir2 });
  monitor2.tick(true);
  const afterFirst = monitor2.snapshot.totalCostUSD;
  assert.ok(
    Math.abs(afterFirst - 15) < 1e-9,
    `expected $15 after first scan, got ${afterFirst}`
  );

  // Rewrite the file with ONLY the id-less entry — now shorter than the consumed
  // offset, triggering a full re-read from byte 0.
  fs.writeFileSync(file2, idlessEntry + '\n');
  monitor2.tick(false);
  assert.ok(
    Math.abs(monitor2.snapshot.totalCostUSD - 15) < 1e-9,
    `id-less entry double-counted on re-read: got ${monitor2.snapshot.totalCostUSD}, expected $15`
  );
});

// ── Midnight rollover: state reset re-derives today-only totals ─────────────
// Simulates the monitor running across local midnight by backdating
// currentDayStart. The rollover must reset all state and re-scan; the full
// re-read must not double-count today's entries (seenKeys/fileOffsets reset).
test('midnight rollover resets state without double-counting today', () => {
  const projectsDir3 = path.join(tmpRoot, 'projects3');
  const projectDir3 = path.join(projectsDir3, 'proj');
  fs.mkdirSync(projectDir3, { recursive: true });
  const file3 = path.join(projectDir3, 'session.jsonl');
  fs.writeFileSync(
    file3,
    [
      // yesterday — ignored by the day filter
      entry({
        ts: yesterdayISO,
        model: 'claude-sonnet-4-6',
        reqId: 'y1',
        msgId: 'ym1',
        input: 500_000,
        output: 500_000,
      }),
      // today — 100k in / 10k out on sonnet = 0.3 + 0.15 = $0.45
      entry({
        ts: todayISO,
        model: 'claude-sonnet-4-6',
        reqId: 't1',
        msgId: 'tm1',
        input: 100_000,
        output: 10_000,
      }),
    ].join('\n') + '\n'
  );

  const m = new UsageMonitor({ projectsDir: projectsDir3 });
  m.tick(true);
  assert.ok(
    Math.abs(m.snapshot.totalCostUSD - 0.45) < 1e-9,
    `expected $0.45 today-only, got ${m.snapshot.totalCostUSD}`
  );

  const updates: Array<{ prev: number; snap: Snapshot }> = [];
  m.onUpdate = (prev, snap) => {
    updates.push({ prev, snap });
  };
  // Pretend the monitor has been running since yesterday.
  m.currentDayStart = UsageMonitor.startOfToday(
    new Date(Date.now() - 24 * 3600 * 1000)
  );
  m.tick(false);

  assert.strictEqual(
    m.currentDayStart.getTime(),
    UsageMonitor.startOfToday().getTime(),
    'rollover must advance currentDayStart to today'
  );
  assert.ok(
    Math.abs(m.snapshot.totalCostUSD - 0.45) < 1e-9,
    `re-scan after reset must not double-count: got ${m.snapshot.totalCostUSD}`
  );
  assert.ok(updates.length >= 1, 'onUpdate must fire on the rollover tick');
  assert.strictEqual(updates[0].prev, 0, 'previousTotal after reset is 0');
});

// ── Midnight rollover with no new spend still emits a zeroed update ──────────
// Regression for the bug where onUpdate never fired on the first post-midnight
// tick without new entries, leaving consumers reporting yesterday's total.
test('midnight rollover with no new spend emits a zeroed onUpdate', () => {
  const projectsDir4 = path.join(tmpRoot, 'projects4');
  const projectDir4 = path.join(projectsDir4, 'proj');
  fs.mkdirSync(projectDir4, { recursive: true });
  const file4 = path.join(projectDir4, 'session.jsonl');
  // Only a yesterday entry: after rollover there is no today spend.
  fs.writeFileSync(
    file4,
    entry({
      ts: yesterdayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'y1',
      msgId: 'ym1',
      input: 500_000,
      output: 500_000,
    }) + '\n'
  );

  const m = new UsageMonitor({ projectsDir: projectsDir4 });
  m.tick(true);
  assert.strictEqual(
    m.snapshot.totalCostUSD,
    0,
    'no today spend before rollover'
  );

  const updates: Array<{ prev: number; snap: Snapshot }> = [];
  m.onUpdate = (prev, snap) => {
    updates.push({ prev, snap });
  };
  m.currentDayStart = UsageMonitor.startOfToday(
    new Date(Date.now() - 24 * 3600 * 1000)
  );
  m.tick(false);

  assert.strictEqual(
    updates.length,
    1,
    'rollover must emit exactly one onUpdate even with no new spend'
  );
  assert.strictEqual(updates[0].prev, 0, 'previousTotal after reset is 0');
  assert.strictEqual(
    updates[0].snap.totalCostUSD,
    0,
    'snapshot must be zeroed after rollover'
  );
  assert.strictEqual(
    m.currentDayStart.getTime(),
    UsageMonitor.startOfToday().getTime()
  );
});

// ── Live habit signals: userTurns, sessions, sessionGaps ────────────────────
// The monitor accumulates the raw signals the 4 content/session detectors need
// (giant-paste, rage-retry, long-sessions, stale-cache-idle). Verify both the
// accumulation AND that the detectors fire when fed the live snapshot.
test('accumulates userTurns / sessions / sessionGaps and detectors fire live', async () => {
  const { runHabitDetectors } = await import('../src/lib/habits');
  const pd = path.join(tmpRoot, 'projects-habits', 'proj');
  fs.mkdirSync(pd, { recursive: true });

  const t0 = now.getTime();
  const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();
  const assistant = (
    sessionId: string,
    tsOffset: number,
    reqId: string,
    input: number,
    cacheRead: number,
    cacheCreate: number
  ) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: iso(tsOffset),
      requestId: reqId,
      sessionId,
      message: {
        id: reqId + 'm',
        model: 'claude-sonnet-4-6',
        usage: {
          input_tokens: input,
          output_tokens: 0,
          cache_read_input_tokens: cacheRead,
          cache_creation_input_tokens: cacheCreate,
        },
      },
    });
  const userLine = (sessionId: string, tsOffset: number, text: string) =>
    JSON.stringify({
      type: 'user',
      timestamp: iso(tsOffset),
      sessionId,
      message: { content: text },
    });
  const readLine = (sessionId: string, tsOffset: number, numLines: number) =>
    JSON.stringify({
      type: 'user',
      timestamp: iso(tsOffset),
      sessionId,
      message: { content: 'tool result' },
      toolUseResult: {
        file: {
          filePath: '/Users/me/proj/big.ts',
          content: 'x',
          numLines,
          startLine: 1,
          totalLines: numLines,
        },
      },
    });

  fs.writeFileSync(
    path.join(pd, 's.jsonl'),
    [
      // giant paste (>20k chars) in session s1
      userLine('s1', -600_000, 'x'.repeat(25_000)),
      // long session: >150k context (input + cache read) in s1
      assistant('s1', -590_000, 'a1', 160_000, 20_000, 5_000),
      // big-file-reads: a 500+ line Read result in s1
      readLine('s1', -580_000, 1200),
      // >5min gap within s1 followed by a cache-creation spike (stale-cache-idle)
      assistant('s1', -100_000, 'a2', 100, 0, 30_000),
      // second distinct session for sessions.count == 2
      assistant('s2', -50_000, 'a3', 500, 0, 0),
      // rage-retry: 3 similar-sized user turns close together in s2
      userLine('s2', -40_000, 'y'.repeat(300)),
      userLine('s2', -39_000, 'y'.repeat(305)),
      userLine('s2', -38_000, 'y'.repeat(298)),
    ].join('\n') + '\n'
  );

  const m = new UsageMonitor({
    projectsDir: path.join(tmpRoot, 'projects-habits'),
  });
  m.tick(true);
  const snap = m.snapshot;

  assert.strictEqual(snap.userTurns.length, 5, 'all user turns recorded');
  assert.strictEqual(snap.fileReads.length, 1, 'the 500+ line read recorded');
  assert.strictEqual(snap.fileReads[0]!.lines, 1200);
  assert.strictEqual(snap.sessions.count, 2, 'two distinct sessions');
  assert.ok(
    snap.sessions.maxContextTokens >= 150_000,
    `peak context tracked, got ${snap.sessions.maxContextTokens}`
  );
  assert.strictEqual(
    snap.sessionGaps.length,
    1,
    'one >5min gap+rebuild recorded'
  );
  assert.strictEqual(snap.sessionGaps[0]!.cacheCreationTokensAfterGap, 30_000);

  // Feed the live snapshot through the detectors (mirrors main.ts buildHabitInput).
  const results = runHabitDetectors({
    snapshot: {
      costUSD: snap.totalCostUSD,
      perModel: {},
      cache: { readTok: 0, creationTok: 0, hitRatio: 0 },
      sessions: { ...snap.sessions },
      habitCounts: {},
    },
    toolingState: {
      rtk: { installed: true, version: null, detectedAtMs: 0 },
      caveman: { installed: true, version: null, detectedAtMs: 0 },
      ponytail: { installed: true, version: null, detectedAtMs: 0 },
    },
    userTurns: snap.userTurns,
    sessionGaps: snap.sessionGaps,
    fileReads: snap.fileReads,
    claudeMd: [{ projectKey: 'p1', totalLines: 250 }],
    agentsMd: 250,
  });
  const fired = new Set(results.filter((r) => r.triggered).map((r) => r.id));
  assert.ok(fired.has('giant-paste'), 'giant-paste fires live');
  assert.ok(fired.has('rage-retry'), 'rage-retry fires live');
  assert.ok(fired.has('long-sessions'), 'long-sessions fires live');
  assert.ok(fired.has('stale-cache-idle'), 'stale-cache-idle fires live');
  assert.ok(fired.has('bloated-claude-md'), 'bloated-claude-md fires live');
  assert.ok(fired.has('bloated-agents-md'), 'bloated-agents-md fires live');
  assert.ok(fired.has('big-file-reads'), 'big-file-reads fires live');
});

// ── Cowork (Claude Desktop local agent mode) sandboxed HOMEs ───────────────
test('counts Cowork session transcripts alongside the CLI ones', () => {
  const cliProjects = path.join(tmpRoot, 'cowork-cli', 'projects');
  const cliProject = path.join(cliProjects, 'proj');
  fs.mkdirSync(cliProject, { recursive: true });
  fs.writeFileSync(
    path.join(cliProject, 's.jsonl'),
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'cw-cli',
      msgId: 'cw-cli',
      input: 0,
      output: 100_000,
    }) + '\n' // $1.50
  );

  // <sessions>/<account>/<org>/<session>/.claude/projects/<project>/*.jsonl
  const sessionsDir = path.join(tmpRoot, 'cowork-sessions');
  const coworkProject = path.join(
    sessionsDir,
    'account',
    'org',
    'local_abc',
    '.claude',
    'projects',
    'sandboxed-proj'
  );
  fs.mkdirSync(coworkProject, { recursive: true });
  fs.writeFileSync(
    path.join(coworkProject, 't.jsonl'),
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'cw-agent',
      msgId: 'cw-agent',
      input: 0,
      output: 200_000,
    }) + '\n' // $3.00
  );
  // A checked-out repo inside the session HOME must not be scanned.
  const stray = path.join(sessionsDir, 'account', 'org', 'local_abc', 'repo');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(
    path.join(stray, 'nope.jsonl'),
    entry({
      ts: todayISO,
      model: 'claude-sonnet-4-6',
      reqId: 'cw-stray',
      msgId: 'cw-stray',
      input: 0,
      output: 999_999,
    }) + '\n'
  );

  const m = new UsageMonitor({
    projectsDir: cliProjects,
    coworkSessionsDir: sessionsDir,
  });
  m.tick(true);
  assert.strictEqual(m.snapshot.entryCount, 2);
  assert.ok(
    Math.abs(m.snapshot.totalCostUSD - 4.5) < 1e-9,
    `expected $4.50, got ${m.snapshot.totalCostUSD}`
  );

  // An explicit projectsDir with no cowork root stays CLI-only.
  const cliOnly = new UsageMonitor({ projectsDir: cliProjects });
  cliOnly.tick(true);
  assert.strictEqual(cliOnly.snapshot.entryCount, 1);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
