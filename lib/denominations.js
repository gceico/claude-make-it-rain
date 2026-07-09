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
function breakdown(totalUSD) {
  const total = (typeof totalUSD === 'number' && isFinite(totalUSD) && totalUSD > 0) ? totalUSD : 0;
  // Work in integer cents to avoid floating-point drift (e.g. 0.1 + 0.2).
  const totalCents = Math.round(total * 100);
  const stacks = Math.floor(totalCents / 10000);
  const bills = Math.floor((totalCents % 10000) / 100);
  const coins = totalCents % 100;
  return { stacks, bills, coins };
}

/** Human-readable one-liner, e.g. "💰×2  💵×34  🪙×50". */
function format(totalUSD) {
  const { stacks, bills, coins } = breakdown(totalUSD);
  const parts = [];
  if (stacks > 0) parts.push(`💰×${stacks}`);
  if (bills > 0) parts.push(`💵×${bills}`);
  if (coins > 0) parts.push(`🪙×${coins}`);
  // Broke? Show a single lonely coin at zero.
  if (parts.length === 0) return '🪙×0';
  return parts.join('  ');
}

module.exports = { breakdown, format };
