'use strict';

import { test } from 'bun:test';
import assert from 'node:assert';
import {
  UpdateChecker,
  compareVersions,
  parseVersion,
  isNewerVersion,
  shouldNotify,
  REGISTRY_URL,
  DEFAULT_CHECK_INTERVAL_MS,
} from '../src/lib/update-checker';

// ── parseVersion ─────────────────────────────────────────────────────────────
test('parseVersion', () => {
  assert.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3], 'plain triple');
  assert.deepStrictEqual(parseVersion('v1.2.3'), [1, 2, 3], 'strips leading v');
  assert.deepStrictEqual(
    parseVersion('1.2.3-beta.1'),
    [1, 2, 3],
    'ignores prerelease suffix'
  );
  assert.deepStrictEqual(
    parseVersion('1.2.3+build9'),
    [1, 2, 3],
    'ignores build metadata'
  );
  assert.deepStrictEqual(
    parseVersion(' 1.0.0 '),
    [1, 0, 0],
    'trims whitespace'
  );
  assert.strictEqual(parseVersion('1.2'), null, 'too few components -> null');
  assert.strictEqual(
    parseVersion('1.x.3'),
    null,
    'non-numeric component -> null'
  );
  assert.strictEqual(parseVersion('garbage'), null, 'garbage -> null');
  assert.strictEqual(parseVersion(''), null, 'empty -> null');
  assert.strictEqual(parseVersion(null), null, 'non-string -> null');
  assert.strictEqual(parseVersion(123), null, 'number -> null');
});

// ── compareVersions (newer / older / equal / garbage / prerelease) ───────────
test('compareVersions', () => {
  // Equal
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0, 'equal');
  assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), 0, 'v-prefix equal');
  // Newer (a > b)
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1, 'patch bump');
  assert.strictEqual(
    compareVersions('1.1.0', '1.0.9'),
    1,
    'minor bump beats patch'
  );
  assert.strictEqual(
    compareVersions('2.0.0', '1.9.9'),
    1,
    'major bump beats all'
  );
  assert.strictEqual(
    compareVersions('1.0.10', '1.0.9'),
    1,
    'numeric not lexical (10 > 9)'
  );
  // Older (a < b)
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1, 'older patch');
  assert.strictEqual(compareVersions('1.0.9', '1.1.0'), -1, 'older minor');
  // Prerelease-ish: core version drives the comparison (suffix ignored).
  assert.strictEqual(
    compareVersions('1.2.3-beta', '1.2.3'),
    0,
    'prerelease core equals release'
  );
  assert.strictEqual(
    compareVersions('1.2.4-rc.1', '1.2.3'),
    1,
    'prerelease of a newer core is newer'
  );
  // Garbage: never sorts as greater than a valid version.
  assert.strictEqual(
    compareVersions('garbage', '1.0.0'),
    -1,
    'garbage a -> not newer'
  );
  assert.strictEqual(
    compareVersions('1.0.0', 'garbage'),
    1,
    'valid beats garbage b'
  );
  assert.strictEqual(
    compareVersions('junk', 'junk'),
    0,
    'two garbage -> equal'
  );
});

// ── isNewerVersion ───────────────────────────────────────────────────────────
test('isNewerVersion', () => {
  assert.strictEqual(isNewerVersion('1.0.2', '1.0.1'), true, 'strictly newer');
  assert.strictEqual(
    isNewerVersion('1.0.1', '1.0.1'),
    false,
    'equal is not newer'
  );
  assert.strictEqual(
    isNewerVersion('1.0.0', '1.0.1'),
    false,
    'older is not newer'
  );
  assert.strictEqual(
    isNewerVersion('garbage', '1.0.0'),
    false,
    'garbage is never newer'
  );
});

// ── shouldNotify (once-per-version gating) ───────────────────────────────────
test('shouldNotify', () => {
  // Fresh install: nothing notified yet -> notify for any valid version.
  assert.strictEqual(
    shouldNotify('1.0.2', null),
    true,
    'first notify with no prior'
  );
  assert.strictEqual(
    shouldNotify('1.0.2', undefined),
    true,
    'undefined prior -> notify'
  );
  assert.strictEqual(shouldNotify('1.0.2', ''), true, 'empty prior -> notify');
  // Already notified for this exact version -> stay quiet (relaunch case).
  assert.strictEqual(
    shouldNotify('1.0.2', '1.0.2'),
    false,
    'same version -> no re-notify'
  );
  // Already notified for a newer one -> quiet.
  assert.strictEqual(
    shouldNotify('1.0.2', '1.0.3'),
    false,
    'older than last-notified -> quiet'
  );
  // A brand-new higher version after a prior notify -> notify again.
  assert.strictEqual(
    shouldNotify('1.0.3', '1.0.2'),
    true,
    'newer than last-notified -> notify'
  );
  // Garbage version is never notified.
  assert.strictEqual(
    shouldNotify('garbage', null),
    false,
    'garbage version -> never notify'
  );
});

// ── checkNow: newer / same / error / timeout (all fail-silent) ───────────────
const CURRENT = '1.0.1';

test('checkNow: newer -> {version} + fires callback once', async () => {
  let hits = 0;
  let seen: { version: string } | null = null;
  const fetchImpl = async (url: string) => {
    assert.strictEqual(
      url,
      REGISTRY_URL,
      'hits the npm registry latest endpoint'
    );
    return { ok: true, status: 200, json: async () => ({ version: '1.2.0' }) };
  };
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl,
    onUpdateAvailable: (info) => {
      hits++;
      seen = info;
    },
  });
  const res = await c.checkNow();
  assert.deepStrictEqual(res, { version: '1.2.0' }, 'newer -> {version}');
  assert.strictEqual(hits, 1, 'onUpdateAvailable fired once');
  assert.deepStrictEqual(
    seen,
    { version: '1.2.0' },
    'callback gets the version'
  );
});

test('checkNow: same version -> null, no callback', async () => {
  let hits = 0;
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: CURRENT }),
    }),
    onUpdateAvailable: () => {
      hits++;
    },
  });
  assert.strictEqual(await c.checkNow(), null, 'same version -> null');
  assert.strictEqual(hits, 0, 'no callback when up to date');
});

test('checkNow: older published -> null', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '0.9.0' }),
    }),
  });
  assert.strictEqual(await c.checkNow(), null, 'older published -> null');
});

test('checkNow: network error -> null, no throw', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => {
      throw new Error('ECONNREFUSED');
    },
  });
  assert.strictEqual(
    await c.checkNow(),
    null,
    'network error -> null, no throw'
  );
});

test('checkNow: timeout/abort -> null, no throw', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async (_url: string, opts: unknown) => {
      // Simulate an aborted request.
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      assert.ok(
        opts && (opts as { signal?: unknown }).signal,
        'a signal is passed for timeout support'
      );
      throw err;
    },
  });
  assert.strictEqual(
    await c.checkNow(),
    null,
    'timeout/abort -> null, no throw'
  );
});

test('checkNow: bad status -> null', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
  });
  assert.strictEqual(await c.checkNow(), null, 'bad status -> null');
});

test('checkNow: malformed JSON -> null', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('bad json');
      },
    }),
  });
  assert.strictEqual(await c.checkNow(), null, 'malformed JSON -> null');
});

test('checkNow: no version field -> null', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ name: 'x' }),
    }),
  });
  assert.strictEqual(await c.checkNow(), null, 'no version field -> null');
});

test('checkNow: no fetchImpl -> null', async () => {
  // An explicit fetchImpl: null means "no network" and is honored as-is (never
  // replaced with global fetch), so checkNow short-circuits without a request.
  const c = new UpdateChecker({ currentVersion: CURRENT, fetchImpl: null });
  assert.strictEqual(c.fetchImpl, null, 'explicit null fetchImpl is preserved');
  assert.strictEqual(await c.checkNow(), null, 'no fetchImpl -> null');
});

test('checkNow: throwing onUpdateAvailable is swallowed', async () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: '2.0.0' }),
    }),
    onUpdateAvailable: () => {
      throw new Error('callback blew up');
    },
  });
  assert.deepStrictEqual(
    await c.checkNow(),
    { version: '2.0.0' },
    'callback error is swallowed'
  );
});

// ── checkIntervalMs bounds (no per-ms request storm) ─────────────────────────
test('checkIntervalMs out-of-range -> default', () => {
  // A valid in-range value is respected.
  assert.strictEqual(
    new UpdateChecker({ currentVersion: CURRENT, checkIntervalMs: 60000 })
      .checkIntervalMs,
    60000,
    'in-range interval respected'
  );
  // Too small -> default.
  assert.strictEqual(
    new UpdateChecker({ currentVersion: CURRENT, checkIntervalMs: 5 })
      .checkIntervalMs,
    DEFAULT_CHECK_INTERVAL_MS,
    'too-small interval -> default'
  );
  // Over 2^31-1 ms -> default: Node would clamp such a setInterval delay to
  // 1ms, turning the check into a per-ms registry request storm.
  assert.strictEqual(
    new UpdateChecker({
      currentVersion: CURRENT,
      checkIntervalMs: 9999999999000,
    }).checkIntervalMs,
    DEFAULT_CHECK_INTERVAL_MS,
    'over-32-bit interval -> default (no per-ms storm)'
  );
});

// ── start()/stop(): timers are created, unref'd, and cleaned up ────────────
test('start/stop lifecycle', () => {
  const c = new UpdateChecker({
    currentVersion: CURRENT,
    checkIntervalMs: 60000,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ version: CURRENT }),
    }),
  });
  c.start();
  assert.ok(c.timer, 'interval timer set on start');
  assert.ok(c.initialTimer, 'initial delay timer set on start');
  c.stop();
  assert.strictEqual(c.timer, null, 'interval timer cleared on stop');
  assert.strictEqual(c.initialTimer, null, 'initial timer cleared on stop');
});
