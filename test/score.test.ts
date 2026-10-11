'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import {
  optimizationScore,
  netSavings,
  parseRtkGainOutput,
  parseRtkGainJson,
  parseRtkDailySavings,
  estimateToolSavingsRange,
  estimateDailyToolSavings,
  DEFAULT_WEIGHTS,
} from '../src/lib/score';
import { emptyDailySnapshot } from '../src/lib/analytics-store';
import type { ToolingState } from '../src/lib/analytics-store';

function noTools(): ToolingState {
  return {
    rtk: { installed: false, version: null, detectedAtMs: 0 },
    caveman: { installed: false, version: null, detectedAtMs: 0 },
    ponytail: { installed: false, version: null, detectedAtMs: 0 },
  };
}

function allTools(): ToolingState {
  return {
    rtk: { installed: true, version: '1.0.0', detectedAtMs: 1 },
    caveman: { installed: true, version: '1.0.0', detectedAtMs: 1 },
    ponytail: { installed: true, version: '1.0.0', detectedAtMs: 1 },
  };
}

test('weights sum to 100', () => {
  const sum = Object.values(DEFAULT_WEIGHTS).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, 100);
});

test('score: worst case (no cache, no tools, long session, heavy models, pastes) is low', () => {
  const snap = emptyDailySnapshot();
  snap.cache = { readTok: 0, creationTok: 1000, hitRatio: 0 };
  snap.sessions = { count: 1, maxContextTokens: 300_000 };
  snap.perModel['claude-opus-4-8'] = { costUSD: 10, inTok: 100, outTok: 1000 };
  const score = optimizationScore({
    snapshot: snap,
    toolingState: noTools(),
    giantPasteCount: 5,
    staleCacheIdleCount: 5,
  });
  assert.ok(score < 15, `expected a low score, got ${score}`);
});

test('score: best case (full cache, all tools, short session, light model) is high', () => {
  const snap = emptyDailySnapshot();
  snap.cache = { readTok: 9500, creationTok: 500, hitRatio: 0.95 };
  snap.sessions = { count: 1, maxContextTokens: 20_000 };
  snap.perModel['claude-sonnet-5'] = { costUSD: 10, inTok: 100, outTok: 1000 };
  const score = optimizationScore({
    snapshot: snap,
    toolingState: allTools(),
    giantPasteCount: 0,
    staleCacheIdleCount: 0,
  });
  assert.ok(score > 85, `expected a high score, got ${score}`);
});

test('score: monotonicity — improving cache hit ratio alone never decreases the score', () => {
  const base = emptyDailySnapshot();
  base.sessions = { count: 1, maxContextTokens: 20_000 };
  const lowCache = {
    ...base,
    cache: { readTok: 100, creationTok: 900, hitRatio: 0.1 },
  };
  const highCache = {
    ...base,
    cache: { readTok: 900, creationTok: 100, hitRatio: 0.9 },
  };
  const scoreLow = optimizationScore({
    snapshot: lowCache,
    toolingState: noTools(),
  });
  const scoreHigh = optimizationScore({
    snapshot: highCache,
    toolingState: noTools(),
  });
  assert.ok(scoreHigh > scoreLow, `${scoreHigh} should exceed ${scoreLow}`);
});

test('score: monotonicity — more tools installed never decreases the score', () => {
  const snap = emptyDailySnapshot();
  const noneScore = optimizationScore({
    snapshot: snap,
    toolingState: noTools(),
  });
  const allScore = optimizationScore({
    snapshot: snap,
    toolingState: allTools(),
  });
  assert.ok(allScore > noneScore);
});

test('score: is always within [0, 100]', () => {
  const snap = emptyDailySnapshot();
  snap.sessions = { count: 1, maxContextTokens: 10_000_000 };
  const score = optimizationScore({
    snapshot: snap,
    toolingState: noTools(),
    giantPasteCount: 100,
    staleCacheIdleCount: 100,
  });
  assert.ok(score >= 0 && score <= 100);
});

test('score: leanInstructions covers CLAUDE.md or AGENTS.md via instructionLines (caller takes the max)', () => {
  const snap = emptyDailySnapshot();
  const lean = optimizationScore({
    snapshot: snap,
    toolingState: noTools(),
    instructionLines: 100, // under the 200 threshold
  });
  const bloated = optimizationScore({
    snapshot: snap,
    toolingState: noTools(),
    instructionLines: 500, // AGENTS.md (or CLAUDE.md) at/over the taper floor
  });
  assert.ok(
    lean > bloated,
    `lean instructions (${lean}) should score higher than bloated (${bloated})`
  );
});

test('netSavings = gross - stillSpent, never negative-safe inputs crash it', () => {
  assert.strictEqual(netSavings(10, 4), 6);
  assert.strictEqual(netSavings(4, 10), -6, 'a net LOSS reads as negative');
  assert.strictEqual(
    netSavings(-5, 3),
    -3,
    'negative gross clamped to 0 first'
  );
  assert.strictEqual(netSavings(NaN, 3), -3, 'NaN input clamped to 0');
});

test('netSavings: green animation gating — only fire on strictly positive net', () => {
  const shouldFireGreen = (gross: number, spent: number) =>
    netSavings(gross, spent) > 0;
  assert.strictEqual(shouldFireGreen(10, 4), true);
  assert.strictEqual(
    shouldFireGreen(4, 10),
    false,
    'gross saving eaten by spend must not celebrate'
  );
  assert.strictEqual(
    shouldFireGreen(5, 5),
    false,
    'exact break-even must not celebrate'
  );
});

test('parseRtkGainOutput: extracts a USD figure near a "sav" mention', () => {
  const output = 'Token usage optimized.\nTotal saved: $12.34 this session\n';
  const result = parseRtkGainOutput(output);
  assert.ok(result);
  assert.strictEqual(result!.savedUSD, 12.34);
});

test('parseRtkGainOutput: returns null on unparseable output', () => {
  assert.strictEqual(parseRtkGainOutput('no relevant numbers here'), null);
  assert.strictEqual(parseRtkGainOutput(''), null);
  // @ts-expect-error deliberately passing a non-string to check it never throws
  assert.strictEqual(parseRtkGainOutput(null), null);
});

test('parseRtkGainJson: converts real nested summary.total_saved (tokens) to USD', () => {
  // Real `rtk gain --all --format json` shape: tokens saved, nested under summary.
  const json = {
    summary: {
      total_commands: 5465,
      total_saved: 69396771,
      avg_savings_pct: 96,
    },
    daily: [{ date: '2026-04-25', saved_tokens: 2332 }],
  };
  // Fake pricing: $5/1M input (pricingForModel(null)'s default tier).
  const result = parseRtkGainJson(json, () => ({
    inputPerMillion: 5,
    outputPerMillion: 25,
  }));
  assert.ok(result, 'must not be null against real RTK output');
  assert.strictEqual(result!.savedUSD, (69396771 * 5) / 1_000_000);
});

test('parseRtkGainJson: null without a pricing fn or when nothing usable', () => {
  assert.strictEqual(parseRtkGainJson({ summary: { total_saved: 100 } }), null);
  assert.strictEqual(
    parseRtkGainJson({ summary: {} }, () => ({
      inputPerMillion: 5,
      outputPerMillion: 25,
    })),
    null
  );
});

test('estimateToolSavingsRange: returns a conservative low..high range', () => {
  const range = estimateToolSavingsRange(100);
  assert.ok(range.lowUSD < range.highUSD);
  assert.ok(range.lowUSD >= 0);
  assert.ok(
    range.highUSD < 100,
    'a conservative estimate must be well under 100% of cost'
  );
});

test('estimateToolSavingsRange: never negative on bad input', () => {
  const range = estimateToolSavingsRange(-50);
  assert.strictEqual(range.lowUSD, 0);
  assert.strictEqual(range.highUSD, 0);
});

const fakePricing = () => ({ inputPerMillion: 5, outputPerMillion: 25 });

function snapshotWith(costUSD: number, outTok: number) {
  const snap = emptyDailySnapshot();
  snap.costUSD = costUSD;
  snap.perModel['claude-sonnet-5'] = { costUSD, inTok: 0, outTok };
  return snap;
}

test('estimateDailyToolSavings: each tool contributes 0 when not installed', () => {
  const snap = snapshotWith(10, 100_000);
  const d = estimateDailyToolSavings({
    snapshot: snap,
    toolingState: noTools(),
    rtkRealUSD: 5,
    pricingForModelFn: fakePricing,
  });
  assert.strictEqual(d.rtkReal, 0, 'rtk not installed -> 0');
  assert.strictEqual(d.cavemanEst, 0, 'caveman not installed -> 0');
  assert.strictEqual(d.ponytailEst, 0, 'ponytail not installed -> 0');
  assert.strictEqual(d.total, 0);
  assert.strictEqual(d.hasEstimate, false);
});

test('estimateDailyToolSavings: caveman uses OUTPUT-token cost only, ponytail uses total cost', () => {
  const snap = snapshotWith(10, 100_000); // outputCost = 100_000 * 25 / 1e6 = 2.5
  const d = estimateDailyToolSavings({
    snapshot: snap,
    toolingState: allTools(),
    rtkRealUSD: 0,
    pricingForModelFn: fakePricing,
  });
  const expectedOutputCost = (100_000 * 25) / 1e6;
  assert.strictEqual(d.cavemanEst, 0.65 * 0.15 * expectedOutputCost);
  assert.strictEqual(d.ponytailEst, 0.47 * 0.15 * 10);
  assert.strictEqual(d.hasEstimate, true);
});

test('estimateDailyToolSavings: RTK contributes the real rtkRealUSD figure', () => {
  const snap = snapshotWith(1000, 0);
  const d = estimateDailyToolSavings({
    snapshot: snap,
    toolingState: allTools(),
    rtkRealUSD: 3.21,
    pricingForModelFn: fakePricing,
  });
  assert.strictEqual(d.rtkReal, 3.21);
});

test('estimateDailyToolSavings: combined saved is clamped to the day spend', () => {
  // Huge output token count would otherwise blow past the tiny day's cost.
  const snap = snapshotWith(1, 10_000_000);
  const d = estimateDailyToolSavings({
    snapshot: snap,
    toolingState: allTools(),
    rtkRealUSD: 50,
    pricingForModelFn: fakePricing,
  });
  assert.strictEqual(d.total, 1, 'total saved never exceeds total spend');
});

test('parseRtkDailySavings: maps date -> savedUSD via the pricing fn', () => {
  const json = {
    daily: [
      { date: '2026-07-20', saved_tokens: 1_000_000 },
      { date: '2026-07-21', saved_tokens: 500_000 },
    ],
  };
  const map = parseRtkDailySavings(json, fakePricing);
  assert.strictEqual(map['2026-07-20'], 5); // 1M tokens * $5/1M
  assert.strictEqual(map['2026-07-21'], 2.5);
});

test('parseRtkDailySavings: skips malformed rows, returns {} on bad input', () => {
  assert.deepStrictEqual(parseRtkDailySavings(null, fakePricing), {});
  assert.deepStrictEqual(parseRtkDailySavings({}, fakePricing), {});
  const json = {
    daily: [
      { date: '2026-07-20', saved_tokens: 100 },
      { date: 123, saved_tokens: 100 }, // bad date
      { date: '2026-07-22', saved_tokens: 'lots' }, // bad tokens
      'not-an-object',
      null,
    ],
  };
  const map = parseRtkDailySavings(json, fakePricing);
  assert.deepStrictEqual(Object.keys(map), ['2026-07-20']);
});
