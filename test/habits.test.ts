'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import {
  cachingOff,
  modelSkew,
  longSessions,
  staleCacheIdle,
  rtkMissing,
  cavemanMissing,
  ponytailMissing,
  giantPaste,
  rageRetry,
  bloatedClaudeMd,
  bloatedAgentsMd,
  bigFileReads,
  modelSplit,
  cacheRate,
  estimateAccuracy,
  runHabitDetectors,
  habitOfTheDay,
} from '../src/lib/habits';
import type { HabitInput } from '../src/lib/habits';
import { emptyDailySnapshot } from '../src/lib/analytics-store';
import type { ToolingState } from '../src/lib/analytics-store';

function noTools(): ToolingState {
  return {
    rtk: { installed: false, version: null, detectedAtMs: 0 },
    caveman: { installed: false, version: null, detectedAtMs: 0 },
    ponytail: { installed: false, version: null, detectedAtMs: 0 },
  };
}

function allTools(): ToolingState {
  return {
    rtk: { installed: true, version: '1.0.0', detectedAtMs: 1 },
    caveman: { installed: true, version: '1.0.0', detectedAtMs: 1 },
    ponytail: { installed: true, version: '1.0.0', detectedAtMs: 1 },
  };
}

function baseInput(overrides: Partial<HabitInput> = {}): HabitInput {
  return {
    snapshot: emptyDailySnapshot(),
    toolingState: noTools(),
    userTurns: [],
    sessionGaps: [],
    fileReads: [],
    claudeMd: [],
    agentsMd: 0,
    ...overrides,
  };
}

test('caching-off: triggers on near-zero hit ratio with cache activity', () => {
  const snap = emptyDailySnapshot();
  snap.cache = { readTok: 10, creationTok: 10_000, hitRatio: 0.001 };
  const r = cachingOff(baseInput({ snapshot: snap }));
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.id, 'caching-off');
});

test('caching-off: does not trigger with healthy hit ratio', () => {
  const snap = emptyDailySnapshot();
  snap.cache = { readTok: 9000, creationTok: 1000, hitRatio: 0.9 };
  const r = cachingOff(baseInput({ snapshot: snap }));
  assert.strictEqual(r.triggered, false);
});

test('caching-off: does not trigger when no cache activity at all', () => {
  const r = cachingOff(baseInput());
  assert.strictEqual(r.triggered, false);
});

test('model-skew: triggers when opus/fable dominate output tokens', () => {
  const snap = emptyDailySnapshot();
  snap.perModel['claude-opus-4-8'] = { costUSD: 10, inTok: 100, outTok: 900 };
  snap.perModel['claude-sonnet-5'] = { costUSD: 1, inTok: 100, outTok: 100 };
  const r = modelSkew(baseInput({ snapshot: snap }));
  assert.strictEqual(r.triggered, true);
});

test('model-skew: does not trigger on a healthy mix', () => {
  const snap = emptyDailySnapshot();
  snap.perModel['claude-opus-4-8'] = { costUSD: 1, inTok: 100, outTok: 300 };
  snap.perModel['claude-sonnet-5'] = { costUSD: 1, inTok: 100, outTok: 700 };
  const r = modelSkew(baseInput({ snapshot: snap }));
  assert.strictEqual(r.triggered, false);
});

test('long-sessions: triggers past ~150-200k context tokens', () => {
  const snap = emptyDailySnapshot();
  snap.sessions = { count: 1, maxContextTokens: 180_000 };
  assert.strictEqual(
    longSessions(baseInput({ snapshot: snap })).triggered,
    true
  );

  const snap2 = emptyDailySnapshot();
  snap2.sessions = { count: 1, maxContextTokens: 50_000 };
  assert.strictEqual(
    longSessions(baseInput({ snapshot: snap2 })).triggered,
    false
  );
});

test('stale-cache-idle: triggers on a >5min gap followed by a cache spike', () => {
  const r = staleCacheIdle(
    baseInput({
      sessionGaps: [
        {
          sessionId: 's1',
          gapMs: 6 * 60 * 1000,
          cacheCreationTokensAfterGap: 20_000,
        },
      ],
    })
  );
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.count, 1);
});

test('stale-cache-idle: does not trigger on a short gap or no spike', () => {
  const r = staleCacheIdle(
    baseInput({
      sessionGaps: [
        {
          sessionId: 's1',
          gapMs: 60 * 1000,
          cacheCreationTokensAfterGap: 20_000,
        },
        {
          sessionId: 's2',
          gapMs: 6 * 60 * 1000,
          cacheCreationTokensAfterGap: 100,
        },
      ],
    })
  );
  assert.strictEqual(r.triggered, false);
});

test('tool-missing detectors reflect toolingState', () => {
  assert.strictEqual(
    rtkMissing(baseInput({ toolingState: noTools() })).triggered,
    true
  );
  assert.strictEqual(
    cavemanMissing(baseInput({ toolingState: noTools() })).triggered,
    true
  );
  assert.strictEqual(
    ponytailMissing(baseInput({ toolingState: noTools() })).triggered,
    true
  );
  assert.strictEqual(
    rtkMissing(baseInput({ toolingState: allTools() })).triggered,
    false
  );
  assert.strictEqual(
    cavemanMissing(baseInput({ toolingState: allTools() })).triggered,
    false
  );
  assert.strictEqual(
    ponytailMissing(baseInput({ toolingState: allTools() })).triggered,
    false
  );
});

test('giant-paste: triggers on a very large single userTextLength', () => {
  const r = giantPaste(
    baseInput({
      userTurns: [{ sessionId: 's1', userTextLength: 25_000, timestampMs: 0 }],
    })
  );
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.count, 1);
});

test('giant-paste: does not trigger on normal-sized turns', () => {
  const r = giantPaste(
    baseInput({
      userTurns: [
        { sessionId: 's1', userTextLength: 200, timestampMs: 0 },
        { sessionId: 's1', userTextLength: 500, timestampMs: 1000 },
      ],
    })
  );
  assert.strictEqual(r.triggered, false);
});

test('rage-retry: triggers on several similar-sized turns in a short window', () => {
  const r = rageRetry(
    baseInput({
      userTurns: [
        { sessionId: 's1', userTextLength: 100, timestampMs: 0 },
        { sessionId: 's1', userTextLength: 105, timestampMs: 10_000 },
        { sessionId: 's1', userTextLength: 98, timestampMs: 20_000 },
      ],
    })
  );
  assert.strictEqual(r.triggered, true);
});

test('rage-retry: conservative — does not trigger on legit varied iteration', () => {
  const r = rageRetry(
    baseInput({
      userTurns: [
        { sessionId: 's1', userTextLength: 100, timestampMs: 0 },
        { sessionId: 's1', userTextLength: 400, timestampMs: 60_000 },
        { sessionId: 's1', userTextLength: 900, timestampMs: 120_000 },
      ],
    })
  );
  assert.strictEqual(r.triggered, false);
});

test('rage-retry: does not trigger when similar turns are far apart in time', () => {
  const r = rageRetry(
    baseInput({
      userTurns: [
        { sessionId: 's1', userTextLength: 100, timestampMs: 0 },
        { sessionId: 's1', userTextLength: 100, timestampMs: 10 * 60 * 1000 },
        { sessionId: 's1', userTextLength: 100, timestampMs: 20 * 60 * 1000 },
      ],
    })
  );
  assert.strictEqual(r.triggered, false);
});

test('bloated-claude-md: triggers when a project chain exceeds 200 lines', () => {
  const r = bloatedClaudeMd(
    baseInput({ claudeMd: [{ projectKey: 'p1', totalLines: 340 }] })
  );
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.count, 1);
  assert.ok(r.coachCopy.includes('340'));
});

test('bloated-claude-md: does not trigger at/under 200 lines', () => {
  const r200 = bloatedClaudeMd(
    baseInput({ claudeMd: [{ projectKey: 'p1', totalLines: 200 }] })
  );
  assert.strictEqual(r200.triggered, false, 'exactly 200 lines is not over');
  const r201 = bloatedClaudeMd(
    baseInput({ claudeMd: [{ projectKey: 'p1', totalLines: 201 }] })
  );
  assert.strictEqual(r201.triggered, true, '201 lines is over');
});

test('bloated-claude-md: not triggered copy shows the largest chain seen', () => {
  const r = bloatedClaudeMd(
    baseInput({
      claudeMd: [
        { projectKey: 'p1', totalLines: 40 },
        { projectKey: 'p2', totalLines: 187 },
      ],
    })
  );
  assert.strictEqual(r.triggered, false);
  assert.ok(r.coachCopy.includes('187'));
});

test('bloated-agents-md: triggers when Codex loaded over 200 lines of AGENTS.md', () => {
  const r = bloatedAgentsMd(baseInput({ agentsMd: 340 }));
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.count, 1);
  assert.ok(r.coachCopy.includes('340'));
});

test('bloated-agents-md: does not trigger at/under 200 lines', () => {
  const r200 = bloatedAgentsMd(baseInput({ agentsMd: 200 }));
  assert.strictEqual(r200.triggered, false, 'exactly 200 lines is not over');
  const r201 = bloatedAgentsMd(baseInput({ agentsMd: 201 }));
  assert.strictEqual(r201.triggered, true, '201 lines is over');
});

test('bloated-agents-md: not-triggered copy shows the line count, including zero', () => {
  const r = bloatedAgentsMd(baseInput({ agentsMd: 0 }));
  assert.strictEqual(r.triggered, false);
  assert.ok(r.coachCopy.includes('0'));
});

test('big-file-reads: triggers on a Read of 500+ lines', () => {
  const r = bigFileReads(
    baseInput({
      fileReads: [
        { sessionId: 's1', lines: 499, ext: '.ts', timestampMs: 0 },
        { sessionId: 's1', lines: 1200, ext: '.ts', timestampMs: 1 },
      ],
    })
  );
  assert.strictEqual(r.triggered, true);
  assert.strictEqual(r.count, 1, 'only the 500+ read counts');
  assert.ok(r.coachCopy.includes('1.2k'), r.coachCopy);
});

test('big-file-reads: does not trigger under 500 lines', () => {
  const r = bigFileReads(
    baseInput({
      fileReads: [{ sessionId: 's1', lines: 499, ext: '.ts', timestampMs: 0 }],
    })
  );
  assert.strictEqual(r.triggered, false);
});

test('awareness facts are always triggered (never "bad")', () => {
  const snap = emptyDailySnapshot();
  snap.costUSD = 10;
  snap.perModel['claude-sonnet-5'] = { costUSD: 10, inTok: 100, outTok: 100 };
  snap.cache = { readTok: 0, creationTok: 0, hitRatio: 0 };
  const input = baseInput({ snapshot: snap });
  assert.strictEqual(modelSplit(input).triggered, true);
  assert.strictEqual(cacheRate(input).triggered, true);
  assert.strictEqual(estimateAccuracy(input).triggered, true);
});

test('runHabitDetectors returns all fifteen results in order', () => {
  const results = runHabitDetectors(baseInput());
  assert.strictEqual(results.length, 15);
  assert.strictEqual(results[0]!.id, 'caching-off');
});

test('habitOfTheDay is deterministic per dayIndex and rotates', () => {
  const results = runHabitDetectors(
    baseInput({ toolingState: noTools() }) // rtk/caveman/ponytail all triggered
  );
  const dayA = new Date(2026, 5, 15);
  const dayB = new Date(2026, 5, 16);
  const pickA1 = habitOfTheDay(results, dayA);
  const pickA2 = habitOfTheDay(results, dayA);
  assert.deepStrictEqual(pickA1, pickA2, 'same day -> same pick');
  // Not asserting pickA !== pickB (small pool could coincide), just that both
  // are valid, triggered results.
  const pickB = habitOfTheDay(results, dayB);
  assert.ok(pickA1 && pickA1.triggered);
  assert.ok(pickB && pickB.triggered);
});

test('habitOfTheDay falls back to full list when nothing is triggered', () => {
  const results = runHabitDetectors(baseInput({ toolingState: allTools() }));
  const nonInfoTriggered = results.filter(
    (r) => r.triggered && r.severity !== 'info'
  );
  // With all tools installed, healthy cache, no gaps/pastes: only the
  // always-on 'info' facts should be triggered.
  assert.strictEqual(nonInfoTriggered.length, 0);
  const pick = habitOfTheDay(results, new Date(2026, 5, 15));
  assert.ok(pick);
});
