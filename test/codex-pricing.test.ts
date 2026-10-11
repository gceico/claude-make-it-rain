'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import { pricingForCodexModel, costForEntry } from '../src/lib/pricing';

// OpenAI rates, verified 2026-10-11 against developers.openai.com pricing and
// LiteLLM's table (they agree). [input, output, cache-read multiplier]
const rates = (model: string | null) => {
  const p = pricingForCodexModel(model);
  return [p.inputPerMillion, p.outputPerMillion, p.cacheReadMultiplier ?? 0.1];
};

test('pricingForCodexModel covers the current OpenAI tiers', () => {
  // GPT-6 family — gpt-6.1-sol reads cache at 0.05x.
  assert.deepStrictEqual(rates('gpt-6.1-sol'), [2, 10, 0.05]);
  assert.deepStrictEqual(rates('gpt-6-sol'), [2, 10, 0.1]);
  assert.deepStrictEqual(rates('gpt-6-astra'), [10, 50, 0.1]);
  assert.deepStrictEqual(rates('gpt-6-luna'), [0.1, 0.5, 0.1]);
  // GPT-5.6 family.
  assert.deepStrictEqual(rates('gpt-5.6-sol'), [4, 20, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.6-terra'), [2, 12, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.6-luna'), [0.2, 1.2, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.6-cyber'), [12.5, 75, 0.1]);
  // Codex's auto-review alias bills like gpt-5.6-luna.
  assert.deepStrictEqual(rates('codex-auto-review'), [0.2, 1.2, 0.1]);
  // Older generations.
  assert.deepStrictEqual(rates('gpt-5.5'), [5, 30, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.5-pro-2026-04-23'), [30, 180, 1]);
  assert.deepStrictEqual(rates('gpt-5.4'), [2.5, 15, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.4-mini'), [0.75, 4.5, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.4-nano'), [0.2, 1.25, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.3-codex'), [1.75, 14, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.2-codex'), [1.75, 14, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.2'), [1.75, 14, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.2-pro'), [21, 168, 1]);
  assert.deepStrictEqual(rates('gpt-5.1-codex-max'), [1.25, 10, 0.1]);
  assert.deepStrictEqual(rates('gpt-5.1-codex'), [1.25, 10, 0.1]);
  assert.deepStrictEqual(rates('gpt-5-codex'), [1.25, 10, 0.1]);
  assert.deepStrictEqual(rates('gpt-5'), [1.25, 10, 0.1]);
  assert.deepStrictEqual(rates('gpt-5-mini'), [0.25, 2, 0.1]);
  assert.deepStrictEqual(rates('gpt-5-nano'), [0.05, 0.4, 0.1]);
  assert.deepStrictEqual(rates('gpt-5-pro'), [15, 120, 1]);
  assert.deepStrictEqual(rates('codex-mini-latest'), [1.5, 6, 0.25]);
  assert.deepStrictEqual(rates('o3'), [2, 8, 0.25]);
  assert.deepStrictEqual(rates('o3-2025-04-16'), [2, 8, 0.25]);
  assert.deepStrictEqual(rates('o3-mini'), [1.1, 4.4, 0.5]);
  assert.deepStrictEqual(rates('o3-pro'), [20, 80, 1]);
  assert.deepStrictEqual(rates('o4-mini'), [1.1, 4.4, 0.25]);
  assert.deepStrictEqual(rates('gpt-4.1'), [2, 8, 0.25]);
  assert.deepStrictEqual(rates('gpt-4.1-mini'), [0.4, 1.6, 0.25]);
  assert.deepStrictEqual(rates('gpt-4.1-nano'), [0.1, 0.4, 0.25]);
});

test('unknown / null ids fall back to the gpt-6-sol flagship (over-count, never vanish)', () => {
  assert.deepStrictEqual(rates('gpt-6-something-new'), [2, 10, 0.1]);
  assert.deepStrictEqual(rates('gpt-7-nova'), [2, 10, 0.1]);
  assert.deepStrictEqual(rates(null), [2, 10, 0.1]);
});

test('long-context tier: >272K prompt bills input 2x / output 1.5x', () => {
  const usage = (o: object) => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreationBreakdown: null,
    ...o,
  });
  const approx = (a: number, e: number) =>
    assert.ok(Math.abs(a - e) < 1e-12, `expected ${e}, got ${a}`);
  // At the threshold: base rates.
  approx(
    costForEntry(
      usage({
        inputTokens: 72_000,
        cacheReadInputTokens: 200_000,
        outputTokens: 1_000,
      }),
      'gpt-6-sol',
      pricingForCodexModel
    ),
    (72_000 * 2 + 200_000 * 0.2 + 1_000 * 10) / 1e6
  );
  // One token over: 4/0.4/15.
  approx(
    costForEntry(
      usage({
        inputTokens: 72_001,
        cacheReadInputTokens: 200_000,
        outputTokens: 1_000,
      }),
      'gpt-6-sol',
      pricingForCodexModel
    ),
    (72_001 * 4 + 200_000 * 0.4 + 1_000 * 15) / 1e6
  );
  // promptTokens (the request's own prompt) overrides the summed fields — a
  // Codex delta spanning two small requests must not trip the tier.
  approx(
    costForEntry(
      usage({ inputTokens: 300_000, promptTokens: 150_000 }),
      'gpt-6-sol',
      pricingForCodexModel
    ),
    (300_000 * 2) / 1e6
  );
  // Models without a tier never reprice.
  approx(
    costForEntry(
      usage({ inputTokens: 1e6 }),
      'gpt-5.3-codex',
      pricingForCodexModel
    ),
    1.75
  );
});

test('cache writes bill at 1.25x input', () => {
  const cost = costForEntry(
    {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 100_000,
      cacheCreationBreakdown: null,
    },
    'gpt-6-sol',
    pricingForCodexModel
  );
  assert.ok(Math.abs(cost - 0.25) < 1e-12);
});

test('costForEntry uses the injected resolver and cached-read 10% math', () => {
  const usage = {
    inputTokens: 600,
    outputTokens: 100,
    cacheReadInputTokens: 400,
    cacheCreationInputTokens: 0,
    cacheCreationBreakdown: null,
  };
  const cost = costForEntry(usage, 'gpt-5-codex', pricingForCodexModel);
  // 600*1.25 + 100*10 + 400*(1.25*0.1) = 750 + 1000 + 50 = 1800 / 1e6
  assert.ok(Math.abs(cost - 1800 / 1_000_000) < 1e-12);
});

test('codex size tiers beat the bare codex match (gpt-5.1-codex-mini)', () => {
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.1-codex-mini'), {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
  });
  // The full codex model is unaffected.
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.1-codex'), {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  });
});
