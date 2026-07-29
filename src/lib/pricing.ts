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

/** Per-1M-token USD rates for a single model tier. */
export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

/** Split ephemeral cache-creation token counts (5-minute vs 1-hour TTL). */
export interface CacheCreationBreakdown {
  ephemeral5mInputTokens: number;
  ephemeral1hInputTokens: number;
}

/** Normalized usage numbers for one assistant entry, shaped for costForEntry. */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  cacheCreationBreakdown: CacheCreationBreakdown | null;
}

export function pricingForModel(model: string | null | undefined): Pricing {
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
    m.includes('opus-4-1') ||
    // 'opus-4-2' catches the date-suffixed legacy ids (claude-opus-4-20250514);
    // a future "Opus 4.2" would also land here — re-tier it if that ships.
    m.includes('opus-4-2') ||
    m.includes('claude-opus-4-0')
  ) {
    return { inputPerMillion: 15, outputPerMillion: 75 };
  }
  if (m.includes('opus')) {
    return { inputPerMillion: 5, outputPerMillion: 25 };
  }
  if (m.includes('3-5-haiku')) {
    return { inputPerMillion: 0.8, outputPerMillion: 4 };
  }
  // claude-3-haiku-20240307 contains '3-haiku' (but not '3-5-haiku'); its rate
  // is $0.25/$1.25, distinct from Haiku 3.5's $0.8/$4 above.
  if (m.includes('3-haiku')) {
    return { inputPerMillion: 0.25, outputPerMillion: 1.25 };
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
 * Per-1M-token USD pricing for OpenAI's Codex-family models (the model ids that
 * appear in `~/.codex/sessions` rollout logs), substring-matched, first match
 * wins. Cached input is billed by `costForEntry` at 10% of the input rate — the
 * same cache-read treatment Codex's `cached_input_tokens` needs — so only
 * input/output rates live here.
 *
 * Rates verified 2026-07 against the published OpenAI API pricing / the
 * reference usage tools (ccusage's LiteLLM table). Order matters: the
 * more-specific `-codex` / version-suffixed ids must precede the bare `gpt-5`.
 */
export function pricingForCodexModel(
  model: string | null | undefined
): Pricing {
  const m = (model || '').toLowerCase();

  // Codex-tuned models. gpt-5.3-codex is the pricier tier; gpt-5-codex and
  // gpt-5.1-codex share the base codex rate.
  if (m.includes('gpt-5.3-codex') || m.includes('gpt-5-3-codex')) {
    return { inputPerMillion: 1.75, outputPerMillion: 14 };
  }
  if (m.includes('codex')) {
    // gpt-5-codex / gpt-5.1-codex / future codex ids without their own tier.
    return { inputPerMillion: 1.25, outputPerMillion: 10 };
  }

  // GPT-5.6 family (Sol / Terra / Luna), launched 2026-07.
  if (m.includes('gpt-5.6') || m.includes('gpt-5-6')) {
    if (m.includes('terra'))
      return { inputPerMillion: 2.5, outputPerMillion: 15 };
    if (m.includes('luna')) return { inputPerMillion: 1, outputPerMillion: 6 };
    // Sol (flagship) and any unlabelled 5.6 id.
    return { inputPerMillion: 5, outputPerMillion: 30 };
  }

  if (m.includes('gpt-5.5') || m.includes('gpt-5-5')) {
    return { inputPerMillion: 5, outputPerMillion: 30 };
  }

  if (m.includes('gpt-5.4') || m.includes('gpt-5-4')) {
    if (m.includes('nano'))
      return { inputPerMillion: 0.2, outputPerMillion: 1.25 };
    if (m.includes('mini'))
      return { inputPerMillion: 0.75, outputPerMillion: 4.5 };
    // Bare gpt-5.4 (full) — priced at the codex/base flagship tier.
    return { inputPerMillion: 1.25, outputPerMillion: 10 };
  }

  if (m.includes('nano')) {
    return { inputPerMillion: 0.05, outputPerMillion: 0.4 };
  }
  if (m.includes('mini')) {
    return { inputPerMillion: 0.25, outputPerMillion: 2 };
  }

  // Bare gpt-5 (and the default for any unrecognised gpt-* / null id): the
  // base flagship rate. As with the Claude table we over-count a brand-new
  // model rather than let it vanish from the total; add it above when it ships.
  return { inputPerMillion: 1.25, outputPerMillion: 10 };
}

/**
 * USD cost for a single usage entry.
 * Cache reads are 10% of the input rate; cache writes are 1.25x (5m) / 2x (1h).
 *
 * `pricing` selects the per-model rate table: it defaults to the Claude table
 * (`pricingForModel`) so every existing caller is unchanged, and the Codex path
 * passes `pricingForCodexModel`. The cache-read (10% of input) and cache-write
 * math is provider-agnostic; Codex simply never supplies a cache-creation
 * breakdown, so those terms are zero for it.
 */
export function costForEntry(
  usage: Usage,
  model: string | null | undefined,
  pricing: (m: string | null | undefined) => Pricing = pricingForModel
): number {
  const p = pricing(model);
  const inRate = p.inputPerMillion;
  const outRate = p.outputPerMillion;

  let total = 0;
  total += usage.inputTokens * inRate;
  total += usage.outputTokens * outRate;
  total += usage.cacheReadInputTokens * (inRate * 0.1);

  if (usage.cacheCreationBreakdown) {
    total +=
      usage.cacheCreationBreakdown.ephemeral5mInputTokens * (inRate * 1.25);
    total +=
      usage.cacheCreationBreakdown.ephemeral1hInputTokens * (inRate * 2.0);
  } else {
    total += usage.cacheCreationInputTokens * (inRate * 1.25);
  }

  return total / 1_000_000;
}
