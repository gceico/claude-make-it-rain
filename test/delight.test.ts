'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as denominations from '../src/lib/denominations';
import { Config, DEFAULTS } from '../src/lib/config';
import { STACK_MILESTONES, stackCountForCrossing } from '../src/lib/milestones';

// ── Denominations: $100 = 💰, $1 = 💵, 1¢ = 🪙 ───────────────────────────────
test('denominations (breakdown, format)', () => {
  assert.deepStrictEqual(denominations.breakdown(234.5), {
    stacks: 2,
    bills: 34,
    coins: 50,
  });
  assert.deepStrictEqual(denominations.breakdown(0), {
    stacks: 0,
    bills: 0,
    coins: 0,
  });
  assert.deepStrictEqual(denominations.breakdown(100), {
    stacks: 1,
    bills: 0,
    coins: 0,
  });
  assert.deepStrictEqual(denominations.breakdown(0.99), {
    stacks: 0,
    bills: 0,
    coins: 99,
  });
  // Negative / non-finite inputs are clamped to zero rather than throwing.
  assert.deepStrictEqual(denominations.breakdown(-5), {
    stacks: 0,
    bills: 0,
    coins: 0,
  });
  assert.deepStrictEqual(denominations.breakdown(NaN), {
    stacks: 0,
    bills: 0,
    coins: 0,
  });
  assert.deepStrictEqual(denominations.breakdown(undefined), {
    stacks: 0,
    bills: 0,
    coins: 0,
  });
  // Float drift must not lose a cent (0.1 + 0.2 style rounding).
  assert.deepStrictEqual(denominations.breakdown(0.1 + 0.2), {
    stacks: 0,
    bills: 0,
    coins: 30,
  });

  assert.strictEqual(denominations.format(234.5), '💰×2  💵×34  🪙×50');
  assert.strictEqual(denominations.format(0), '🪙×0');
  assert.strictEqual(denominations.format(100), '💰×1');
  assert.strictEqual(denominations.format(1.05), '💵×1  🪙×5');
});

// ── Config: JSON persistence + corrupt/missing tolerance ─────────────────────
test('config (persist, defaults, corrupt tolerance)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-cfg-'));
  const cfgPath = path.join(tmpDir, 'nested', 'config.json');

  // Missing file → defaults, no throw.
  const c1 = new Config(cfgPath);
  assert.strictEqual(c1.get('muted'), DEFAULTS.muted);
  assert.strictEqual(c1.get('muted'), false);

  // set persists to disk and is readable by a fresh instance.
  c1.set('muted', true);
  assert.ok(
    fs.existsSync(cfgPath),
    'config file should be written (dirs auto-created)'
  );
  const c2 = new Config(cfgPath);
  assert.strictEqual(c2.get('muted'), true);

  // Corrupt JSON falls back to defaults without throwing.
  fs.writeFileSync(cfgPath, '{ this is not json');
  const c3 = new Config(cfgPath);
  assert.strictEqual(c3.get('muted'), DEFAULTS.muted);

  // Unknown keys in the file are preserved-through-defaults for known keys.
  fs.writeFileSync(cfgPath, JSON.stringify({ somethingElse: 42 }));
  const c4 = new Config(cfgPath);
  assert.strictEqual(c4.get('muted'), false);
  assert.strictEqual(c4.get('somethingElse'), 42);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Milestone stacks: $10 → 1 stack, $50 → 5 stacks ($100 is rain, not here) ─
test('milestones (tiers 1/5, crossing rules, 10 bills per stack)', () => {
  assert.deepStrictEqual(STACK_MILESTONES, [
    { threshold: 10, count: 1 },
    { threshold: 50, count: 5 },
  ]);
  // Crossing a threshold fires its count.
  assert.strictEqual(stackCountForCrossing(9.5, 10), 1);
  assert.strictEqual(stackCountForCrossing(9.99, 12.3), 1);
  assert.strictEqual(stackCountForCrossing(49, 50.25), 5);
  // Crossing several thresholds in one update fires only the highest.
  assert.strictEqual(stackCountForCrossing(5, 60), 5);
  // No crossing → no stacks (already past, or still below).
  assert.strictEqual(stackCountForCrossing(10, 12), 0);
  assert.strictEqual(stackCountForCrossing(0, 9.99), 0);
  assert.strictEqual(stackCountForCrossing(51, 80), 0);
  // $100+ without touching $10/$50 boundaries stays a rain matter, not stacks.
  assert.strictEqual(stackCountForCrossing(99, 150), 0);

  // The overlay renders each milestone stack as a 10-bill fanned wad.
  const overlayHtml = fs.readFileSync(
    path.join(import.meta.dir, '..', 'overlay.html'),
    'utf8'
  );
  assert.match(
    overlayHtml,
    /const BILLS_PER_STACK = 10;/,
    'overlay.html should render 10 bills per stack'
  );
});
