'use strict';

import type { DailySnapshot, ToolingState } from './analytics-store';

/**
 * Optimization Score (0-100) and net-savings math for the "Optimize" release.
 *
 * The Score is a deterministic, weighted blend of local signals — it is the
 * v1, honest proxy for "are you spending well" (the true effectiveness ratio
 * needs rework/sustained-value signals we can't measure locally, and ships
 * later as a clearly-labeled beta — see the plan). It is a SECONDARY drawer
 * stat; the headline number is net dollars saved (netSavings below).
 *
 * netSavings only ever fires the green "save" animation on a NET win —
 * grossSaved minus stillSpent — so a tool that "saves" $2 but the session
 * still spent $5 net never celebrates.
 */

export interface ScoreWeights {
  cacheOn: number;
  toolingActive: number;
  sessionDiscipline: number;
  routingSanity: number;
  noGiantPastes: number;
  lowIdleCacheWaste: number;
}

// Cache hit rate is the heaviest single lever (it's usually the cheapest win
// available), followed by having the tooling actually installed/active.
export const DEFAULT_WEIGHTS: ScoreWeights = {
  cacheOn: 35,
  toolingActive: 25,
  sessionDiscipline: 15,
  routingSanity: 10,
  noGiantPastes: 10,
  lowIdleCacheWaste: 5,
};

function clamp01(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

/** Fraction of output tokens on Opus/Fable-tier models. */
function heavyModelShare(snapshot: DailySnapshot): number {
  let total = 0;
  let heavy = 0;
  for (const [model, m] of Object.entries(snapshot.perModel)) {
    total += m.outTok;
    const lower = model.toLowerCase();
    if (
      lower.includes('opus') ||
      lower.includes('fable') ||
      lower.includes('mythos')
    ) {
      heavy += m.outTok;
    }
  }
  return total > 0 ? heavy / total : 0;
}

export interface OptimizationScoreInput {
  snapshot: DailySnapshot;
  toolingState: ToolingState;
  /** Count of giant-paste occurrences today (from habits.ts). */
  giantPasteCount?: number;
  /** Count of stale-cache-idle occurrences today (from habits.ts). */
  staleCacheIdleCount?: number;
}

/**
 * Deterministic weighted blend, 0-100. Each sub-score is clamped to [0,1]
 * before weighting so a single bad input can't overflow/underflow the total.
 */
export function optimizationScore({
  snapshot,
  toolingState,
  giantPasteCount = 0,
  staleCacheIdleCount = 0,
}: OptimizationScoreInput): number {
  const w = DEFAULT_WEIGHTS;

  const cacheOnScore = clamp01(snapshot.cache.hitRatio);

  const toolsInstalled = [
    toolingState.rtk.installed,
    toolingState.caveman.installed,
    toolingState.ponytail.installed,
  ].filter(Boolean).length;
  const toolingActiveScore = toolsInstalled / 3;

  // Session discipline: 1.0 at/under 100k tokens of context, tapering to 0
  // by 300k — no context that size ever reads as "fine".
  const sessionDisciplineScore = clamp01(
    1 - Math.max(0, snapshot.sessions.maxContextTokens - 100_000) / 200_000
  );

  // Routing sanity: not a verdict on model choice, just distance from a
  // "mostly-heavy" mix — 1.0 at 0% heavy share, 0 at 100% heavy share.
  const routingSanityScore = clamp01(1 - heavyModelShare(snapshot));

  // No giant pastes: full marks with zero, tapering off after a couple.
  const noGiantPastesScore = clamp01(1 - giantPasteCount / 3);

  // Low idle-cache waste: full marks with zero stale-cache-idle events.
  const lowIdleCacheWasteScore = clamp01(1 - staleCacheIdleCount / 3);

  const total =
    cacheOnScore * w.cacheOn +
    toolingActiveScore * w.toolingActive +
    sessionDisciplineScore * w.sessionDiscipline +
    routingSanityScore * w.routingSanity +
    noGiantPastesScore * w.noGiantPastes +
    lowIdleCacheWasteScore * w.lowIdleCacheWaste;

  return Math.round(clamp01(total / 100) * 100);
}

/**
 * Net savings = grossSaved - stillSpent. The green "save" animation must
 * only ever fire on a strictly positive NET win — never on a gross saving
 * that a subsequent spend eats into.
 */
export function netSavings(
  grossSavedUSD: number,
  stillSpentUSD: number
): number {
  const gross = isFinite(grossSavedUSD) ? Math.max(0, grossSavedUSD) : 0;
  const spent = isFinite(stillSpentUSD) ? Math.max(0, stillSpentUSD) : 0;
  return gross - spent;
}

/** Parsed result of `rtk gain` — RTK reports an authoritative TOKEN count
 *  saved; the USD figure below is a pricing-based conversion of it, not a raw
 *  dollar amount RTK hands us. */
export interface RtkGainResult {
  savedUSD: number;
}

/**
 * Parse the JSON produced by `rtk gain --all --format json` (empirically
 * confirmed shape: `{ summary: { total_saved: <tokens>, ... }, daily: [...] }`).
 * RTK reports TOKENS saved (`summary.total_saved`), never a USD figure, so the
 * returned `savedUSD` is a conversion priced at the input rate (RTK-saved
 * tokens are context/input-side, and input rate is the conservative choice).
 * The top-level USD/token field checks are kept for forward-compat with any
 * future RTK output shape. Returns null if nothing usable is present.
 */
export function parseRtkGainJson(
  json: unknown,
  pricingForModelFn?: (model: string | null | undefined) => {
    inputPerMillion: number;
    outputPerMillion: number;
  }
): RtkGainResult | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;

  // Forward-compat: an explicit USD/cost field if a future RTK reports one.
  const usdFieldNames = [
    'savedUSD',
    'saved_usd',
    'totalSavedUSD',
    'costSavedUSD',
    'savings',
  ];
  for (const field of usdFieldNames) {
    const v = obj[field];
    if (typeof v === 'number' && isFinite(v)) return { savedUSD: v };
  }

  // Convert a saved-TOKEN count to USD at the input rate. Real RTK nests it at
  // summary.total_saved; the top-level names are forward-compat fallbacks.
  // Model is unknown here, so pricingForModel(null) uses its default rate.
  const summary =
    obj.summary && typeof obj.summary === 'object'
      ? (obj.summary as Record<string, unknown>)
      : {};
  const tokensSaved =
    summary.total_saved ?? obj.tokensSaved ?? obj.tokens_saved;
  if (
    typeof tokensSaved === 'number' &&
    isFinite(tokensSaved) &&
    pricingForModelFn
  ) {
    const pricing = pricingForModelFn(null);
    return { savedUSD: (tokensSaved * pricing.inputPerMillion) / 1_000_000 };
  }

  return null;
}

/**
 * Parse `rtk gain --all --format json`'s `daily: [{date, saved_tokens}]` into
 * a `date -> savedUSD` map (tokens priced at input rate, same conversion as
 * parseRtkGainJson). Dates are RTK's own UTC 'YYYY-MM-DD' strings; callers
 * key by local day, so a day-boundary skew is possible — acceptable for a
 * savings estimate shown alongside spend. Empty map if nothing usable.
 */
export function parseRtkDailySavings(
  json: unknown,
  pricingForModelFn: (model: string | null | undefined) => {
    inputPerMillion: number;
    outputPerMillion: number;
  }
): Record<string, number> {
  const out: Record<string, number> = {};
  if (!json || typeof json !== 'object') return out;
  const daily = (json as Record<string, unknown>).daily;
  if (!Array.isArray(daily)) return out;
  const inRate = pricingForModelFn(null).inputPerMillion;
  for (const row of daily) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    const date = typeof r.date === 'string' ? r.date : null;
    const tokens = r.saved_tokens ?? r.savedTokens;
    if (date && typeof tokens === 'number' && isFinite(tokens)) {
      out[date] = (tokens * inRate) / 1_000_000;
    }
  }
  return out;
}

/**
 * Parse the plain-text `rtk gain` output for a USD savings figure. Kept as a
 * defensive fallback alongside parseRtkGainJson in case the CLI ever prints
 * plain text (e.g. no --format flag support on an older RTK build): looks for
 * the first "$<number>" near a "sav" (saved/savings) mention.
 */
export function parseRtkGainOutput(output: string): RtkGainResult | null {
  if (typeof output !== 'string' || !output) return null;
  const lines = output.split('\n');
  for (const line of lines) {
    if (!/sav/i.test(line)) continue;
    const match = line.match(/\$([0-9]+(?:\.[0-9]+)?)/);
    if (match) {
      const value = Number(match[1]);
      if (isFinite(value)) return { savedUSD: value };
    }
  }
  return null;
}

/** A conservative estimated savings RANGE for tools whose attribution is
 *  fuzzy (Caveman, Ponytail) — shown as a range, never a hard number. */
export interface EstimatedSavingsRange {
  lowUSD: number;
  highUSD: number;
}

/**
 * Conservative estimate: a tool is credited with `lowFraction`..`highFraction`
 * of the baseline spend rate it was installed against, scaled by the cost
 * incurred since install. Deliberately wide and low so we never over-claim a
 * saving we can't attribute cleanly (per the plan's Phase 2 note on
 * effectiveness-ratio being out of scope for v1).
 */
export function estimateToolSavingsRange(
  costSinceInstallUSD: number,
  {
    lowFraction = 0.03,
    highFraction = 0.12,
  }: { lowFraction?: number; highFraction?: number } = {}
): EstimatedSavingsRange {
  const cost = isFinite(costSinceInstallUSD)
    ? Math.max(0, costSinceInstallUSD)
    : 0;
  return {
    lowUSD: Math.round(cost * lowFraction * 100) / 100,
    highUSD: Math.round(cost * highFraction * 100) / 100,
  };
}

// Published per-tool effects, applied to only the fraction of spend the tool
// realistically touches. ponytail: these are population estimates, NOT
// measured per-user — treat as a calibration knob, tune if we ever get
// per-user attribution.
const CAVEMAN_OUTPUT_CUT = 0.65; // Caveman cuts OUTPUT tokens ~65% (prose turns)
const PONYTAIL_COST_CUT = 0.47; // Ponytail cost ▼47% low end (code tasks)
const APPLICABLE_SHARE = 0.15; // fraction of spend a plugin realistically touches

/** One day's per-tool savings: RTK is real (priced daily tokens), Caveman /
 *  Ponytail are conservative estimates. `total` is clamped to the day's spend
 *  (never show saved > spent); `hasEstimate` is true when an estimated portion
 *  contributed, so the UI can mark the figure `≈`. */
export interface DayToolSavings {
  rtkReal: number;
  cavemanEst: number;
  ponytailEst: number;
  total: number;
  hasEstimate: boolean;
}

/**
 * Per-day savings across the three tools. Each tool contributes 0 unless
 * installed. RTK's figure is the real per-day saved-token value (already
 * priced, passed in as `rtkRealUSD`); Caveman is credited an applicable share
 * of that day's OUTPUT-token cost, Ponytail an applicable share of that day's
 * TOTAL cost. The combined total is clamped to the day's spend.
 */
export function estimateDailyToolSavings({
  snapshot,
  toolingState,
  rtkRealUSD,
  pricingForModelFn,
}: {
  snapshot: DailySnapshot;
  toolingState: ToolingState;
  rtkRealUSD: number;
  pricingForModelFn: (model: string | null | undefined) => {
    inputPerMillion: number;
    outputPerMillion: number;
  };
}): DayToolSavings {
  const totalCost = isFinite(snapshot.costUSD)
    ? Math.max(0, snapshot.costUSD)
    : 0;

  let outputCost = 0;
  for (const [model, m] of Object.entries(snapshot.perModel)) {
    outputCost += (m.outTok * pricingForModelFn(model).outputPerMillion) / 1e6;
  }

  const rtkReal =
    toolingState.rtk.installed && isFinite(rtkRealUSD)
      ? Math.max(0, rtkRealUSD)
      : 0;
  const cavemanEst = toolingState.caveman.installed
    ? CAVEMAN_OUTPUT_CUT * APPLICABLE_SHARE * outputCost
    : 0;
  const ponytailEst = toolingState.ponytail.installed
    ? PONYTAIL_COST_CUT * APPLICABLE_SHARE * totalCost
    : 0;

  const raw = rtkReal + cavemanEst + ponytailEst;
  return {
    rtkReal,
    cavemanEst,
    ponytailEst,
    total: Math.min(raw, totalCost), // never show saved > spent
    hasEstimate: cavemanEst > 0 || ponytailEst > 0,
  };
}
