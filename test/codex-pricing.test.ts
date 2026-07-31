'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import { pricingForCodexModel, costForEntry } from '../src/lib/pricing';

// Codex-family rates, verified 2026-07. Keeps the tool aligned with the
// published OpenAI API pricing / the reference usage tools.
test('pricingForCodexModel covers the Codex-family tiers', () => {
  assert.deepStrictEqual(pricingForCodexModel('gpt-5-codex'), {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.1-codex'), {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.3-codex'), {
    inputPerMillion: 1.75,
    outputPerMillion: 14,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5'), {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5-mini'), {
    inputPerMillion: 0.25,
    outputPerMillion: 2,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5-nano'), {
    inputPerMillion: 0.05,
    outputPerMillion: 0.4,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.5'), {
    inputPerMillion: 5,
    outputPerMillion: 30,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.6-terra'), {
    inputPerMillion: 2.5,
    outputPerMillion: 15,
  });
  assert.deepStrictEqual(pricingForCodexModel('gpt-5.6-luna'), {
    inputPerMillion: 1,
    outputPerMillion: 6,
  });
});

test('unknown gpt-* / null falls back to the codex base tier (over-count, never vanish)', () => {
  assert.deepStrictEqual(pricingForCodexModel('gpt-6-something-new'), {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  });
  assert.deepStrictEqual(pricingForCodexModel(null), {
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  });
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
