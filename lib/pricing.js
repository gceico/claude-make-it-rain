'use strict';

/**
 * Per-1M-token USD pricing keyed off the model id by substring,
 * first match wins (order matters). Port of Pricing.swift.
 */
function pricingForModel(model) {
  const m = (model || '').toLowerCase();

  if (m.includes('fable') || m.includes('mythos')) {
    return { inputPerMillion: 10, outputPerMillion: 50 };
  }
  if (
    m.includes('opus-4-1') || m.includes('opus-4-2') ||
    m.includes('claude-opus-4-0') || m.includes('claude-opus-4-2025')
  ) {
    return { inputPerMillion: 15, outputPerMillion: 75 };
  }
  if (m.includes('opus')) {
    return { inputPerMillion: 5, outputPerMillion: 25 };
  }
  if (m.includes('haiku-3') || m.includes('3-5-haiku')) {
    return { inputPerMillion: 0.8, outputPerMillion: 4 };
  }
  if (m.includes('haiku')) {
    return { inputPerMillion: 1, outputPerMillion: 5 };
  }
  if (m.includes('sonnet')) {
    return { inputPerMillion: 3, outputPerMillion: 15 };
  }
  // default (unknown)
  return { inputPerMillion: 5, outputPerMillion: 25 };
}

/**
 * USD cost for a single usage entry.
 * Cache reads are 10% of the input rate; cache writes are 1.25x (5m) / 2x (1h).
 *
 * @param {{inputTokens: number, outputTokens: number,
 *          cacheReadInputTokens: number, cacheCreationInputTokens: number,
 *          cacheCreationBreakdown: ?{ephemeral5mInputTokens: number, ephemeral1hInputTokens: number}}} usage
 * @param {?string} model
 */
function costForEntry(usage, model) {
  const p = pricingForModel(model);
  const inRate = p.inputPerMillion;
  const outRate = p.outputPerMillion;

  let total = 0;
  total += usage.inputTokens * inRate;
  total += usage.outputTokens * outRate;
  total += usage.cacheReadInputTokens * (inRate * 0.1);

  if (usage.cacheCreationBreakdown) {
    total += usage.cacheCreationBreakdown.ephemeral5mInputTokens * (inRate * 1.25);
    total += usage.cacheCreationBreakdown.ephemeral1hInputTokens * (inRate * 2.0);
  } else {
    total += usage.cacheCreationInputTokens * (inRate * 1.25);
  }

  return total / 1_000_000;
}

module.exports = { pricingForModel, costForEntry };
