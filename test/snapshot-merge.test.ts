'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import type { Snapshot } from '../src/lib/usage-monitor';
import { emptyCodexSnapshot } from '../src/lib/codex-monitor';
import type { CodexSnapshot } from '../src/lib/codex-monitor';
import { mergeSnapshots } from '../src/lib/snapshot-merge';

function claudeSnap(): Snapshot {
  return {
    totalCostUSD: 2,
    inputTokens: 1000,
    outputTokens: 500,
    entryCount: 3,
    perModel: {
      'claude-opus-5': { costUSD: 2, inputTokens: 1000, outputTokens: 500 },
    },
    cache: { readTokens: 400, creationTokens: 200 },
    sessions: { count: 2, maxContextTokens: 1500 },
    userTurns: [{ sessionId: 'c1', userTextLength: 10, timestampMs: 1 }],
    sessionGaps: [
      { sessionId: 'c1', gapMs: 600000, cacheCreationTokensAfterGap: 100 },
    ],
    fileReads: [{ sessionId: 'c1', lines: 600, ext: '.ts', timestampMs: 1 }],
    projectDirs: ['/Users/me/proj'],
    agentsMdLines: 0,
  };
}

function codexSnap(): CodexSnapshot {
  const s = emptyCodexSnapshot();
  s.totalCostUSD = 1;
  s.inputTokens = 300;
  s.outputTokens = 200;
  s.cachedInputTokens = 150;
  s.entryCount = 2;
  s.perModel = {
    'gpt-5-codex': { costUSD: 1, inputTokens: 300, outputTokens: 200 },
  };
  s.sessions = { count: 1, maxContextTokens: 900 };
  s.userTurns = [{ sessionId: 'x1', userTextLength: 25, timestampMs: 2 }];
  s.fileReads = [];
  s.agentsMdLines = 340;
  return s;
}

test('totals and tokens sum across both sources', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.strictEqual(m.totalCostUSD, 3);
  assert.strictEqual(m.inputTokens, 1300);
  assert.strictEqual(m.outputTokens, 700);
  assert.strictEqual(m.entryCount, 5);
});

test('perModel is a union — Claude and Codex model keys coexist', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.deepStrictEqual(Object.keys(m.perModel).sort(), [
    'claude-opus-5',
    'gpt-5-codex',
  ]);
  assert.strictEqual(m.perModel['gpt-5-codex'].costUSD, 1);
});

test('Codex cached input feeds the combined cache-read total; creation stays Claude', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.strictEqual(m.cache.readTokens, 400 + 150);
  assert.strictEqual(m.cache.creationTokens, 200);
});

test('sessions sum, max context takes the peak, user turns concat', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.strictEqual(m.sessions.count, 3);
  assert.strictEqual(m.sessions.maxContextTokens, 1500);
  assert.strictEqual(m.userTurns.length, 2);
});

test('sessionGaps stays Claude-only (Codex has no cache-creation signal)', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.strictEqual(m.sessionGaps.length, 1);
  assert.strictEqual(m.sessionGaps[0].sessionId, 'c1');
});

test('fileReads concatenates; projectDirs stays Claude-only', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.strictEqual(m.fileReads.length, 1);
  assert.strictEqual(m.fileReads[0].lines, 600);
  assert.deepStrictEqual(m.projectDirs, ['/Users/me/proj']);
});

test('agentsMdLines is Codex-only, mirroring projectDirs the other way', () => {
  const m = mergeSnapshots(claudeSnap(), codexSnap());
  assert.strictEqual(m.agentsMdLines, 340);
  const noCodex = mergeSnapshots(claudeSnap(), emptyCodexSnapshot());
  assert.strictEqual(noCodex.agentsMdLines, 0);
});

test('merging an empty Codex snapshot is a no-op on the Claude total', () => {
  const claude = claudeSnap();
  const m = mergeSnapshots(claude, emptyCodexSnapshot());
  assert.strictEqual(m.totalCostUSD, claude.totalCostUSD);
  assert.deepStrictEqual(Object.keys(m.perModel), ['claude-opus-5']);
});
