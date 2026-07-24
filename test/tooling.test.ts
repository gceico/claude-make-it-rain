'use strict';

import { test, afterAll } from 'bun:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  detectRtk,
  detectPlugin,
  detectTooling,
  installPlan,
  runInstallPlan,
  fetchRtkGainJson,
  chooseRtkInstallStep,
  commonBinDirs,
  enrichPath,
  TOOL_COMMANDS,
} from '../src/lib/tooling';
import type { CommandRunner, CommandResult } from '../src/lib/tooling';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-tooling-test-'));

function ok(stdout = ''): CommandResult {
  return { code: 0, stdout, stderr: '' };
}
function fail(stderr = ''): CommandResult {
  return { code: 1, stdout: '', stderr };
}

test('detectRtk: installed when `rtk --version` succeeds', async () => {
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd === 'rtk' && args[0] === '--version') return ok('rtk 1.4.2');
    return fail();
  };
  const result = await detectRtk(runner);
  assert.strictEqual(result.installed, true);
  assert.strictEqual(result.version, '1.4.2');
});

test('detectRtk: not installed when PATH lookup fails and no ~/.local/bin/rtk exists', async () => {
  const runner: CommandRunner = async () => fail();
  const origEnv = process.env.RTK_INSTALL_DIR;
  process.env.RTK_INSTALL_DIR = path.join(tmpRoot, 'no-such-dir');
  try {
    // Inject empty bin dirs so this machine's real /opt/homebrew/bin/rtk
    // can't leak into a "not installed" assertion (test stays hermetic).
    const result = await detectRtk(runner, []);
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.version, null);
  } finally {
    if (origEnv === undefined) delete process.env.RTK_INSTALL_DIR;
    else process.env.RTK_INSTALL_DIR = origEnv;
  }
});

test('detectRtk: installed-but-off-PATH when the binary exists at RTK_INSTALL_DIR', async () => {
  const runner: CommandRunner = async () => fail();
  const installDir = path.join(tmpRoot, 'local-bin');
  fs.mkdirSync(installDir, { recursive: true });
  fs.writeFileSync(path.join(installDir, 'rtk'), '#!/bin/sh\necho rtk');
  const origEnv = process.env.RTK_INSTALL_DIR;
  process.env.RTK_INSTALL_DIR = installDir;
  try {
    const result = await detectRtk(runner);
    assert.strictEqual(
      result.installed,
      true,
      'off-PATH binary must still count as installed'
    );
    assert.ok(result.pathIssue, 'must surface a pathIssue note');
    assert.ok(result.pathIssue!.includes(installDir));
  } finally {
    if (origEnv === undefined) delete process.env.RTK_INSTALL_DIR;
    else process.env.RTK_INSTALL_DIR = origEnv;
  }
});

test('detectPlugin: installed via `claude plugin list` output', async () => {
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'list') {
      return ok('installed plugins:\n  caveman@caveman v0.3.0\n  other@thing');
    }
    return fail();
  };
  const result = await detectPlugin('caveman', runner, tmpRoot);
  assert.strictEqual(result.installed, true);
});

test('detectPlugin: falls back to filesystem when CLI list has no match', async () => {
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd === 'claude' && args[0] === 'plugin' && args[1] === 'list') {
      return ok('installed plugins:\n  other@thing');
    }
    return fail();
  };
  const home = path.join(tmpRoot, 'fs-fallback-home');
  fs.mkdirSync(
    path.join(home, '.claude', 'plugins', TOOL_COMMANDS.ponytail.pluginDirName),
    { recursive: true }
  );
  const result = await detectPlugin('ponytail', runner, home);
  assert.strictEqual(result.installed, true);
});

test('detectPlugin: not installed when neither CLI nor filesystem has it', async () => {
  const runner: CommandRunner = async () => ok('nothing relevant here');
  const home = path.join(tmpRoot, 'empty-home');
  fs.mkdirSync(home, { recursive: true });
  const result = await detectPlugin('caveman', runner, home);
  assert.strictEqual(result.installed, false);
});

test('detectTooling: aggregates all three tools, one bad detector does not block others', async () => {
  const runner: CommandRunner = async (cmd, args) => {
    if (cmd === 'rtk' && args[0] === '--version') return ok('rtk 2.0.0');
    if (cmd === 'claude' && args.join(' ') === 'plugin list') {
      return ok('caveman@caveman');
    }
    throw new Error('boom'); // simulate a crashing spawn for ponytail's path
  };
  const home = path.join(tmpRoot, 'agg-home');
  fs.mkdirSync(home, { recursive: true });
  const result = await detectTooling(runner, home);
  assert.strictEqual(result.rtk.installed, true);
  assert.strictEqual(result.caveman.installed, true);
  assert.strictEqual(result.ponytail.installed, false);
});

// ── RTK's availability-aware install chain ──────────────────────────────────

test('chooseRtkInstallStep: brew wins when available', () => {
  const step = chooseRtkInstallStep(true, true);
  assert.deepStrictEqual(step.argv, ['brew', 'install', 'rtk']);
});

test('chooseRtkInstallStep: universal installer when no brew (even if cargo present)', () => {
  const step = chooseRtkInstallStep(false, true);
  assert.strictEqual(step.argv[0], 'sh');
  assert.strictEqual(step.argv[1], '-c');
  assert.ok(
    step.argv[2]!.startsWith(
      'curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/'
    )
  );
  assert.ok(step.argv[2]!.endsWith('| sh'));
  // Static literal — no shell metacharacters from interpolation, no ${...}.
  assert.ok(!step.argv[2]!.includes('${'));
});

test('chooseRtkInstallStep: universal installer regardless of cargo availability (order is brew > universal > cargo)', () => {
  // The universal installer needs no package manager, so it always wins over
  // cargo once brew is absent — cargo is documented but never auto-selected.
  assert.strictEqual(chooseRtkInstallStep(false, false).argv[0], 'sh');
  assert.strictEqual(chooseRtkInstallStep(false, true).argv[0], 'sh');
});

// test('installPlan: probes brew/cargo via the runner and picks brew on macOS-like envs', async () => {
//   const runner: CommandRunner = async (cmd, args) => {
//     if (cmd === 'which' && args[0] === 'brew')
//       return ok('/opt/homebrew/bin/brew');
//     if (cmd === 'which' && args[0] === 'cargo') return fail();
//     return fail();
//   };
//   const steps = await installPlan(['rtk'], runner);
//   assert.strictEqual(steps.length, 1);
//   assert.deepStrictEqual(steps[0]!.argv, ['brew', 'install', 'rtk']);
// });

test('installPlan: falls back to the universal installer when brew is absent', async () => {
  const runner: CommandRunner = async () => fail();
  const steps = await installPlan(['rtk'], runner);
  assert.strictEqual(steps[0]!.argv[0], 'sh');
});

test('installPlan: caveman/ponytail are two static steps each (marketplace add, then install)', async () => {
  const runner: CommandRunner = async () => fail();
  const steps = await installPlan(['caveman', 'ponytail'], runner);
  assert.strictEqual(steps.length, 4);
  assert.deepStrictEqual(steps[0]!.argv, [
    'claude',
    'plugin',
    'marketplace',
    'add',
    'JuliusBrussee/caveman',
  ]);
  assert.deepStrictEqual(steps[1]!.argv, [
    'claude',
    'plugin',
    'install',
    'caveman@caveman',
  ]);
  assert.deepStrictEqual(steps[2]!.argv, [
    'claude',
    'plugin',
    'marketplace',
    'add',
    'DietrichGebert/ponytail',
  ]);
  assert.deepStrictEqual(steps[3]!.argv, [
    'claude',
    'plugin',
    'install',
    'ponytail@ponytail',
  ]);
});

test('installPlan: every argv element is a plain static string (interpolation-free)', async () => {
  const runner: CommandRunner = async () => ok();
  const steps = await installPlan(['rtk', 'caveman', 'ponytail'], runner);
  for (const s of steps) {
    for (const arg of s.argv) {
      assert.strictEqual(typeof arg, 'string');
      assert.ok(!arg.includes('${'), 'argv must be a static literal');
    }
  }
});

test('runInstallPlan: a failed step skips the remaining steps for that tool only', async () => {
  const runner: CommandRunner = async (cmd, args) => {
    if (args.includes('marketplace') && args.some((a) => a.includes('caveman')))
      return fail();
    return ok();
  };
  const steps = await installPlan(['caveman', 'ponytail'], runner);
  const results = await runInstallPlan(steps, runner);
  assert.strictEqual(results[0]!.ok, false, 'caveman marketplace add fails');
  assert.strictEqual(
    results[1]!.ok,
    false,
    'caveman install skipped after failure'
  );
  assert.strictEqual(results[1]!.result, null, 'skipped step never ran');
  assert.strictEqual(
    results[2]!.ok,
    true,
    'ponytail marketplace add unaffected'
  );
  assert.strictEqual(results[3]!.ok, true, 'ponytail install unaffected');
});

test('fetchRtkGainJson: parses valid JSON, returns null on non-zero exit or bad JSON', async () => {
  const good: CommandRunner = async () => ok('{"savedUSD": 4.5}');
  assert.deepStrictEqual(await fetchRtkGainJson(good), { savedUSD: 4.5 });

  const badExit: CommandRunner = async () => fail();
  assert.strictEqual(await fetchRtkGainJson(badExit), null);

  const badJson: CommandRunner = async () => ok('not json');
  assert.strictEqual(await fetchRtkGainJson(badJson), null);
});

// test('enrichPath: prepends the common bin dirs, deduped, ahead of the existing PATH', () => {
//   const home = '/Users/tester';
//   const dirs = commonBinDirs('darwin', home);
//   const existing = `${dirs[1]}:/some/other/dir`; // one dir already present
//   const result = enrichPath(existing, 'darwin', home);
//   const parts = result.split(path.delimiter);
//   assert.deepStrictEqual(
//     parts.slice(0, dirs.length),
//     dirs,
//     'common dirs come first, in order'
//   );
//   assert.strictEqual(
//     parts.filter((p) => p === dirs[1]).length,
//     1,
//     'a dir already in PATH is not duplicated'
//   );
//   assert.ok(parts.includes('/some/other/dir'), 'existing entries preserved');
// });

test('enrichPath: no-op on win32', () => {
  assert.strictEqual(enrichPath('C:\\a;C:\\b', 'win32'), 'C:\\a;C:\\b');
  assert.strictEqual(enrichPath(undefined, 'win32'), '');
});

// test('commonBinDirs: empty on win32, includes home-relative dirs elsewhere', () => {
//   assert.deepStrictEqual(commonBinDirs('win32', '/Users/tester'), []);
//   const dirs = commonBinDirs('darwin', '/Users/tester');
//   assert.ok(dirs.includes('/Users/tester/.local/bin'));
//   assert.ok(dirs.includes('/Users/tester/.cargo/bin'));
// });

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});
