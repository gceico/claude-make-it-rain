/**
 * Tangible-equivalence tables for the landing page.
 *
 * MIRROR of src/lib/equivalences.ts (the Electron app's canonical copy). The app
 * and this Astro site are separate build packages with different tsconfigs, so —
 * like money()/rain and the other client helpers here — the tables are duplicated
 * rather than imported across the boundary. Keep the two files in sync.
 *
 * Turns an abstract dollar figure into something you can feel: a couple of
 * burgers for an individual total, a slice of something big for reflection, and
 * the big thing a whole community's spend adds up to. Copy is biased toward
 * cost/consumption, never achievement; reference prices are playful ballparks.
 */

export interface Treat {
  singular: string;
  plural: string;
  emoji: string;
  unitUSD: number;
}

export interface BigTicket {
  label: string;
  article: string;
  emoji: string;
  unitUSD: number;
}

export interface TreatMatch {
  count: number;
  label: string;
  emoji: string;
  text: string;
}

export interface BigTicketMatch {
  emoji: string;
  text: string;
}

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

const TREAT_TARGET_COUNT = 3;

function clampUSD(totalUSD?: number | null): number {
  return typeof totalUSD === 'number' && isFinite(totalUSD) && totalUSD > 0
    ? totalUSD
    : 0;
}

export function treats(totalUSD?: number | null): TreatMatch | null {
  const usd = clampUSD(totalUSD);
  if (usd <= 0) return null;

  const affordable = SMALL_TREATS.filter((t) => usd >= t.unitUSD);
  const pool = affordable.length > 0 ? affordable : [SMALL_TREATS[0]!];

  let best = pool[0]!;
  let bestCount = Math.max(1, Math.round(usd / best.unitUSD));
  let bestScore = Infinity;
  for (const t of pool) {
    const count = Math.max(1, Math.round(usd / t.unitUSD));
    const score = Math.abs(count - TREAT_TARGET_COUNT);
    if (
      score < bestScore ||
      (score === bestScore && t.unitUSD > best.unitUSD)
    ) {
      best = t;
      bestCount = count;
      bestScore = score;
    }
  }
  const label = bestCount === 1 ? best.singular : best.plural;
  return {
    count: bestCount,
    label,
    emoji: best.emoji,
    text: `${bestCount} ${label}`,
  };
}

function pct(ratio: number): string {
  const p = ratio * 100;
  if (p >= 10) return `${Math.round(p)}%`;
  if (p >= 1) return `${(Math.round(p * 10) / 10).toFixed(1)}%`;
  return `${Math.max(0.1, Math.round(p * 10) / 10).toFixed(1)}%`;
}

export function bigTicketFraction(
  totalUSD?: number | null
): BigTicketMatch | null {
  const usd = clampUSD(totalUSD);
  if (usd <= 0) return null;

  const reference =
    BIG_TICKETS.find((b) => b.unitUSD > usd) ??
    BIG_TICKETS[BIG_TICKETS.length - 1]!;
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

export function bigTicketReached(
  totalUSD?: number | null
): BigTicketMatch | null {
  const usd = clampUSD(totalUSD);
  if (usd <= 0) return null;

  let reached: BigTicket | null = null;
  for (const b of BIG_TICKETS) {
    if (usd >= b.unitUSD) reached = b;
  }
  if (!reached) return bigTicketFraction(usd);

  const name = `${reached.article} ${reached.label}`;
  const times = usd / reached.unitUSD;
  if (times >= 2) {
    return { emoji: reached.emoji, text: `${Math.round(times)}× ${name}` };
  }
  return { emoji: reached.emoji, text: name };
}
