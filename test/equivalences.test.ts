'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import {
  treats,
  bigTicketFraction,
  bigTicketReached,
  localDayIndex,
  SMALL_TREATS,
  BIG_TICKETS,
} from '../src/lib/equivalences';

// ── Tables are curated and price-ascending (the matchers rely on the order) ──
test('equivalence tables are non-empty and price-ascending', () => {
  assert.ok(SMALL_TREATS.length > 0);
  assert.ok(BIG_TICKETS.length > 0);
  for (let i = 1; i < SMALL_TREATS.length; i++) {
    assert.ok(SMALL_TREATS[i]!.unitUSD > SMALL_TREATS[i - 1]!.unitUSD);
  }
  for (let i = 1; i < BIG_TICKETS.length; i++) {
    assert.ok(BIG_TICKETS[i]!.unitUSD > BIG_TICKETS[i - 1]!.unitUSD);
  }
});

// ── treats(): small purchasing-power items for an individual total ───────────
test('treats returns null for zero / invalid input', () => {
  assert.strictEqual(treats(0), null);
  assert.strictEqual(treats(-5), null);
  assert.strictEqual(treats(NaN), null);
  assert.strictEqual(treats(undefined), null);
});

test('treats picks the cheapest item and singular label below the smallest unit', () => {
  const t = treats(3); // below the $5 coffee
  assert.ok(t);
  assert.strictEqual(t!.count, 1);
  assert.strictEqual(t!.label, 'coffee'); // singular for count === 1
  assert.strictEqual(t!.text, '1 coffee');
});

test('treats favors a natural small count and pluralizes', () => {
  const t = treats(24);
  assert.ok(t);
  assert.ok(t!.count >= 2 && t!.count <= 3); // "2 movie tickets" / "2 pizzas"-ish
  assert.ok(/s$/.test(t!.label)); // plural
  assert.strictEqual(t!.text, `${t!.count} ${t!.label}`);
});

// ── bigTicketFraction(): a slice of one big thing, for reflection ────────────
test('bigTicketFraction frames a small total as a percentage of a big item', () => {
  const f = bigTicketFraction(120);
  assert.ok(f);
  assert.ok(/%\sof\s/.test(f!.text)); // e.g. "12% of a new iPhone"
  assert.ok(f!.emoji.length > 0);
});

test('bigTicketFraction returns null for zero', () => {
  assert.strictEqual(bigTicketFraction(0), null);
});

test('bigTicketFraction expresses a total above every item as a multiple', () => {
  const biggest = BIG_TICKETS[BIG_TICKETS.length - 1]!;
  const f = bigTicketFraction(biggest.unitUSD * 3);
  assert.ok(f);
  assert.ok(/×/.test(f!.text));
});

// ── bigTicketReached(): the big thing a collective total adds up to ──────────
test('bigTicketReached names the largest item a total reaches', () => {
  const greece = BIG_TICKETS.find((b) => /Greece/.test(b.label))!;
  const r = bigTicketReached(greece.unitUSD + 10);
  assert.ok(r);
  assert.ok(/trip to Greece/.test(r!.text));
  assert.ok(!/×/.test(r!.text)); // 1.x× -> just names it, no multiple
});

test('bigTicketReached uses a multiple only at 2x or more', () => {
  // Use the largest item so the "reached" item is itself, not a bigger one.
  const biggest = BIG_TICKETS[BIG_TICKETS.length - 1]!;
  const r = bigTicketReached(biggest.unitUSD * 3);
  assert.ok(r);
  assert.ok(/^3×/.test(r!.text));
});

test('bigTicketReached falls back to a fraction below the smallest big item', () => {
  const r = bigTicketReached(50); // below the cheapest big-ticket
  assert.ok(r);
  assert.ok(/%\sof\s/.test(r!.text));
});

// ── Daily rotation: passing a dayIndex cycles the featured item ──────────────
test('localDayIndex is a stable whole number for a fixed date', () => {
  const d = new Date('2026-07-14T09:00:00Z');
  assert.strictEqual(localDayIndex(d), Math.floor(localDayIndex(d)));
  assert.strictEqual(localDayIndex(d), localDayIndex(d)); // deterministic
});

test('treats rotates the featured item across days and stays consistent per day', () => {
  // $200 can afford several treats, so rotation has room to move.
  const seen = new Set<string>();
  for (let day = 0; day < SMALL_TREATS.length * 2; day++) {
    const t = treats(200, day);
    assert.ok(t);
    seen.add(t!.label);
    assert.strictEqual(treats(200, day)!.label, t!.label); // same day → same item
  }
  assert.ok(seen.size > 1, 'expected more than one distinct item across days');
});

test('treats without a dayIndex keeps deterministic best-fit behavior', () => {
  assert.strictEqual(treats(24)!.text, treats(24)!.text);
  assert.strictEqual(treats(24, undefined)!.text, treats(24)!.text);
});

test('bigTicketFraction rotates the reference across days', () => {
  const seen = new Set<string>();
  for (let day = 0; day < BIG_TICKETS.length * 2; day++) {
    const f = bigTicketFraction(10, day); // below every big-ticket → all candidates
    assert.ok(f);
    seen.add(f!.text);
  }
  assert.ok(seen.size > 1);
});

test('bigTicketReached rotates among reached items, each still truthful', () => {
  const total = BIG_TICKETS[2]!.unitUSD + 10; // reaches the first three items
  const seen = new Set<string>();
  for (let day = 0; day < 6; day++) {
    const r = bigTicketReached(total, day);
    assert.ok(r);
    seen.add(r!.text);
  }
  assert.ok(seen.size > 1);
});
