'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  LeaderboardClient,
  generateTag,
  sanitizeTag,
  isSafeHttpUrl,
  normalizeConfig,
  loadConfig,
  saveConfig,
  ensureConfig,
  DEFAULT_API_BASE_URL,
  DEFAULT_REPORT_INTERVAL_MS,
} = require('../lib/leaderboard-client');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mir-lb-test-'));
const configFile = (dir) => path.join(dir, 'config.json');

// ── Tag generation ───────────────────────────────────────────────────────────
{
  const seen = new Set();
  for (let i = 0; i < 500; i++) {
    const tag = generateTag();
    assert.ok(/^[A-Za-z]+[0-9]{4}$/.test(tag), `unexpected tag shape: ${tag}`);
    assert.ok(tag.length <= 32, 'tag within bound');
    seen.add(tag);
  }
  // Anonymized + random: 500 draws should yield lots of distinct values.
  assert.ok(seen.size > 100, `tags should vary widely, got ${seen.size} distinct`);
  console.log('tag generation (shape + variety): OK');
}

// ── sanitizeTag ──────────────────────────────────────────────────────────────
{
  assert.strictEqual(sanitizeTag('Turbo Llama 42'), 'TurboLlama42', 'strips spaces');
  assert.strictEqual(sanitizeTag('  hi\tthere\n'), 'hithere', 'strips whitespace/tabs');
  assert.strictEqual(sanitizeTag('a@b#c$d%'), 'abcd', 'strips punctuation');
  assert.strictEqual(sanitizeTag('keep_me-123'), 'keep_me-123', 'keeps word/_/-');
  assert.strictEqual(sanitizeTag(null), '', 'non-string -> empty');
  assert.strictEqual(sanitizeTag(12345), '', 'number -> empty');
  assert.strictEqual(sanitizeTag('x'.repeat(100)).length, 32, 'bounded to 32');
  // No PII / free-form leakage: emoji and unicode letters outside ASCII dropped.
  assert.strictEqual(sanitizeTag('José💰Doe'), 'JosDoe', 'drops emoji + accents');
  console.log('sanitizeTag: OK');
}

// ── normalizeConfig defaults + coercion ──────────────────────────────────────
{
  const fresh = normalizeConfig(null);
  assert.ok(fresh.gamerTag && typeof fresh.gamerTag === 'string', 'generates a tag');
  assert.strictEqual(fresh.telemetryEnabled, true, 'telemetry defaults ON');
  assert.strictEqual(fresh.apiBaseUrl, DEFAULT_API_BASE_URL, 'default api base');
  assert.strictEqual(fresh.reportIntervalMs, DEFAULT_REPORT_INTERVAL_MS, 'default interval');

  const custom = normalizeConfig({
    gamerTag: 'My Cool Tag!!',
    telemetryEnabled: false,
    apiBaseUrl: '  https://example.org/  ',
    reportIntervalMs: 120000,
  });
  assert.strictEqual(custom.gamerTag, 'MyCoolTag', 'sanitizes provided tag');
  assert.strictEqual(custom.telemetryEnabled, false, 'respects disabled flag');
  assert.strictEqual(custom.apiBaseUrl, 'https://example.org/', 'trims api base');
  assert.strictEqual(custom.reportIntervalMs, 120000, 'respects custom interval');

  // Too-small interval is rejected in favor of the default (no hammering).
  assert.strictEqual(normalizeConfig({ reportIntervalMs: 5 }).reportIntervalMs, DEFAULT_REPORT_INTERVAL_MS);
  // Empty tag string -> a fresh tag is generated.
  assert.ok(normalizeConfig({ gamerTag: '   ' }).gamerTag.length > 0, 'empty tag -> generated');
  console.log('normalizeConfig: OK');
}

// ── Legacy placeholder apiBaseUrl migrates to the current default ────────────
// Older builds persisted the placeholder default into config.json on first run;
// those saved values must not shadow the real server URL. Custom URLs still win.
{
  assert.strictEqual(
    normalizeConfig({ apiBaseUrl: 'https://make-it-rain.example.com' }).apiBaseUrl,
    DEFAULT_API_BASE_URL,
    'legacy placeholder migrates to the current default'
  );
  assert.strictEqual(
    normalizeConfig({ apiBaseUrl: 'https://make-it-rain.example.com/' }).apiBaseUrl,
    DEFAULT_API_BASE_URL,
    'legacy placeholder with trailing slash also migrates'
  );
  assert.strictEqual(
    normalizeConfig({ apiBaseUrl: 'https://claude-make-it-rain-production.up.railway.app' }).apiBaseUrl,
    DEFAULT_API_BASE_URL,
    'the retired Railway reference URL migrates to the current default'
  );
  assert.strictEqual(
    normalizeConfig({ apiBaseUrl: 'https://my-own-leaderboard.example.org' }).apiBaseUrl,
    'https://my-own-leaderboard.example.org',
    'genuine custom URL is preserved'
  );
  console.log('legacy apiBaseUrl migration: OK');
}

// ── Security: apiBaseUrl scheme allow-list + tag re-sanitization on LOAD ─────
// A malicious/corrupt config.json is a real attack vector: apiBaseUrl is fed to
// fetch() AND shell.openExternal(), and a gamerTag read from disk must never
// bypass sanitize. Both are neutralized in normalizeConfig, i.e. on every LOAD.
{
  // Non-http(s) schemes are rejected outright.
  for (const bad of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'ftp://host/x',
    'not a url',
    '//evil.com',
    '',
  ]) {
    assert.strictEqual(isSafeHttpUrl(bad), false, `isSafeHttpUrl rejects ${JSON.stringify(bad)}`);
    assert.strictEqual(
      normalizeConfig({ apiBaseUrl: bad }).apiBaseUrl,
      DEFAULT_API_BASE_URL,
      `malicious apiBaseUrl ${JSON.stringify(bad)} -> default`
    );
  }
  // Genuine http(s) URLs are allowed through.
  assert.strictEqual(isSafeHttpUrl('http://ok.example'), true);
  assert.strictEqual(isSafeHttpUrl('https://ok.example/x'), true);
  assert.strictEqual(
    normalizeConfig({ apiBaseUrl: 'https://my-server.example.org' }).apiBaseUrl,
    'https://my-server.example.org',
    'safe https URL preserved'
  );

  // A gamerTag full of HTML on disk is stripped to a safe handle on load, so it
  // can never round-trip to a DOM/tray sink as markup.
  const evil = normalizeConfig({ gamerTag: '<img src=x onerror=alert(1)>' });
  assert.strictEqual(evil.gamerTag, 'imgsrcxonerroralert1', 'HTML gamerTag sanitized on load');
  assert.ok(!/[<>"'&]/.test(evil.gamerTag), 'no HTML-significant chars survive load');

  // End-to-end via loadConfig() reading a hostile file straight off disk.
  const dir = path.join(tmpRoot, 'evil-config');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    configFile(dir),
    JSON.stringify({ apiBaseUrl: 'file:///etc/passwd', gamerTag: '"><script>x</script>' })
  );
  const loaded = loadConfig(dir);
  assert.strictEqual(loaded.apiBaseUrl, DEFAULT_API_BASE_URL, 'file: URL neutralized on load');
  assert.strictEqual(loaded.gamerTag, 'scriptxscript', 'HTML tag neutralized on load');
  console.log('security: apiBaseUrl scheme allow-list + tag re-sanitization on load: OK');
}

// ── First-run creation + persistence round-trip ──────────────────────────────
{
  const dir = path.join(tmpRoot, 'firstrun');
  assert.ok(!fs.existsSync(configFile(dir)), 'no config before ensure');
  const cfg = ensureConfig(dir);
  assert.ok(fs.existsSync(configFile(dir)), 'config written on first run');

  // Second run must reuse the SAME tag (stable install identity).
  const cfg2 = ensureConfig(dir);
  assert.strictEqual(cfg2.gamerTag, cfg.gamerTag, 'tag is stable across runs');

  // Corrupt file -> defaults, no throw.
  fs.writeFileSync(configFile(dir), '{ this is not json');
  const recovered = loadConfig(dir);
  assert.ok(recovered.gamerTag.length > 0, 'recovers from corrupt config');

  // saveConfig round-trips.
  const saved = { gamerTag: 'RoundTrip1', telemetryEnabled: false, apiBaseUrl: 'https://x.io', reportIntervalMs: 3600000 };
  assert.strictEqual(saveConfig(dir, saved), true);
  assert.deepStrictEqual(loadConfig(dir), saved, 'load matches save');
  console.log('config persistence (first-run, stability, recovery, round-trip): OK');
}

// ── Client: toggle + tag management persist to disk ──────────────────────────
{
  const dir = path.join(tmpRoot, 'client');
  const client = new LeaderboardClient({ configDir: dir, getTotal: () => 42.5, fetchImpl: null });

  assert.strictEqual(client.telemetryEnabled, true, 'default enabled');
  client.setTelemetryEnabled(false);
  assert.strictEqual(client.telemetryEnabled, false);
  assert.strictEqual(loadConfig(dir).telemetryEnabled, false, 'toggle persisted');

  const newTag = client.regenerateTag();
  assert.ok(typeof newTag === 'string' && newTag.length > 0, 'reroll returns a tag');
  assert.strictEqual(loadConfig(dir).gamerTag, newTag, 'reroll persisted');

  const setTo = client.setTag('Custom Name 99');
  assert.strictEqual(setTo, 'CustomName99', 'setTag sanitizes');
  assert.strictEqual(loadConfig(dir).gamerTag, 'CustomName99', 'setTag persisted');
  console.log('client toggle + tag management: OK');
}

// ── Unified config store: leaderboard + delight share one config.json ────────
// lib/config.js (mute preference) and this client persist to the SAME file.
// Neither writer may drop the other's keys: a leaderboard save must preserve
// `muted`, and a mute toggle must preserve the gamer tag — even when the tag
// changed after the Config instance was created (no stale clobbering).
{
  const dir = path.join(tmpRoot, 'unified');
  const { Config } = require('../lib/config');

  // Delight writes first: muted=true lands in config.json.
  const appCfg = new Config(configFile(dir));
  appCfg.set('muted', true);

  // Leaderboard client boots against the same file and rerolls the tag.
  const client = new LeaderboardClient({ configDir: dir, getTotal: () => 0, fetchImpl: null });
  const tag = client.setTag('UnifiedYak1234');
  assert.strictEqual(tag, 'UnifiedYak1234');

  let onDisk = JSON.parse(fs.readFileSync(configFile(dir), 'utf8'));
  assert.strictEqual(onDisk.muted, true, 'leaderboard save must preserve muted');
  assert.strictEqual(onDisk.gamerTag, 'UnifiedYak1234', 'leaderboard save wrote the tag');

  // Mute toggle AFTER the tag change: appCfg loaded before the tag existed,
  // so this proves set() re-reads instead of writing back a stale snapshot.
  appCfg.set('muted', false);
  onDisk = JSON.parse(fs.readFileSync(configFile(dir), 'utf8'));
  assert.strictEqual(onDisk.gamerTag, 'UnifiedYak1234', 'mute toggle must preserve gamer tag');
  assert.strictEqual(onDisk.muted, false, 'mute toggle persisted');
  assert.strictEqual(onDisk.telemetryEnabled, true, 'telemetry key survives too');

  // Both readers see the merged truth after a round-trip.
  assert.strictEqual(loadConfig(dir).gamerTag, 'UnifiedYak1234', 'loadConfig sees tag');
  assert.strictEqual(new Config(configFile(dir)).get('muted'), false, 'Config sees mute');
  console.log('unified config store (cross-feature keys survive round-trips): OK');
}

// ── Client: reporting behavior (fail-silent, disabled short-circuit) ─────────
(async () => {
  const dir = path.join(tmpRoot, 'report');

  // Enabled: sends one well-formed POST.
  let captured = null;
  const okFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200 };
  };
  const c1 = new LeaderboardClient({ configDir: dir, getTotal: () => 12.345, fetchImpl: okFetch });
  const sent = await c1.reportNow();
  assert.strictEqual(sent, true, 'report succeeds when server accepts');
  assert.ok(captured.url.endsWith('/api/report'), 'hits /api/report');
  const body = JSON.parse(captured.opts.body);
  assert.deepStrictEqual(Object.keys(body).sort(), ['tag', 'total'], 'body ONLY has tag+total (no PII)');
  assert.strictEqual(body.total, 12.35, 'total rounded to cents');
  assert.strictEqual(body.tag, c1.gamerTag);

  // Disabled: short-circuits, never calls fetch.
  let called = false;
  const c2 = new LeaderboardClient({
    configDir: path.join(tmpRoot, 'report2'),
    getTotal: () => 5,
    fetchImpl: async () => { called = true; return { ok: true }; },
  });
  c2.setTelemetryEnabled(false);
  assert.strictEqual(await c2.reportNow(), false, 'disabled -> no report');
  assert.strictEqual(called, false, 'disabled -> fetch never called');

  // Unreachable server: fails silently (returns false, does not throw).
  const c3 = new LeaderboardClient({
    configDir: path.join(tmpRoot, 'report3'),
    getTotal: () => 5,
    fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
  });
  assert.strictEqual(await c3.reportNow(), false, 'network error -> false, no throw');

  // Non-2xx: treated as failure, no throw.
  const c4 = new LeaderboardClient({
    configDir: path.join(tmpRoot, 'report4'),
    getTotal: () => 5,
    fetchImpl: async () => ({ ok: false, status: 500 }),
  });
  assert.strictEqual(await c4.reportNow(), false, 'bad status -> false');

  console.log('client reporting (payload minimalism, disable, fail-silent): OK');

  // ── Auto-registration: first report claims a secret, then sends it ───────────
  {
    const dir = path.join(tmpRoot, 'autoreg');
    const calls = [];
    const fetchImpl = async (url, opts) => {
      calls.push({ url, body: JSON.parse(opts.body) });
      if (url.endsWith('/api/register')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, tag: JSON.parse(opts.body).tag, secret: 'SEKRET123' }) };
      }
      return { ok: true, status: 200 }; // /api/report
    };
    const c = new LeaderboardClient({ configDir: dir, getTotal: () => 3.21, fetchImpl });
    const sent = await c.reportNow();
    assert.strictEqual(sent, true, 'report succeeds after auto-register');
    assert.strictEqual(calls.length, 2, 'exactly two calls: register then report');
    assert.ok(calls[0].url.endsWith('/api/register'), 'first call is /api/register');
    assert.deepStrictEqual(Object.keys(calls[0].body).sort(), ['tag'], 'register body is just { tag }');
    assert.ok(calls[1].url.endsWith('/api/report'), 'second call is /api/report');
    assert.strictEqual(calls[1].body.secret, 'SEKRET123', 'report carries the freshly issued secret');
    assert.strictEqual(calls[1].body.total, 3.21, 'report carries the total');
    // Secret persisted to disk.
    assert.strictEqual(loadConfig(dir).tagSecret, 'SEKRET123', 'secret persisted to config.json');

    // A second report reuses the stored secret WITHOUT re-registering.
    calls.length = 0;
    await c.reportNow();
    assert.strictEqual(calls.length, 1, 'second report does not re-register');
    assert.ok(calls[0].url.endsWith('/api/report'), 'second report hits /api/report directly');
    assert.strictEqual(calls[0].body.secret, 'SEKRET123', 'reuses the stored secret');
    console.log('client auto-register (register once, then sends secret with reports): OK');
  }

  // ── 409 on register: reroll the tag and retry once ───────────────────────────
  {
    const dir = path.join(tmpRoot, 'autoreg-taken');
    const calls = [];
    let firstRegister = true;
    const fetchImpl = async (url, opts) => {
      const body = JSON.parse(opts.body);
      calls.push({ url, body });
      if (url.endsWith('/api/register')) {
        if (firstRegister) { firstRegister = false; return { ok: false, status: 409, json: async () => ({ ok: false, error: 'tag_taken' }) }; }
        return { ok: true, status: 200, json: async () => ({ ok: true, tag: body.tag, secret: 'SECOND' }) };
      }
      return { ok: true, status: 200 };
    };
    const c = new LeaderboardClient({ configDir: dir, getTotal: () => 1, fetchImpl });
    const firstTag = c.gamerTag;
    await c.reportNow();
    const registers = calls.filter((x) => x.url.endsWith('/api/register'));
    assert.strictEqual(registers.length, 2, 'registered twice (initial 409 then retry)');
    assert.notStrictEqual(c.gamerTag, firstTag, 'tag was rerolled after 409');
    assert.strictEqual(loadConfig(dir).tagSecret, 'SECOND', 'secret from the retry persisted');
    console.log('client auto-register 409 -> reroll + retry once: OK');
  }

  // ── Tag change clears the stored secret (forces re-registration) ─────────────
  {
    const dir = path.join(tmpRoot, 'secret-clear');
    const client = new LeaderboardClient({ configDir: dir, getTotal: () => 0, fetchImpl: null });
    // Seed a secret directly.
    client.config = { ...client.config, tagSecret: 'OLD' };
    client._persist();
    assert.strictEqual(loadConfig(dir).tagSecret, 'OLD', 'seeded secret on disk');

    client.regenerateTag();
    assert.strictEqual(client.config.tagSecret, undefined, 'regenerateTag clears in-memory secret');
    assert.strictEqual(loadConfig(dir).tagSecret, undefined, 'regenerateTag clears persisted secret');

    // Re-seed then change via setTag.
    client.config = { ...client.config, tagSecret: 'OLD2' };
    client._persist();
    client.setTag('BrandNewTag');
    assert.strictEqual(client.config.tagSecret, undefined, 'setTag clears in-memory secret');
    assert.strictEqual(loadConfig(dir).tagSecret, undefined, 'setTag clears persisted secret');
    console.log('client tag change clears tagSecret (regenerateTag + setTag): OK');
  }

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('\nAll leaderboard-client tests passed.');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
