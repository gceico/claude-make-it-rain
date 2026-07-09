'use strict';

const assert = require('assert');
const {
  UpdateChecker,
  compareVersions,
  parseVersion,
  isNewerVersion,
  shouldNotify,
  REGISTRY_URL,
} = require('../lib/update-checker');

// ── parseVersion ─────────────────────────────────────────────────────────────
{
  assert.deepStrictEqual(parseVersion('1.2.3'), [1, 2, 3], 'plain triple');
  assert.deepStrictEqual(parseVersion('v1.2.3'), [1, 2, 3], 'strips leading v');
  assert.deepStrictEqual(parseVersion('1.2.3-beta.1'), [1, 2, 3], 'ignores prerelease suffix');
  assert.deepStrictEqual(parseVersion('1.2.3+build9'), [1, 2, 3], 'ignores build metadata');
  assert.deepStrictEqual(parseVersion(' 1.0.0 '), [1, 0, 0], 'trims whitespace');
  assert.strictEqual(parseVersion('1.2'), null, 'too few components -> null');
  assert.strictEqual(parseVersion('1.x.3'), null, 'non-numeric component -> null');
  assert.strictEqual(parseVersion('garbage'), null, 'garbage -> null');
  assert.strictEqual(parseVersion(''), null, 'empty -> null');
  assert.strictEqual(parseVersion(null), null, 'non-string -> null');
  assert.strictEqual(parseVersion(123), null, 'number -> null');
  console.log('parseVersion: OK');
}

// ── compareVersions (newer / older / equal / garbage / prerelease) ───────────
{
  // Equal
  assert.strictEqual(compareVersions('1.0.0', '1.0.0'), 0, 'equal');
  assert.strictEqual(compareVersions('v1.2.3', '1.2.3'), 0, 'v-prefix equal');
  // Newer (a > b)
  assert.strictEqual(compareVersions('1.0.1', '1.0.0'), 1, 'patch bump');
  assert.strictEqual(compareVersions('1.1.0', '1.0.9'), 1, 'minor bump beats patch');
  assert.strictEqual(compareVersions('2.0.0', '1.9.9'), 1, 'major bump beats all');
  assert.strictEqual(compareVersions('1.0.10', '1.0.9'), 1, 'numeric not lexical (10 > 9)');
  // Older (a < b)
  assert.strictEqual(compareVersions('1.0.0', '1.0.1'), -1, 'older patch');
  assert.strictEqual(compareVersions('1.0.9', '1.1.0'), -1, 'older minor');
  // Prerelease-ish: core version drives the comparison (suffix ignored).
  assert.strictEqual(compareVersions('1.2.3-beta', '1.2.3'), 0, 'prerelease core equals release');
  assert.strictEqual(compareVersions('1.2.4-rc.1', '1.2.3'), 1, 'prerelease of a newer core is newer');
  // Garbage: never sorts as greater than a valid version.
  assert.strictEqual(compareVersions('garbage', '1.0.0'), -1, 'garbage a -> not newer');
  assert.strictEqual(compareVersions('1.0.0', 'garbage'), 1, 'valid beats garbage b');
  assert.strictEqual(compareVersions('junk', 'junk'), 0, 'two garbage -> equal');
  console.log('compareVersions: OK');
}

// ── isNewerVersion ───────────────────────────────────────────────────────────
{
  assert.strictEqual(isNewerVersion('1.0.2', '1.0.1'), true, 'strictly newer');
  assert.strictEqual(isNewerVersion('1.0.1', '1.0.1'), false, 'equal is not newer');
  assert.strictEqual(isNewerVersion('1.0.0', '1.0.1'), false, 'older is not newer');
  assert.strictEqual(isNewerVersion('garbage', '1.0.0'), false, 'garbage is never newer');
  console.log('isNewerVersion: OK');
}

// ── shouldNotify (once-per-version gating) ───────────────────────────────────
{
  // Fresh install: nothing notified yet -> notify for any valid version.
  assert.strictEqual(shouldNotify('1.0.2', null), true, 'first notify with no prior');
  assert.strictEqual(shouldNotify('1.0.2', undefined), true, 'undefined prior -> notify');
  assert.strictEqual(shouldNotify('1.0.2', ''), true, 'empty prior -> notify');
  // Already notified for this exact version -> stay quiet (relaunch case).
  assert.strictEqual(shouldNotify('1.0.2', '1.0.2'), false, 'same version -> no re-notify');
  // Already notified for a newer one -> quiet.
  assert.strictEqual(shouldNotify('1.0.2', '1.0.3'), false, 'older than last-notified -> quiet');
  // A brand-new higher version after a prior notify -> notify again.
  assert.strictEqual(shouldNotify('1.0.3', '1.0.2'), true, 'newer than last-notified -> notify');
  // Garbage version is never notified.
  assert.strictEqual(shouldNotify('garbage', null), false, 'garbage version -> never notify');
  console.log('shouldNotify: OK');
}

// ── checkNow: newer / same / error / timeout (all fail-silent) ───────────────
(async () => {
  const CURRENT = '1.0.1';

  // Newer: resolves {version} and fires onUpdateAvailable exactly once.
  {
    let hits = 0;
    let seen = null;
    const fetchImpl = async (url) => {
      assert.strictEqual(url, REGISTRY_URL, 'hits the npm registry latest endpoint');
      return { ok: true, status: 200, json: async () => ({ version: '1.2.0' }) };
    };
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl,
      onUpdateAvailable: (info) => { hits++; seen = info; },
    });
    const res = await c.checkNow();
    assert.deepStrictEqual(res, { version: '1.2.0' }, 'newer -> {version}');
    assert.strictEqual(hits, 1, 'onUpdateAvailable fired once');
    assert.deepStrictEqual(seen, { version: '1.2.0' }, 'callback gets the version');
  }

  // Same version: resolves null, no callback.
  {
    let hits = 0;
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: CURRENT }) }),
      onUpdateAvailable: () => { hits++; },
    });
    assert.strictEqual(await c.checkNow(), null, 'same version -> null');
    assert.strictEqual(hits, 0, 'no callback when up to date');
  }

  // Older published version (registry behind us): null.
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: '0.9.0' }) }),
    });
    assert.strictEqual(await c.checkNow(), null, 'older published -> null');
  }

  // Network error: fail-silent (null, no throw).
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    });
    assert.strictEqual(await c.checkNow(), null, 'network error -> null, no throw');
  }

  // Timeout / abort: fetch rejects with an AbortError-like error -> null.
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async (_url, opts) => {
        // Simulate an aborted request.
        const err = new Error('The operation was aborted');
        err.name = 'AbortError';
        assert.ok(opts && opts.signal, 'a signal is passed for timeout support');
        throw err;
      },
    });
    assert.strictEqual(await c.checkNow(), null, 'timeout/abort -> null, no throw');
  }

  // Bad status (e.g. 500): null.
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }),
    });
    assert.strictEqual(await c.checkNow(), null, 'bad status -> null');
  }

  // Malformed JSON body: json() throws -> null (no crash).
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } }),
    });
    assert.strictEqual(await c.checkNow(), null, 'malformed JSON -> null');
  }

  // Missing version field: null.
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ name: 'x' }) }),
    });
    assert.strictEqual(await c.checkNow(), null, 'no version field -> null');
  }

  // No fetch available at all: null, never throws. The constructor falls back
  // to global fetch when none is injected, so to exercise the guard for an
  // environment without fetch we null it on the instance (rather than passing
  // fetchImpl: null, which the fallback would replace with global fetch and
  // send a real network request).
  {
    const c = new UpdateChecker({ currentVersion: CURRENT });
    c.fetchImpl = null;
    assert.strictEqual(await c.checkNow(), null, 'no fetchImpl -> null');
  }

  // A throwing onUpdateAvailable must not break checkNow (still returns result).
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: '2.0.0' }) }),
      onUpdateAvailable: () => { throw new Error('callback blew up'); },
    });
    assert.deepStrictEqual(await c.checkNow(), { version: '2.0.0' }, 'callback error is swallowed');
  }

  console.log('checkNow (newer/same/older/error/timeout/badstatus/badjson): OK');

  // ── start()/stop(): timers are created, unref'd, and cleaned up ────────────
  {
    const c = new UpdateChecker({
      currentVersion: CURRENT,
      checkIntervalMs: 60000,
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ version: CURRENT }) }),
    });
    c.start();
    assert.ok(c.timer, 'interval timer set on start');
    assert.ok(c.initialTimer, 'initial delay timer set on start');
    c.stop();
    assert.strictEqual(c.timer, null, 'interval timer cleared on stop');
    assert.strictEqual(c.initialTimer, null, 'initial timer cleared on stop');
  }
  console.log('start/stop lifecycle: OK');

  console.log('\nAll update-checker tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
