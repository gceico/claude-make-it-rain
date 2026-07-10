'use strict';

/** A first-time-today spend threshold and the number of stacks it bursts. */
export interface Milestone {
  threshold: number;
  count: number;
}

// First-time-today spend milestones that earn a "stack of money" burst.
// $100 is intentionally NOT here — it triggers the full-screen rain instead
// (handled separately in main.ts). Ordered ascending so callers can fire only
// the highest milestone crossed in a single update. Each stack rendered by the
// overlay is a thick fanned wad of 10 bills.
export const STACK_MILESTONES: Milestone[] = [
  { threshold: 10, count: 1 }, // $10: one thick stack (10 bills) bursts from the tray.
  { threshold: 50, count: 5 }, // $50: five stacks of 10 bills each.
];

/** Number of stacks to burst when today's total crosses from `previousTotal`
 *  to `newTotal` (0 if no milestone was crossed). Crossing means
 *  previousTotal < threshold <= newTotal, so the flags reset for free at
 *  midnight when the monitor's total returns to $0. If several milestones are
 *  crossed in one update, only the highest fires so bursts don't pile up. */
export function stackCountForCrossing(
  previousTotal: number,
  newTotal: number
): number {
  let count = 0;
  for (const m of STACK_MILESTONES) {
    if (previousTotal < m.threshold && newTotal >= m.threshold) count = m.count;
  }
  return count;
}
