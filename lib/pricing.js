'use strict';

/**
 * Per-1M-token USD pricing keyed off the model id by substring,
 * first match wins (order matters). Port of Pricing.swift.
 *
 * Rates verified 2026-07 against the Anthropic published per-model pricing
 * (see the claude-api model table): Fable/Mythos 5 $10/$50, Opus 4.5–4.8
 * $5/$25, Sonnet 4.6/5 $3/$15, Haiku 4.5 $1/$5. Older Opus 4.0/4.1 were
 * $15/$75 and are special-cased below.
 *
 * NOTE (unverified): Claude Sonnet 5 has an introductory rate of $2/$10 in
 * effect through 2026-08-31. We keep the $3/$15 sticker price here because the
 * reference tools we drift-check against (ccusage / `/cost`, which read
 * LiteLLM's price table) use the sticker price, not the promo — matching them
 * matters more than the promo. Revisit if the reference tools adopt the promo.
 */
function pricingForModel(model) {
  const m = (model || '').toLowerCase();

  // Non-billable synthetic markers. Claude Code emits `<synthetic>` (and other
  // `<...>` placeholders) for locally generated assistant turns (API errors,
  // "prompt too long", interrupts). These are never billed by Anthropic, and
  // ccusage skips them outright — so they must cost $0 regardless of any token
  // counts they happen to carry. Falling through to the default rate would
  // silently over-count. A null/empty model id is left to the default below
  // (treated as an unknown real model), matching prior behaviour.
  if (m.startsWith('<')) {
    return { inputPerMillion: 0, outputPerMillion: 0 };
  }

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
  // Default for an unrecognised *real* model id (a new model not yet in this
  // table, or a null/missing id). We assume Opus-tier ($5/$25) rather than $0
  // so a newly launched model over-counts slightly instead of silently
  // vanishing from the total. Add the model above when it ships.
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
