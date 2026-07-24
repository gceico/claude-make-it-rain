'use strict';

import { test, afterAll } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  AnalyticsStore,
  normalizeAnalyticsData,
  defaultAnalyticsData,
  emptyDailySnapshot,
  CURRENT_SCHEMA_VERSION,
} from '../src/lib/analytics-store';

const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'mir-analytics-store-test-')
);

test('defaults when file is missing', () => {
  const store = new AnalyticsStore(path.join(tmpRoot, 'missing.json'));
  assert.deepStrictEqual(store.data, defaultAnalyticsData());
});

test('defaults when file is corrupt', () => {
  const filePath = path.join(tmpRoot, 'corrupt.json');
  fs.writeFileSync(filePath, '{ not: valid json');
  const store = new AnalyticsStore(filePath);
  assert.strictEqual(store.data.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.deepStrictEqual(store.data.dailySnapshots, {});
});

test('round-trip: save then reload preserves data', () => {
  const filePath = path.join(tmpRoot, 'roundtrip.json');
  const store = new AnalyticsStore(filePath);
  const snap = emptyDailySnapshot();
  snap.costUSD = 12.5;
  snap.perModel['claude-sonnet-5'] = { costUSD: 12.5, inTok: 100, outTok: 50 };
  snap.cache = { readTok: 500, creationTok: 20, hitRatio: 0.8 };
  snap.habitCounts['caching-off'] = 1;
  store.setDay('2026-07-20', snap);
  store.setToolingState('rtk', {
    installed: true,
    version: '1.2.3',
    detectedAtMs: 1234,
  });
  store.addOptimizeMilestone({
    atMs: 5678,
    tools: ['rtk'],
    baselineCostRate: 0.5,
  });
  store.setSavings({ lifetimeUSD: 3.14, lastReportedUSD: 1.0 });

  const reloaded = new AnalyticsStore(filePath);
  assert.deepStrictEqual(reloaded.getDay('2026-07-20'), snap);
  assert.strictEqual(reloaded.data.toolingState.rtk.installed, true);
  assert.strictEqual(reloaded.data.toolingState.rtk.version, '1.2.3');
  assert.strictEqual(reloaded.data.optimizeMilestones.length, 1);
  assert.strictEqual(reloaded.data.optimizeMilestones[0]!.tools[0], 'rtk');
  assert.strictEqual(reloaded.data.savings.lifetimeUSD, 3.14);
});

test('atomic write: no .tmp file left behind after save', () => {
  const filePath = path.join(tmpRoot, 'atomic.json');
  const store = new AnalyticsStore(filePath);
  store.setDay('2026-07-21', emptyDailySnapshot());
  assert.ok(fs.existsSync(filePath), 'real file exists');
  assert.ok(!fs.existsSync(filePath + '.tmp'), 'tmp file cleaned up');
});

test('getDay returns an empty snapshot for an unknown day', () => {
  const store = new AnalyticsStore(path.join(tmpRoot, 'unknown-day.json'));
  assert.deepStrictEqual(store.getDay('2020-01-01'), emptyDailySnapshot());
});

test('schemaVersion migration: unversioned/old data still normalizes cleanly', () => {
  const data = normalizeAnalyticsData({
    // No schemaVersion at all (simulates a pre-schema or hand-edited file).
    dailySnapshots: {
      '2026-01-01': { costUSD: 5 },
    },
  });
  assert.strictEqual(data.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.strictEqual(data.dailySnapshots['2026-01-01']!.costUSD, 5);
  assert.deepStrictEqual(data.dailySnapshots['2026-01-01']!.perModel, {});
});

test('normalizeAnalyticsData tolerates garbage input', () => {
  assert.deepStrictEqual(normalizeAnalyticsData(null), defaultAnalyticsData());
  assert.deepStrictEqual(
    normalizeAnalyticsData('not an object'),
    defaultAnalyticsData()
  );
  assert.deepStrictEqual(normalizeAnalyticsData(42), defaultAnalyticsData());
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
