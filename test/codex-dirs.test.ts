'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  codexHome,
  defaultCodexSessionsDir,
  discoverCodexFiles,
} from '../src/lib/codex-dirs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-codex-dirs-'));
const sessionsRoot = path.join(tmpRoot, 'sessions');

/** Create sessions/YYYY/MM/DD/rollout-<id>.jsonl for the given date. */
function makeRollout(d: Date, id: string): string {
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const dir = path.join(sessionsRoot, yyyy, mm, dd);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${id}.jsonl`);
  fs.writeFileSync(file, '{}\n');
  return file;
}

const now = new Date();
const todayStart = new Date(now);
todayStart.setHours(0, 0, 0, 0);
const yesterday = new Date(now.getTime() - 24 * 3600 * 1000);
const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000);
const longAgo = new Date(now.getTime() - 200 * 24 * 3600 * 1000);

test('CODEX_HOME overrides the default sessions dir', () => {
  const prev = process.env.CODEX_HOME;
  process.env.CODEX_HOME = '/custom/codex';
  try {
    assert.strictEqual(codexHome(), '/custom/codex');
    assert.strictEqual(
      defaultCodexSessionsDir(),
      path.join('/custom/codex', 'sessions')
    );
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test('discovers rollout files recursively under YYYY/MM/DD', () => {
  const todayFile = makeRollout(now, 'today');
  const found = discoverCodexFiles(sessionsRoot, todayStart.getTime());
  assert.ok(found.includes(todayFile));
});

test('day-dir prefilter skips clearly-old days', () => {
  const oldFile = makeRollout(longAgo, 'ancient');
  const found = discoverCodexFiles(sessionsRoot, todayStart.getTime());
  assert.ok(!found.includes(oldFile));
});

test('an old-dir session still being appended to today is included', () => {
  // `codex resume` keeps writing into the ORIGINAL rollout file, so a session
  // started weeks ago can have a fresh mtime while living in an old day-dir.
  const file = makeRollout(tenDaysAgo, 'resumed');
  fs.utimesSync(file, now, now);
  const found = discoverCodexFiles(sessionsRoot, todayStart.getTime());
  assert.ok(found.includes(file));
});

test('a yesterday-dir file appended today (fresh mtime) is included', () => {
  // File physically under yesterday's date dir, but modified now: the mtime
  // filter (>= todayStart) keeps it, and the 1-day slack keeps yesterday's dir.
  const file = makeRollout(yesterday, 'spanning');
  fs.utimesSync(file, now, now);
  const found = discoverCodexFiles(sessionsRoot, todayStart.getTime());
  assert.ok(found.includes(file));
});

test('non-rollout files are ignored', () => {
  const dir = path.dirname(makeRollout(now, 'marker'));
  const other = path.join(dir, 'notes.txt');
  fs.writeFileSync(other, 'x');
  const found = discoverCodexFiles(sessionsRoot, todayStart.getTime());
  assert.ok(!found.some((f) => f.endsWith('notes.txt')));
});
