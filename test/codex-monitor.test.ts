'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CodexMonitor } from '../src/lib/codex-monitor';

const now = new Date();
const todayISO = now.toISOString();
const yesterdayISO = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();

const yyyy = String(now.getFullYear());
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');

/** Fresh isolated sessions root under a temp dir. */
function freshRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-codex-mon-'));
  return path.join(root, 'sessions');
}

// ── Line builders ────────────────────────────────────────────────────────────
const meta = (id: string, cwd = '/proj') =>
  JSON.stringify({
    type: 'session_meta',
    timestamp: todayISO,
    payload: { id, cwd },
  });
const turn = (model: string) =>
  JSON.stringify({
    type: 'turn_context',
    timestamp: todayISO,
    payload: { model },
  });
const tc = (
  cum: { input: number; cached?: number; output?: number },
  ts = todayISO
) =>
  JSON.stringify({
    type: 'event_msg',
    timestamp: ts,
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: {
          input_tokens: cum.input,
          cached_input_tokens: cum.cached || 0,
          output_tokens: cum.output || 0,
          reasoning_output_tokens: 0,
          total_tokens: cum.input + (cum.output || 0),
        },
      },
    },
  });
const userMsg = (text: string, ts = todayISO) =>
  JSON.stringify({
    type: 'response_item',
    timestamp: ts,
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    },
  });

/** Write a rollout file under today's YYYY/MM/DD in `root`. */
function writeSession(root: string, id: string, lines: string[]): string {
  const dir = path.join(root, yyyy, mm, dd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

function snapshotOf(root: string) {
  const m = new CodexMonitor({ sessionsDir: root, pollMs: 999999 });
  m.tick(true);
  return m.buildSnapshot();
}

const CODEX_IN = 1.25 / 1_000_000; // gpt-5-codex input $/token
const CODEX_OUT = 10 / 1_000_000;

test('cumulative token_count reports the delta total, not the sum of readings', () => {
  const root = freshRoot();
  writeSession(root, 's', [
    meta('s'),
    turn('gpt-5-codex'),
    tc({ input: 100 }),
    tc({ input: 300 }), // cumulative 300, not another 300
  ]);
  const snap = snapshotOf(root);
  assert.ok(Math.abs(snap.totalCostUSD - 300 * CODEX_IN) < 1e-12);
  assert.strictEqual(snap.inputTokens, 300);
  assert.strictEqual(snap.entryCount, 2);
});

test('model attribution follows the latest turn_context (mid-session switch)', () => {
  const root = freshRoot();
  writeSession(root, 's', [
    meta('s'),
    turn('gpt-5-codex'),
    tc({ input: 100 }),
    turn('gpt-5.3-codex'),
    tc({ input: 300 }), // delta 200 belongs to gpt-5.3-codex
  ]);
  const snap = snapshotOf(root);
  assert.ok(snap.perModel['gpt-5-codex']);
  assert.ok(snap.perModel['gpt-5.3-codex']);
  assert.strictEqual(snap.perModel['gpt-5-codex'].inputTokens, 100);
  assert.strictEqual(snap.perModel['gpt-5.3-codex'].inputTokens, 200);
  const expected = 100 * CODEX_IN + 200 * (1.75 / 1_000_000);
  assert.ok(Math.abs(snap.totalCostUSD - expected) < 1e-12);
});

test('cached input is billed at 10% of the input rate', () => {
  const root = freshRoot();
  writeSession(root, 's', [
    turn('gpt-5-codex'),
    tc({ input: 1000, cached: 400, output: 0 }),
  ]);
  const snap = snapshotOf(root);
  // 600 non-cached * 1.25 + 400 cached * 0.125 + 0 output = (750 + 50)/1e6
  const expected = (600 * 1.25 + 400 * 0.125) / 1_000_000;
  assert.ok(Math.abs(snap.totalCostUSD - expected) < 1e-12);
  assert.strictEqual(snap.inputTokens, 600);
  assert.strictEqual(snap.cachedInputTokens, 400);
});

test('output tokens billed at the output rate', () => {
  const root = freshRoot();
  writeSession(root, 's', [turn('gpt-5-codex'), tc({ input: 0, output: 500 })]);
  const snap = snapshotOf(root);
  assert.ok(Math.abs(snap.totalCostUSD - 500 * CODEX_OUT) < 1e-12);
  assert.strictEqual(snap.outputTokens, 500);
});

test('only today is counted; a midnight-spanning session diffs from its pre-today total', () => {
  const root = freshRoot();
  writeSession(root, 's', [
    turn('gpt-5-codex'),
    tc({ input: 500 }, yesterdayISO), // advances baseline, not counted
    tc({ input: 800 }, todayISO), // delta 300 counted today
  ]);
  const snap = snapshotOf(root);
  assert.ok(Math.abs(snap.totalCostUSD - 300 * CODEX_IN) < 1e-12);
  assert.strictEqual(snap.inputTokens, 300);
  assert.strictEqual(snap.sessions.count, 1);
});

test('a session with only pre-today activity contributes nothing today', () => {
  const root = freshRoot();
  writeSession(root, 's', [
    turn('gpt-5-codex'),
    tc({ input: 500 }, yesterdayISO),
  ]);
  const snap = snapshotOf(root);
  assert.strictEqual(snap.totalCostUSD, 0);
  assert.strictEqual(snap.sessions.count, 0);
});

test('truncation resets per-file state and replay is idempotent', () => {
  const root = freshRoot();
  const lines = [
    meta('s'),
    turn('gpt-5-codex'),
    tc({ input: 100 }),
    tc({ input: 300 }),
  ];
  const file = writeSession(root, 's', lines);
  const m = new CodexMonitor({ sessionsDir: root, pollMs: 999999 });
  m.tick(true);
  const before = m.buildSnapshot().totalCostUSD;
  assert.ok(before > 0);

  // Truncate to empty and tick while short → truncation detected, state reset.
  fs.writeFileSync(file, '');
  m.tick(false);
  assert.strictEqual(m.buildSnapshot().totalCostUSD, 0);

  // Rewrite identical content and tick → replay reproduces the exact total.
  fs.writeFileSync(file, lines.join('\n') + '\n');
  m.tick(false);
  const after = m.buildSnapshot().totalCostUSD;
  assert.ok(Math.abs(after - before) < 1e-12);
});

test('mixed session: per-model split, user turns (length only), sessions + max context', () => {
  const root = freshRoot();
  writeSession(root, 's', [
    meta('s', '/home/me/secret-project'),
    turn('gpt-5-codex'),
    tc({ input: 200, output: 100 }),
    userMsg('first prompt'),
    turn('gpt-5.3-codex'),
    tc({ input: 500, output: 300 }),
    userMsg('second, longer prompt here'),
  ]);
  const m = new CodexMonitor({ sessionsDir: root, pollMs: 999999 });
  m.tick(true);
  const snap = m.buildSnapshot();

  assert.deepStrictEqual(Object.keys(snap.perModel).sort(), [
    'gpt-5-codex',
    'gpt-5.3-codex',
  ]);
  assert.strictEqual(snap.userTurns.length, 2);
  assert.strictEqual(snap.userTurns[0].userTextLength, 'first prompt'.length);
  // The prompt text itself never appears in the snapshot.
  assert.ok(!JSON.stringify(snap).includes('first prompt'));
  assert.strictEqual(snap.sessions.count, 1);
  // maxContextTokens = peak (input+output) reading = 500 + 300.
  assert.strictEqual(snap.sessions.maxContextTokens, 800);
});

test('onInitialScanComplete and onUpdate both fire on the first tick', () => {
  const root = freshRoot();
  writeSession(root, 's', [turn('gpt-5-codex'), tc({ input: 100 })]);
  const m = new CodexMonitor({ sessionsDir: root, pollMs: 999999 });
  let initial = 0;
  let updates = 0;
  m.onInitialScanComplete = () => (initial += 1);
  m.onUpdate = () => (updates += 1);
  m.tick(true);
  assert.strictEqual(initial, 1);
  assert.strictEqual(updates, 1);
});
