'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const denominations = require('../lib/denominations');
const { Config, DEFAULTS } = require('../lib/config');

// ── Denominations: $100 = 💰, $1 = 💵, 1¢ = 🪙 ───────────────────────────────
assert.deepStrictEqual(denominations.breakdown(234.50), { stacks: 2, bills: 34, coins: 50 });
assert.deepStrictEqual(denominations.breakdown(0), { stacks: 0, bills: 0, coins: 0 });
assert.deepStrictEqual(denominations.breakdown(100), { stacks: 1, bills: 0, coins: 0 });
assert.deepStrictEqual(denominations.breakdown(0.99), { stacks: 0, bills: 0, coins: 99 });
// Negative / non-finite inputs are clamped to zero rather than throwing.
assert.deepStrictEqual(denominations.breakdown(-5), { stacks: 0, bills: 0, coins: 0 });
assert.deepStrictEqual(denominations.breakdown(NaN), { stacks: 0, bills: 0, coins: 0 });
assert.deepStrictEqual(denominations.breakdown(undefined), { stacks: 0, bills: 0, coins: 0 });
// Float drift must not lose a cent (0.1 + 0.2 style rounding).
assert.deepStrictEqual(denominations.breakdown(0.1 + 0.2), { stacks: 0, bills: 0, coins: 30 });

assert.strictEqual(denominations.format(234.50), '💰×2  💵×34  🪙×50');
assert.strictEqual(denominations.format(0), '🪙×0');
assert.strictEqual(denominations.format(100), '💰×1');
assert.strictEqual(denominations.format(1.05), '💵×1  🪙×5');
console.log('denominations (breakdown, format): OK');

// ── Config: JSON persistence + corrupt/missing tolerance ─────────────────────
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-cfg-'));
const cfgPath = path.join(tmpDir, 'nested', 'config.json');

// Missing file → defaults, no throw.
const c1 = new Config(cfgPath);
assert.strictEqual(c1.get('muted'), DEFAULTS.muted);
assert.strictEqual(c1.get('muted'), false);

// set persists to disk and is readable by a fresh instance.
c1.set('muted', true);
assert.ok(fs.existsSync(cfgPath), 'config file should be written (dirs auto-created)');
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
console.log('config (persist, defaults, corrupt tolerance): OK');

console.log('\nAll delight tests passed.');
