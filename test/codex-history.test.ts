'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanRange, dayKey } from '../src/lib/history';

const now = new Date();
const todayISO = now.toISOString();
const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
const yesterdayISO = yesterday.toISOString();

const yyyy = String(now.getFullYear());
const mm = String(now.getMonth() + 1).padStart(2, '0');
const dd = String(now.getDate()).padStart(2, '0');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-codex-hist-'));
const emptyProjects = path.join(tmp, 'projects'); // no Claude logs
fs.mkdirSync(emptyProjects, { recursive: true });

function writeSession(root: string, id: string, lines: object[]): void {
  const dir = path.join(root, yyyy, mm, dd);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `rollout-${id}.jsonl`),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
  );
}

const turn = (model: string) => ({
  type: 'turn_context',
  timestamp: todayISO,
  payload: { model },
});
const tc = (input: number, ts: string) => ({
  type: 'event_msg',
  timestamp: ts,
  payload: {
    type: 'token_count',
    info: {
      total_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
        total_tokens: input,
      },
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: 0,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
    },
  },
});

const CODEX_IN = 1.25 / 1_000_000;

test('Codex spend appears in the "today" range', async () => {
  const root = path.join(tmp, 's-today', 'sessions');
  writeSession(root, 's', [turn('gpt-5-codex'), tc(400, todayISO)]);

  const res = await scanRange({
    projectsDir: emptyProjects,
    coworkSessionsDir: null,
    codexSessionsDir: root,
    rangeId: 'today',
    now,
  });
  assert.ok(Math.abs(res.totalCostUSD - 400 * CODEX_IN) < 1e-12);
  assert.strictEqual(res.entryCount, 1);
});

test('a midnight-spanning Codex session splits across two day buckets', async () => {
  const root = path.join(tmp, 's-span', 'sessions');
  writeSession(root, 's', [
    turn('gpt-5-codex'),
    tc(500, yesterdayISO), // cumulative 500 yesterday
    tc(800, todayISO), // delta 300 today
  ]);

  const res = await scanRange({
    projectsDir: emptyProjects,
    coworkSessionsDir: null,
    codexSessionsDir: root,
    rangeId: 'last7days',
    now,
  });

  const byDate = new Map(res.days.map((d) => [d.date, d.costUSD]));
  const yKey = dayKey(yesterday);
  const tKey = dayKey(now);
  assert.ok(Math.abs((byDate.get(yKey) || 0) - 500 * CODEX_IN) < 1e-12);
  assert.ok(Math.abs((byDate.get(tKey) || 0) - 300 * CODEX_IN) < 1e-12);
});

test('no Codex dir configured → no Codex contribution', async () => {
  const res = await scanRange({
    projectsDir: emptyProjects,
    coworkSessionsDir: null,
    codexSessionsDir: null,
    rangeId: 'today',
    now,
  });
  assert.strictEqual(res.totalCostUSD, 0);
});
