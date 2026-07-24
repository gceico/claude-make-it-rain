'use strict';

import type { DailySnapshot, ToolingState } from './analytics-store';
import { localDayIndex } from './equivalences';

/**
 * Deterministic, local-only habit-detection engine for the "Optimize"
 * release. Every detector is a pure function of already-collected,
 * privacy-safe inputs (aggregated token/cost/cache numbers, tool-install
 * state, and userTextLength — never raw prompt text). Copy is neutral-coach
 * ("Caching is off — flip it on for a free win"), never a roast: intent is
 * unknowable from these numbers, so we suggest, never judge.
 *
 * `habitOfTheDay(now)` deterministically rotates ONE habit per day (mirrors
 * `equivalences.ts`'s `localDayIndex` rotation) so the tray surfaces a single
 * coach tip instead of overwhelming the user with every detector; the rest
 * live in a drawer with their `habitCounts` (see analytics-store.ts).
 */

export type HabitSeverity = 'info' | 'low' | 'medium' | 'high';

/** One user turn's shape metrics — text LENGTH only, never the text itself. */
export interface UserTurnEvent {
  sessionId: string | null;
  userTextLength: number;
  timestampMs: number;
}

/** One >5-minute idle gap observed within a session, and whether a cache
 *  rebuild followed it. */
export interface SessionGapEvent {
  sessionId: string;
  gapMs: number;
  cacheCreationTokensAfterGap: number;
}

/** Everything a detector needs, all already privacy-safe/local aggregates. */
export interface HabitInput {
  snapshot: DailySnapshot;
  toolingState: ToolingState;
  userTurns: UserTurnEvent[];
  sessionGaps: SessionGapEvent[];
}

export interface HabitResult {
  id: string;
  severity: HabitSeverity;
  /** Whether this habit's condition is currently present. */
  triggered: boolean;
  /** How many times this occurrence has been observed (for the drawer). */
  count: number;
  /** Neutral-coach copy, ready to show in the tray. */
  coachCopy: string;
}

export type HabitDetector = (input: HabitInput) => HabitResult;

// ── Tunable thresholds (kept together so they're easy to eyeball/tune) ─────
const CACHE_OFF_HIT_RATIO = 0.05;
const MODEL_SKEW_SHARE = 0.7; // opus+fable share of output tokens
const LONG_SESSION_TOKENS = 150_000;
const STALE_GAP_MS = 5 * 60 * 1000;
const STALE_CACHE_SPIKE_TOKENS = 10_000;
const GIANT_PASTE_CHARS = 20_000; // ~a very large single paste
const RAGE_RETRY_WINDOW_MS = 3 * 60 * 1000;
const RAGE_RETRY_MIN_COUNT = 3;
const RAGE_RETRY_SIZE_TOLERANCE = 0.2; // ±20% counts as "similar size"

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function totalOutputTokens(snapshot: DailySnapshot): number {
  let total = 0;
  for (const m of Object.values(snapshot.perModel)) total += m.outTok;
  return total;
}

function heavyModelOutputTokens(snapshot: DailySnapshot): number {
  let total = 0;
  for (const [model, m] of Object.entries(snapshot.perModel)) {
    const lower = model.toLowerCase();
    if (
      lower.includes('opus') ||
      lower.includes('fable') ||
      lower.includes('mythos')
    ) {
      total += m.outTok;
    }
  }
  return total;
}

// ── Detectors: tokens / model / timing ──────────────────────────────────────

export const cachingOff: HabitDetector = ({ snapshot }) => {
  const totalCacheTok = snapshot.cache.readTok + snapshot.cache.creationTok;
  const triggered =
    totalCacheTok > 0 && snapshot.cache.hitRatio < CACHE_OFF_HIT_RATIO;
  return {
    id: 'caching-off',
    severity: 'high',
    triggered,
    count: triggered ? 1 : 0,
    coachCopy: triggered
      ? `Caching is off (${pct(snapshot.cache.hitRatio)} hit rate)`
      : `Cache hit rate looks healthy (${pct(snapshot.cache.hitRatio)}).`,
  };
};

export const modelSkew: HabitDetector = ({ snapshot }) => {
  const total = totalOutputTokens(snapshot);
  const heavy = heavyModelOutputTokens(snapshot);
  const share = total > 0 ? heavy / total : 0;
  const triggered = total > 0 && share > MODEL_SKEW_SHARE;
  return {
    id: 'model-skew',
    severity: 'medium',
    triggered,
    count: triggered ? 1 : 0,
    // Framed as a suggestion, never a verdict — intent is unknowable from
    // token counts alone.
    coachCopy: triggered
      ? `${pct(share)} of output came from heavier models`
      : `Model mix looks reasonable (${pct(share)} on heavier models).`,
  };
};

export const longSessions: HabitDetector = ({ snapshot }) => {
  const triggered = snapshot.sessions.maxContextTokens >= LONG_SESSION_TOKENS;
  return {
    id: 'long-sessions',
    severity: 'medium',
    triggered,
    count: triggered ? 1 : 0,
    coachCopy: triggered
      ? `A session crossed ${Math.round(snapshot.sessions.maxContextTokens / 1000)}k tokens of context`
      : 'Session lengths look under control.',
  };
};

export const staleCacheIdle: HabitDetector = ({ sessionGaps }) => {
  const hits = sessionGaps.filter(
    (g) =>
      g.gapMs >= STALE_GAP_MS &&
      g.cacheCreationTokensAfterGap >= STALE_CACHE_SPIKE_TOKENS
  );
  return {
    id: 'stale-cache-idle',
    severity: 'medium',
    triggered: hits.length > 0,
    count: hits.length,
    coachCopy:
      hits.length > 0
        ? `${hits.length} break${hits.length === 1 ? '' : 's'} of 5+ minutes forced a cache rebuild`
        : 'No costly idle-then-rebuild gaps detected today.',
  };
};

function toolMissingDetector(
  tool: keyof ToolingState,
  label: string
): HabitDetector {
  return ({ toolingState }) => {
    const triggered = !toolingState[tool].installed;
    return {
      id: `${tool}-missing`,
      severity: 'low',
      triggered,
      count: triggered ? 1 : 0,
      coachCopy: triggered
        ? `${label} isn't installed yet`
        : `${label} is installed.`,
    };
  };
}

export const rtkMissing = toolMissingDetector('rtk', 'RTK');
export const cavemanMissing = toolMissingDetector('caveman', 'Caveman');
export const ponytailMissing = toolMissingDetector('ponytail', 'Ponytail');

// ── Detectors: lightweight content metrics (userTextLength only) ───────────

export const giantPaste: HabitDetector = ({ userTurns }) => {
  const hits = userTurns.filter((t) => t.userTextLength >= GIANT_PASTE_CHARS);
  const biggest = hits.reduce((max, t) => Math.max(max, t.userTextLength), 0);
  return {
    id: 'giant-paste',
    severity: 'low',
    triggered: hits.length > 0,
    count: hits.length,
    coachCopy:
      hits.length > 0
        ? `A single paste ran ≈${Math.round(biggest / 1000)}k characters`
        : 'No outsized single pastes today.',
  };
};

export const rageRetry: HabitDetector = ({ userTurns }) => {
  // Conservative: look for RAGE_RETRY_MIN_COUNT+ turns of similar size within
  // a short rolling window in the SAME session — legitimate iteration tends
  // to vary in size or spread out more than this.
  const bySession = new Map<string, UserTurnEvent[]>();
  for (const t of userTurns) {
    if (!t.sessionId) continue;
    const arr = bySession.get(t.sessionId) || [];
    arr.push(t);
    bySession.set(t.sessionId, arr);
  }

  let clusters = 0;
  for (const turns of bySession.values()) {
    const sorted = [...turns].sort((a, b) => a.timestampMs - b.timestampMs);
    for (let i = 0; i < sorted.length; i++) {
      let clusterCount = 1;
      for (let j = i + 1; j < sorted.length; j++) {
        if (
          sorted[j]!.timestampMs - sorted[i]!.timestampMs >
          RAGE_RETRY_WINDOW_MS
        )
          break;
        const ratio =
          sorted[j]!.userTextLength / Math.max(1, sorted[i]!.userTextLength);
        if (Math.abs(ratio - 1) <= RAGE_RETRY_SIZE_TOLERANCE) clusterCount++;
      }
      if (clusterCount >= RAGE_RETRY_MIN_COUNT) {
        clusters++;
        break; // count once per session to avoid overlapping-window inflation
      }
    }
  }

  return {
    id: 'rage-retry',
    severity: 'low',
    triggered: clusters > 0,
    count: clusters,
    coachCopy:
      clusters > 0
        ? 'Several similar-sized prompts landed in a short window'
        : 'No rapid-retry bursts detected today.',
  };
};

// ── Detectors: always-on awareness facts (never "bad") ──────────────────────

export const modelSplit: HabitDetector = ({ snapshot }) => {
  const total = totalOutputTokens(snapshot);
  const heavy = heavyModelOutputTokens(snapshot);
  const share = total > 0 ? heavy / total : 0;
  return {
    id: 'model-split',
    severity: 'info',
    triggered: true,
    count: 1,
    coachCopy:
      total > 0
        ? `Model split: ${pct(share)} heavier / ${pct(1 - share)} lighter.`
        : 'No model usage yet today.',
  };
};

export const cacheRate: HabitDetector = ({ snapshot }) => ({
  id: 'cache-rate',
  severity: 'info',
  triggered: true,
  count: 1,
  coachCopy: `Cache hit rate: ${pct(snapshot.cache.hitRatio)}.`,
});

export const estimateAccuracy: HabitDetector = ({ snapshot }) => {
  // Sanity check: the whole-day cost should equal the sum of its per-model
  // buckets (both are derived from the same entries, so any drift here is a
  // real accounting bug, not measurement noise) — surfaced as a fact, not a
  // verdict, per the plan's "estimate accuracy" awareness stat.
  let recomputed = 0;
  for (const m of Object.values(snapshot.perModel)) recomputed += m.costUSD;
  const diff =
    snapshot.costUSD > 0
      ? Math.abs(recomputed - snapshot.costUSD) / snapshot.costUSD
      : 0;
  return {
    id: 'estimate-accuracy',
    severity: 'info',
    triggered: true,
    count: 1,
    coachCopy: `Estimate check: within ${pct(diff)} of the per-model breakdown.`,
  };
};

/** Every detector, in the plan's listed order. */
export const ALL_DETECTORS: HabitDetector[] = [
  cachingOff,
  modelSkew,
  longSessions,
  staleCacheIdle,
  rtkMissing,
  cavemanMissing,
  ponytailMissing,
  giantPaste,
  rageRetry,
  modelSplit,
  cacheRate,
  estimateAccuracy,
];

/** Run every detector against one input, in order. */
export function runHabitDetectors(input: HabitInput): HabitResult[] {
  return ALL_DETECTORS.map((d) => d(input));
}

/**
 * Deterministically rotate ONE "habit of the day" among the results that are
 * currently TRIGGERED (falls back to the whole list if none triggered, so
 * there's always something to show). Mirrors equivalences.ts's day-based
 * rotation so the featured tip changes once per calendar day rather than
 * always landing on the same detector.
 */
export function habitOfTheDay(
  results: HabitResult[],
  now: Date = new Date()
): HabitResult | null {
  const pool = results.filter((r) => r.triggered);
  const source = pool.length > 0 ? pool : results;
  if (source.length === 0) return null;
  const dayIndex = localDayIndex(now);
  const idx = ((dayIndex % source.length) + source.length) % source.length;
  return source[idx]!;
}
