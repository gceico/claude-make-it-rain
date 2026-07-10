'use strict';

/**
 * Turns a dollar amount into a fun "wealth" breakdown so users can see their
 * spend as physical money at a glance.
 *
 * Denomination scheme:
 *   $100  → 💰 stack
 *   $1    → 💵 bill
 *   1¢    → 🪙 coin
 *
 * Example: 234.50 → { stacks: 2, bills: 34, coins: 50 }
 */

/** A dollar amount decomposed into $100 stacks, $1 bills, and 1¢ coins. */
export interface Breakdown {
  stacks: number;
  bills: number;
  coins: number;
}

export function breakdown(totalUSD?: number | null): Breakdown {
  const total =
    typeof totalUSD === 'number' && isFinite(totalUSD) && totalUSD > 0
      ? totalUSD
      : 0;
  // Work in integer cents to avoid floating-point drift (e.g. 0.1 + 0.2).
  const totalCents = Math.round(total * 100);
  const stacks = Math.floor(totalCents / 10000);
  const bills = Math.floor((totalCents % 10000) / 100);
  const coins = totalCents % 100;
  return { stacks, bills, coins };
}

/** Human-readable one-liner, e.g. "💰×2  💵×34  🪙×50". */
export function format(totalUSD?: number | null): string {
  const { stacks, bills, coins } = breakdown(totalUSD);
  const parts: string[] = [];
  if (stacks > 0) parts.push(`💰×${stacks}`);
  if (bills > 0) parts.push(`💵×${bills}`);
  if (coins > 0) parts.push(`🪙×${coins}`);
  // Broke? Show a single lonely coin at zero.
  if (parts.length === 0) return '🪙×0';
  return parts.join('  ');
}
