'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { UsageMonitor } = require('../lib/usage-monitor');
const { costForEntry, pricingForModel } = require('../lib/pricing');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-test-'));
const projectsDir = path.join(tmpRoot, 'projects');
const projectDir = path.join(projectsDir, 'my-project');
fs.mkdirSync(projectDir, { recursive: true });

const now = new Date();
const todayISO = now.toISOString();
const yesterdayISO = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

function entry({ ts, model, reqId, msgId, input, output, cacheRead = 0, cacheCreate = 0, breakdown = null, type = 'assistant' }) {
  const usage = {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreate,
  };
  if (breakdown) usage.cache_creation = breakdown;
  return JSON.stringify({
    type,
    timestamp: ts,
    requestId: reqId,
    message: { id: msgId, model, usage },
  });
}

// ── Pricing unit checks ──────────────────────────────────────────────────────
assert.deepStrictEqual(pricingForModel('claude-sonnet-5'), { inputPerMillion: 3, outputPerMillion: 15 });
assert.deepStrictEqual(pricingForModel('claude-fable-5'), { inputPerMillion: 10, outputPerMillion: 50 });
assert.deepStrictEqual(pricingForModel(null), { inputPerMillion: 5, outputPerMillion: 25 });

const approx = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: expected ${expected}, got ${actual}`);

// 1M in + 1M out on sonnet = $3 + $15
approx(
  costForEntry({ inputTokens: 1e6, outputTokens: 1e6, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, cacheCreationBreakdown: null }, 'claude-sonnet-5'),
  18, 'sonnet in+out'
);
// cache read at 10% of input rate: 1M cache-read on sonnet = $0.30
approx(
  costForEntry({ inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 1e6, cacheCreationInputTokens: 0, cacheCreationBreakdown: null }, 'claude-sonnet-5'),
  0.3, 'cache read'
);
// breakdown: 5m at 1.25x, 1h at 2x input rate
approx(
  costForEntry(
    { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 999, cacheCreationBreakdown: { ephemeral5mInputTokens: 1e6, ephemeral1hInputTokens: 1e6 } },
    'claude-sonnet-5'
  ),
  3 * 1.25 + 3 * 2, 'cache creation breakdown'
);
console.log('pricing: OK');

// ── Monitor scan: dedup, day filter, type filter, cost math ────────────────
const file = path.join(projectDir, 'session1.jsonl');
const lines = [
  // counted: 100k in / 10k out on sonnet = 0.3 + 0.15 = $0.45
  entry({ ts: todayISO, model: 'claude-sonnet-5', reqId: 'r1', msgId: 'm1', input: 100_000, output: 10_000 }),
  // duplicate of the same requestId:messageId — must be ignored
  entry({ ts: todayISO, model: 'claude-sonnet-5', reqId: 'r1', msgId: 'm1', input: 100_000, output: 10_000 }),
  // yesterday — must be ignored
  entry({ ts: yesterdayISO, model: 'claude-sonnet-5', reqId: 'r2', msgId: 'm2', input: 500_000, output: 500_000 }),
  // non-assistant — must be ignored
  entry({ ts: todayISO, model: 'claude-sonnet-5', reqId: 'r3', msgId: 'm3', input: 1e6, output: 1e6, type: 'user' }),
  // counted: fable, 1M cache-read = 10 * 0.1 = $1.00
  entry({ ts: todayISO, model: 'claude-fable-5', reqId: 'r4', msgId: 'm4', input: 0, output: 0, cacheRead: 1_000_000 }),
  // malformed line — must be skipped without crashing
  '{not json',
];
fs.writeFileSync(file, lines.join('\n') + '\n');

const monitor = new UsageMonitor({ projectsDir });
monitor.tick(true);

const s1 = monitor.snapshot;
assert.strictEqual(s1.entryCount, 2, `expected 2 entries, got ${s1.entryCount}`);
assert.strictEqual(s1.inputTokens, 100_000);
assert.strictEqual(s1.outputTokens, 10_000);
assert.ok(Math.abs(s1.totalCostUSD - 1.45) < 1e-9, `expected $1.45, got ${s1.totalCostUSD}`);
console.log('initial scan (dedup, day filter, type filter, cost math): OK');

// ── Incremental append with a partial line across ticks ─────────────────────
// counted: 200k out on sonnet = $3.00; written in two chunks split mid-line.
const appended = entry({ ts: todayISO, model: 'claude-sonnet-5', reqId: 'r5', msgId: 'm5', input: 0, output: 200_000 }) + '\n';
const half = Math.floor(appended.length / 2);
fs.appendFileSync(file, appended.slice(0, half));
monitor.tick(false);
assert.strictEqual(monitor.snapshot.entryCount, 2, 'partial line must not be counted yet');

fs.appendFileSync(file, appended.slice(half));
let updateFired = null;
monitor.onUpdate = (prev, snap) => { updateFired = { prev, snap }; };
monitor.tick(false);

const s2 = monitor.snapshot;
assert.strictEqual(s2.entryCount, 3);
assert.ok(Math.abs(s2.totalCostUSD - 4.45) < 1e-9, `expected $4.45, got ${s2.totalCostUSD}`);
assert.ok(updateFired, 'onUpdate must fire when the total changes');
assert.ok(Math.abs(updateFired.prev - 1.45) < 1e-9);
console.log('incremental append + partial-line buffering: OK');

// ── Dollar-crossing math used by main.js ─────────────────────────────────────
assert.strictEqual(Math.floor(4.45) - Math.floor(1.45), 3, '3 whole dollars crossed');
assert.strictEqual(Math.floor(105 / 100) - Math.floor(95 / 100), 1, '$100 boundary crossed');
console.log('crossing math: OK');

fs.rmSync(tmpRoot, { recursive: true, force: true });
console.log('\nAll tests passed.');
