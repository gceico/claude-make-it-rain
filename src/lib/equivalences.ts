'use strict';

/**
 * Turns a dollar amount into tangible, relatable equivalences so an abstract API
 * bill becomes something you can feel. This is the "conscious spending" counter-
 * weight to the money animations: instead of celebrating a big number, it asks
 * "what did that actually cost?" — a couple of burgers, a slice of a trip.
 *
 * Two flavors, matching how the number is used:
 *   • treats()          — small purchasing-power items for an INDIVIDUAL total
 *                         ("≈ 2 burgers 🍔"). Framed as consumption, not reward.
 *   • bigTicketFraction — how much of one big thing you burned, for reflection
 *                         ("≈ 10% of a trip to Greece"). Individual, aspirational.
 *   • bigTicketReached  — the big thing the COLLECTIVE total adds up to, for the
 *                         community headline ("≈ a trip to Greece ✈️").
 *
 * Copy is deliberately biased toward cost/consumption, never achievement, to keep
 * the app on the awareness side of the line. Big-ticket reference prices are
 * playful ballpark estimates, not quotes — attention, not accounting.
 *
 * This module is the canonical source for these tables. The web landing page
 * carries a mirrored copy at web/src/lib/equivalences.ts (the two builds are
 * separate packages); keep the two tables in sync.
 */

/** A small, everyday item used to make an individual total relatable. */
export interface Treat {
  singular: string;
  plural: string;
  emoji: string;
  unitUSD: number;
}

/** A large aspirational item used for fraction/headline framing. */
export interface BigTicket {
  /** e.g. "trip to Greece" — rendered after an article as "a trip to Greece". */
  label: string;
  /** "a" or "an" to read naturally before `label`. */
  article: string;
  emoji: string;
  unitUSD: number;
}

/** Result of matching a total to a treat. `count` is always >= 1 for usd > 0. */
export interface TreatMatch {
  count: number;
  label: string; // already pluralized for `count`
  emoji: string;
  /** "2 burgers" — count + pluralized label, ready to drop after "≈". */
  text: string;
}

/** Result of framing a total against a big-ticket item. */
export interface BigTicketMatch {
  emoji: string;
  /** e.g. "10% of a trip to Greece" or "3× a trip to Greece". */
  text: string;
}

// Price-ascending. Curated to span "a coffee" up to "a night out" so most daily
// totals land on a satisfying small count.
export const SMALL_TREATS: Treat[] = [
  { singular: 'coffee', plural: 'coffees', emoji: '☕', unitUSD: 5 },
  { singular: 'burger', plural: 'burgers', emoji: '🍔', unitUSD: 12 },
  {
    singular: 'movie ticket',
    plural: 'movie tickets',
    emoji: '🎟️',
    unitUSD: 16,
  },
  { singular: 'pizza', plural: 'pizzas', emoji: '🍕', unitUSD: 22 },
  { singular: 'video game', plural: 'video games', emoji: '🎮', unitUSD: 60 },
  { singular: 'night out', plural: 'nights out', emoji: '🎉', unitUSD: 120 },
];

// Price-ascending. Deliberately big, so an individual total reads as a fraction
// and a whole community's total reads as a thing you could point at. The Titanic
// and Burj Khalifa are historical/build-cost ballparks kept for fun scale.
export const BIG_TICKETS: BigTicket[] = [
  { label: 'new iPhone', article: 'a', emoji: '📱', unitUSD: 1000 },
  { label: 'weekend in Paris', article: 'a', emoji: '🥐', unitUSD: 1200 },
  { label: 'trip to Greece', article: 'a', emoji: '🏛️', unitUSD: 2500 },
  { label: 'used car', article: 'a', emoji: '🚗', unitUSD: 9000 },
  { label: 'small house deposit', article: 'a', emoji: '🏠', unitUSD: 40000 },
  { label: 'Tesla', article: 'a', emoji: '⚡', unitUSD: 45000 },
  { label: 'Titanic', article: 'the', emoji: '🚢', unitUSD: 7_500_000 },
  {
    label: 'Burj Khalifa',
    article: 'the',
    emoji: '🏙️',
    unitUSD: 1_500_000_000,
  },
];

// The count we steer toward when picking a treat: "2 burgers" reads better than
// "5 coffees" or "1 pizza" for the same spend.
const TREAT_TARGET_COUNT = 3;

function clampUSD(totalUSD?: number | null): number {
  return typeof totalUSD === 'number' && isFinite(totalUSD) && totalUSD > 0
    ? totalUSD
    : 0;
}

/**
 * Days since the Unix epoch in the caller's LOCAL timezone. Passed as the
 * `dayIndex` seed to the matchers below so the featured item rotates once per
 * calendar day (a burger today, a pizza tomorrow) instead of always landing on
 * the same "best fit". Defaults to the current local day.
 */
export function localDayIndex(now: Date = new Date()): number {
  return Math.floor(
    (now.getTime() - now.getTimezoneOffset() * 60000) / 86400000
  );
}

/** Pick from a non-empty pool: rotate by `dayIndex` when given, else index 0. */
function rotate<T>(pool: T[], dayIndex?: number | null): T {
  if (typeof dayIndex === 'number' && isFinite(dayIndex) && pool.length > 1) {
    return pool[
      ((Math.trunc(dayIndex) % pool.length) + pool.length) % pool.length
    ]!;
  }
  return pool[0]!;
}

/**
 * Match an individual total to the treat that yields the most natural small
 * count (nearest to ~3, tie-broken toward the pricier item so counts stay low).
 * Returns null for a zero/invalid total so callers can show their own "nothing
 * yet" copy.
 *
 * Pass `dayIndex` (see {@link localDayIndex}) to rotate the featured item once
 * per day across everything the total can afford, instead of always showing the
 * same best-fit item. Omit it to keep the deterministic best-fit behavior.
 */
export function treats(
  totalUSD?: number | null,
  dayIndex?: number | null
): TreatMatch | null {
  const usd = clampUSD(totalUSD);
  if (usd <= 0) return null;

  // Only consider treats the total can actually afford (raw count >= 1), so a
  // few-dollar spend doesn't get mislabeled as a fraction of a pricey item. If
  // the total is below even the cheapest treat, use that cheapest treat.
  const affordable = SMALL_TREATS.filter((t) => usd >= t.unitUSD);
  const pool = affordable.length > 0 ? affordable : [SMALL_TREATS[0]!];

  let best: Treat;
  if (typeof dayIndex === 'number' && isFinite(dayIndex)) {
    // Rotate through the affordable items so the pick changes each day.
    best = rotate(pool, dayIndex);
  } else {
    // Deterministic: the item whose count lands nearest the natural target.
    best = pool[0]!;
    let bestScore = Infinity;
    for (const t of pool) {
      const count = Math.max(1, Math.round(usd / t.unitUSD));
      const score = Math.abs(count - TREAT_TARGET_COUNT);
      if (
        score < bestScore ||
        (score === bestScore && t.unitUSD > best.unitUSD)
      ) {
        best = t;
        bestScore = score;
      }
    }
  }
  const bestCount = Math.max(1, Math.round(usd / best.unitUSD));
  const label = bestCount === 1 ? best.singular : best.plural;
  return {
    count: bestCount,
    label,
    emoji: best.emoji,
    text: `${bestCount} ${label}`,
  };
}

/** Format a percentage for display: no decimals >= 10%, one decimal below, floored at 0.1%. */
function pct(ratio: number): string {
  const p = ratio * 100;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${(Math.round(p * 10) / 10).toFixed(1)}%`;
  return `${Math.max(0.1, Math.round(p * 10) / 10).toFixed(1)}%`;
}

/**
 * Frame an individual total as a slice of one big thing, for reflection:
 * "≈ 10% of a trip to Greece". Picks the smallest big-ticket the total does NOT
 * exceed (so the percentage is meaningful and < 100%); if the total dwarfs every
 * item, expresses it as a multiple of the largest ("3× the Titanic").
 *
 * Pass `dayIndex` (see {@link localDayIndex}) to rotate the reference item once
 * per day across every big-ticket the total hasn't exceeded, so the framing
 * stays fresh. Omit it to keep the deterministic smallest-fit behavior.
 */
export function bigTicketFraction(
  totalUSD?: number | null,
  dayIndex?: number | null
): BigTicketMatch | null {
  const usd = clampUSD(totalUSD);
  if (usd <= 0) return null;

  // Candidates the total reads as a fraction of (< 100%), smallest-first.
  const fractional = BIG_TICKETS.filter((b) => b.unitUSD > usd);
  const reference =
    fractional.length > 0
      ? rotate(fractional, dayIndex)
      : BIG_TICKETS[BIG_TICKETS.length - 1]!;
  const name = `${reference.article} ${reference.label}`;
  if (usd >= reference.unitUSD) {
    const times = Math.round((usd / reference.unitUSD) * 10) / 10;
    return { emoji: reference.emoji, text: `${times}× ${name}` };
  }
  return {
    emoji: reference.emoji,
    text: `${pct(usd / reference.unitUSD)} of ${name}`,
  };
}

/**
 * Frame a (larger, collective) total as the big thing it adds up to, for the
 * community headline: "≈ a trip to Greece" or "≈ 3× a trip to Greece". Picks the
 * largest big-ticket the total reaches; falls back to a fractional framing when
 * the total is below even the smallest item.
 *
 * Pass `dayIndex` (see {@link localDayIndex}) to rotate the headline item once
 * per day across every big-ticket the total has reached (each is still true —
 * the total does add up to that many of it). Omit it to keep naming the largest.
 */
export function bigTicketReached(
  totalUSD?: number | null,
  dayIndex?: number | null
): BigTicketMatch | null {
  const usd = clampUSD(totalUSD);
  if (usd <= 0) return null;

  // Every item the total reaches, largest-first so index 0 is the default pick.
  const reachedPool = BIG_TICKETS.filter((b) => usd >= b.unitUSD).reverse();
  if (reachedPool.length === 0) return bigTicketFraction(usd, dayIndex);
  const reached = rotate(reachedPool, dayIndex);

  const name = `${reached.article} ${reached.label}`;
  const times = usd / reached.unitUSD;
  // Only call out a multiple once it clearly rounds to 2 or more; below that,
  // just name the thing so we never overstate (e.g. 1.67× → just the item).
  if (times >= 2) {
    return { emoji: reached.emoji, text: `${Math.round(times)}× ${name}` };
  }
  return { emoji: reached.emoji, text: name };
}
