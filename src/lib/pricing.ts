'use strict';

/**
 * Per-1M-token USD pricing keyed off the model id by substring,
 * first match wins (order matters). Port of Pricing.swift.
 *
 * Rates verified 2026-10-11 against Anthropic's published pricing page
 * (platform.claude.com/docs/en/about-claude/pricing). Notable since 2026-07:
 *  - Opus 5.5 is $4/$20 and Sonnet 5.5 $2/$10, both with cache reads at
 *    0.05x input (not the usual 0.1x); Fable/Mythos 5.1 read at 0.025x.
 *  - Sonnet 5's $2/$10 launch price became the standard price (the planned
 *    move to $3/$15 on 2026-09-01 was cancelled).
 *  - Haiku 5.5 is $0.10/$0.50 for prompts up to 100K tokens and $0.50/$2.50
 *    above that (the whole request reprices, cache tokens included).
 *  - Fast mode (Opus 5.5 / 5 / 4.8, reported as `usage.speed: "fast"`) bills
 *    2x the standard rates; caching multipliers stack on top.
 * Cache writes stay 1.25x (5m) / 2x (1h) input on every model.
 */

/** Per-1M-token USD rates for a single model tier. */
export interface Pricing {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Cache-read rate as a fraction of input. Defaults to 0.1. */
  cacheReadMultiplier?: number;
  /** Rates that replace the base ones when the request's prompt (input +
   *  cache reads + cache writes) exceeds `thresholdTokens`. */
  longContext?: {
    thresholdTokens: number;
    inputPerMillion: number;
    outputPerMillion: number;
  };
  /** Multiplier applied to every token category when `usage.speed` is
   *  "fast". Absent = the model has no fast mode (bills standard). */
  fastMultiplier?: number;
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
  /** `usage.speed` from the log ("fast" | "standard"); absent = standard. */
  speed?: string | null;
  /** The request's prompt size, when the token fields above aggregate more
   *  than one request (Codex deltas). Decides `longContext` tiers; absent =
   *  input + cache reads + cache writes. */
  promptTokens?: number;
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
    // 5.1 keeps 5's $10/$50 but cuts cache reads from $1 to $0.25 (0.025x).
    if (m.includes('fable-5-1') || m.includes('mythos-5-1')) {
      return {
        inputPerMillion: 10,
        outputPerMillion: 50,
        cacheReadMultiplier: 0.025,
      };
    }
    return { inputPerMillion: 10, outputPerMillion: 50 };
  }
  if (m.includes('opus-5-5')) {
    return {
      inputPerMillion: 4,
      outputPerMillion: 20,
      cacheReadMultiplier: 0.05,
      fastMultiplier: 2,
    };
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
  if (m.includes('opus-5') || m.includes('opus-4-8')) {
    return { inputPerMillion: 5, outputPerMillion: 25, fastMultiplier: 2 };
  }
  if (m.includes('opus')) {
    return { inputPerMillion: 5, outputPerMillion: 25 };
  }
  if (m.includes('haiku-5-5')) {
    return {
      inputPerMillion: 0.1,
      outputPerMillion: 0.5,
      longContext: {
        thresholdTokens: 100_000,
        inputPerMillion: 0.5,
        outputPerMillion: 2.5,
      },
    };
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
  if (m.includes('sonnet-5-5')) {
    return {
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadMultiplier: 0.05,
    };
  }
  if (m.includes('sonnet-5')) {
    return { inputPerMillion: 2, outputPerMillion: 10 };
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
 * OpenAI's long-context tier: prompts over 272K tokens bill input (and with it
 * cache reads/writes) at 2x and output at 1.5x. Applies to gpt-5.4 onward.
 */
const openAiLongContext = (
  inputPerMillion: number,
  outputPerMillion: number
): Pricing['longContext'] => ({
  thresholdTokens: 272_000,
  inputPerMillion: inputPerMillion * 2,
  outputPerMillion: outputPerMillion * 1.5,
});

/** A gpt-5.4+ tier: base rates plus the matching long-context tier. */
const openAi = (
  inputPerMillion: number,
  outputPerMillion: number,
  extra: Partial<Pricing> = {}
): Pricing => ({
  inputPerMillion,
  outputPerMillion,
  longContext: openAiLongContext(inputPerMillion, outputPerMillion),
  ...extra,
});

/**
 * Per-1M-token USD pricing for the OpenAI model ids that appear in
 * `~/.codex/sessions` rollout logs, substring-matched, first match wins.
 * Cached input bills at `cacheReadMultiplier` x input (0.1 unless noted);
 * cache writes (gpt-5.6 / gpt-6) at 1.25x — see `costForEntry`.
 *
 * Rates verified 2026-10-11 against developers.openai.com/api/docs/pricing
 * and LiteLLM's price table (what ccusage reads); the two agree. Order
 * matters: more-specific ids (-pro, -mini, -codex, versioned) come first.
 */
export function pricingForCodexModel(
  model: string | null | undefined
): Pricing {
  const m = (model || '').toLowerCase();

  // Codex's Guardian auto-review subagent. A server-side alias with no
  // published price; it moved off gpt-5.4 to gpt-5.6-luna in CLI v0.146.1, so
  // bill it at luna rates (an estimate — it may be free on ChatGPT plans).
  if (m.includes('codex-auto-review')) return openAi(0.2, 1.2);

  // GPT-6 family (2026-09). gpt-6.1-sol reads cache at 0.05x, not 0.1x.
  if (m.includes('gpt-6')) {
    if (m.includes('astra')) return openAi(10, 50);
    if (m.includes('luna')) return openAi(0.1, 0.5);
    if (m.includes('gpt-6.1') || m.includes('gpt-6-1')) {
      return openAi(2, 10, { cacheReadMultiplier: 0.05 });
    }
    // Sol, and any gpt-6 id not yet in this table.
    return openAi(2, 10);
  }

  // GPT-5.6 family (2026-07). Sol's $4/$20 is promotional "at least through
  // 2026-11-21" — recheck the sticker price after that.
  if (m.includes('gpt-5.6') || m.includes('gpt-5-6')) {
    if (m.includes('cyber')) return openAi(12.5, 75);
    if (m.includes('terra')) return openAi(2, 12);
    if (m.includes('luna')) return openAi(0.2, 1.2);
    return openAi(4, 20);
  }

  // -pro models have no cached-input discount.
  if (m.includes('-pro')) {
    const noCache = { cacheReadMultiplier: 1 };
    if (m.includes('gpt-5.5') || m.includes('gpt-5.4')) {
      return openAi(30, 180, noCache);
    }
    if (m.includes('gpt-5.2')) {
      return { inputPerMillion: 21, outputPerMillion: 168, ...noCache };
    }
    if (m.includes('o3')) {
      return { inputPerMillion: 20, outputPerMillion: 80, ...noCache };
    }
    return { inputPerMillion: 15, outputPerMillion: 120, ...noCache };
  }

  if (m.includes('gpt-5.5') || m.includes('gpt-5-5')) {
    if (m.includes('cyber')) {
      return { inputPerMillion: 12.5, outputPerMillion: 75 };
    }
    return openAi(5, 30);
  }

  if (m.includes('gpt-5.4') || m.includes('gpt-5-4')) {
    if (m.includes('nano'))
      return { inputPerMillion: 0.2, outputPerMillion: 1.25 };
    if (m.includes('mini'))
      return { inputPerMillion: 0.75, outputPerMillion: 4.5 };
    return openAi(2.5, 15);
  }

  // gpt-5.2 / gpt-5.3 and their -codex variants share one tier.
  if (
    m.includes('gpt-5.3') ||
    m.includes('gpt-5-3') ||
    m.includes('gpt-5.2') ||
    m.includes('gpt-5-2')
  ) {
    return { inputPerMillion: 1.75, outputPerMillion: 14 };
  }

  // The o-series / gpt-4.1 / codex-mini-latest cache at 0.25x input.
  if (m.includes('codex-mini-latest')) {
    return {
      inputPerMillion: 1.5,
      outputPerMillion: 6,
      cacheReadMultiplier: 0.25,
    };
  }
  if (m.includes('o3-mini')) {
    return {
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
      cacheReadMultiplier: 0.5,
    };
  }
  if (m.includes('o4-mini')) {
    return {
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
      cacheReadMultiplier: 0.25,
    };
  }
  if (/(^|[^a-z0-9])o3($|-)/.test(m)) {
    return {
      inputPerMillion: 2,
      outputPerMillion: 8,
      cacheReadMultiplier: 0.25,
    };
  }
  if (m.includes('gpt-4.1')) {
    const cacheReadMultiplier = 0.25;
    if (m.includes('nano')) {
      return {
        inputPerMillion: 0.1,
        outputPerMillion: 0.4,
        cacheReadMultiplier,
      };
    }
    if (m.includes('mini')) {
      return {
        inputPerMillion: 0.4,
        outputPerMillion: 1.6,
        cacheReadMultiplier,
      };
    }
    return { inputPerMillion: 2, outputPerMillion: 8, cacheReadMultiplier };
  }

  // gpt-5 / gpt-5.1 (incl. -codex, -codex-max) and their size tiers.
  if (m.includes('nano'))
    return { inputPerMillion: 0.05, outputPerMillion: 0.4 };
  if (m.includes('mini')) return { inputPerMillion: 0.25, outputPerMillion: 2 };
  if (m.includes('gpt-5'))
    return { inputPerMillion: 1.25, outputPerMillion: 10 };

  // Unrecognised id (a brand-new model, or null): bill at the current Codex
  // flagship (gpt-6-sol) so it over-counts slightly instead of vanishing from
  // the total. Add the model above when it ships.
  return openAi(2, 10);
}

/**
 * USD cost for a single usage entry.
 * Cache reads bill at `cacheReadMultiplier` x input (0.1 unless the model
 * says otherwise); cache writes are 1.25x (5m) / 2x (1h). A model with a
 * `longContext` tier reprices the whole request once its prompt crosses the
 * threshold, and `fastMultiplier` scales everything for fast-mode requests.
 *
 * `pricing` selects the per-model rate table: it defaults to the Claude table
 * (`pricingForModel`) so every existing caller is unchanged, and the Codex path
 * passes `pricingForCodexModel`. The cache math is provider-agnostic; Codex
 * simply never supplies a cache-creation breakdown, so those terms are zero.
 */
export function costForEntry(
  usage: Usage,
  model: string | null | undefined,
  pricing: (m: string | null | undefined) => Pricing = pricingForModel
): number {
  const p = pricing(model);
  let inRate = p.inputPerMillion;
  let outRate = p.outputPerMillion;

  const promptTokens =
    usage.promptTokens ??
    usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens;
  if (p.longContext && promptTokens > p.longContext.thresholdTokens) {
    inRate = p.longContext.inputPerMillion;
    outRate = p.longContext.outputPerMillion;
  }

  let total = 0;
  total += usage.inputTokens * inRate;
  total += usage.outputTokens * outRate;
  total +=
    usage.cacheReadInputTokens * (inRate * (p.cacheReadMultiplier ?? 0.1));

  if (usage.cacheCreationBreakdown) {
    total +=
      usage.cacheCreationBreakdown.ephemeral5mInputTokens * (inRate * 1.25);
    total +=
      usage.cacheCreationBreakdown.ephemeral1hInputTokens * (inRate * 2.0);
  } else {
    total += usage.cacheCreationInputTokens * (inRate * 1.25);
  }

  if (usage.speed === 'fast' && p.fastMultiplier) total *= p.fastMultiplier;

  return total / 1_000_000;
}
