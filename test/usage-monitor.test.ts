'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { UsageMonitor } from '../src/lib/usage-monitor';
import { costForEntry, pricingForModel } from '../src/lib/pricing';
import { stackCountForCrossing } from '../src/lib/milestones';

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
// pricing (2026-07). Keeps the tool from drifting away from `/cost` / ccusage.
test('pricing model coverage + cost math', () => {
  assert.deepStrictEqual(pricingForModel('claude-fable-5'), {
    inputPerMillion: 10,
    outputPerMillion: 50,
  });
  assert.deepStrictEqual(pricingForModel('claude-mythos-5'), {
    inputPerMillion: 10,
    outputPerMillion: 50,
  });
  assert.deepStrictEqual(pricingForModel('claude-opus-4-8'), {
    inputPerMillion: 5,
    outputPerMillion: 25,
  });
  assert.deepStrictEqual(pricingForModel('claude-opus-4-7'), {
    inputPerMillion: 5,
    outputPerMillion: 25,
  });
  assert.deepStrictEqual(pricingForModel('claude-opus-4-6'), {
    inputPerMillion: 5,
    outputPerMillion: 25,
  });
  assert.deepStrictEqual(pricingForModel('claude-sonnet-5'), {
    inputPerMillion: 3,
    outputPerMillion: 15,
  });
  assert.deepStrictEqual(pricingForModel('claude-sonnet-4-6'), {
    inputPerMillion: 3,
    outputPerMillion: 15,
  });
  assert.deepStrictEqual(pricingForModel('claude-haiku-4-5'), {
    inputPerMillion: 1,
    outputPerMillion: 5,
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
      'claude-sonnet-5'
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
      'claude-sonnet-5'
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
      'claude-sonnet-5'
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
      'claude-sonnet-5'
    ),
    3 * 1.25,
    'cache creation without breakdown = 5m rate'
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
      model: 'claude-sonnet-5',
      reqId: 'r1',
      msgId: 'm1',
      input: 100_000,
      output: 10_000,
    }),
    // duplicate of the same requestId:messageId — must be ignored
    entry({
      ts: todayISO,
      model: 'claude-sonnet-5',
      reqId: 'r1',
      msgId: 'm1',
      input: 100_000,
      output: 10_000,
    }),
    // yesterday — must be ignored
    entry({
      ts: yesterdayISO,
      model: 'claude-sonnet-5',
      reqId: 'r2',
      msgId: 'm2',
      input: 500_000,
      output: 500_000,
    }),
    // non-assistant — must be ignored
    entry({
      ts: todayISO,
      model: 'claude-sonnet-5',
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
      model: 'claude-sonnet-5',
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

// ── Dollar-crossing math used by main.ts ─────────────────────────────────────
test('crossing math', () => {
  assert.strictEqual(
    Math.floor(4.45) - Math.floor(1.45),
    3,
    '3 whole dollars crossed'
  );
  assert.strictEqual(
    Math.floor(105 / 100) - Math.floor(95 / 100),
    1,
    '$100 boundary crossed'
  );
});

// ── Milestone stack crossings used by main.ts (lib/milestones.ts) ────────────
// Milestones fire the first time today's total crosses M: previousTotal < M <= newTotal.
// Because previousTotal resets to $0 at midnight (monitor _resetState), this also
// resets the milestones for free the next day.
test('milestone crossing math', () => {
  assert.strictEqual(
    stackCountForCrossing(9.5, 10.2),
    1,
    '$10 milestone fires one stack on first crossing'
  );
  assert.strictEqual(
    stackCountForCrossing(10.2, 12),
    0,
    '$10 milestone does not re-fire after crossing'
  );
  assert.strictEqual(
    stackCountForCrossing(48, 51),
    5,
    '$50 milestone fires five stacks on first crossing'
  );
  assert.strictEqual(
    stackCountForCrossing(51, 99),
    0,
    '$50 milestone does not re-fire after crossing'
  );
  assert.strictEqual(
    stackCountForCrossing(0, 10),
    1,
    'exact landing on $10 counts as a crossing'
  );
  // When several thresholds are crossed in one jump, only the highest fires.
  assert.strictEqual(
    stackCountForCrossing(5, 55),
    5,
    'a $5→$55 jump fires the $50 stacks (highest crossed)'
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
      model: 'claude-sonnet-5',
      usage: { input_tokens: 0, output_tokens: 1_000_000 },
    },
  });
  // Filler makes the initial file large so the later rewrite is strictly shorter,
  // forcing the offset-reset / re-read path in processFile.
  const filler = entry({
    ts: todayISO,
    model: 'claude-sonnet-5',
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

test('cleanup', () => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
