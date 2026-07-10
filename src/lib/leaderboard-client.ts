'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { URL } from 'url';

/**
 * Cloud-leaderboard client (pure Node, no Electron) for Make It Rain.
 *
 * Privacy by design (GDPR): the ONLY thing that ever leaves the machine is an
 * anonymized, user-changeable gamer tag plus today's estimated USD total. No
 * account, no IP-derived identity, no file paths, no model names, no personal
 * data. Telemetry is on by default but disclosed in the README, shown in the
 * tray menu, and switchable off with a single click (persisted to config).
 *
 * All network activity fails silently: a missing/placeholder/unreachable server
 * never crashes the app and never triggers a retry storm (one attempt per tick,
 * short timeout, no backoff loops).
 */

const DEFAULT_API_BASE_URL = 'https://aiburn.dev'; // reference server (override via config.apiBaseUrl)
// Retired defaults that older builds persisted into config.json on first run. A
// saved apiBaseUrl matching one of these is treated as "unset" so the current
// default applies; genuine custom URLs are always preserved. The Railway URL was
// the reference host before the aiburn.dev domain was set up.
const LEGACY_PLACEHOLDER_URLS = [
  'https://make-it-rain.example.com',
  'https://claude-make-it-rain-production.up.railway.app',
];
const DEFAULT_REPORT_INTERVAL_MS = 60 * 60 * 1000; // hourly
const REQUEST_TIMEOUT_MS = 8000;
const CONFIG_FILENAME = 'config.json';
const TAG_MAX_LENGTH = 32;

const ADJECTIVES = [
  'Turbo',
  'Sneaky',
  'Cosmic',
  'Feral',
  'Groovy',
  'Lucky',
  'Salty',
  'Zesty',
  'Bold',
  'Wobbly',
  'Spicy',
  'Mellow',
  'Rowdy',
  'Nifty',
  'Glitchy',
  'Sleepy',
  'Frosty',
  'Cheeky',
  'Rogue',
  'Snazzy',
  'Vivid',
  'Quantum',
  'Nimble',
  'Jolly',
];
const NOUNS = [
  'Llama',
  'Otter',
  'Falcon',
  'Walrus',
  'Gecko',
  'Panda',
  'Badger',
  'Narwhal',
  'Raccoon',
  'Yak',
  'Moose',
  'Ferret',
  'Toucan',
  'Hedgehog',
  'Wombat',
  'Lemur',
  'Mongoose',
  'Platypus',
  'Cobra',
  'Manatee',
  'Puffin',
  'Marmot',
  'Ocelot',
  'Kraken',
];

/** Normalized leaderboard configuration. */
export interface LeaderboardConfig {
  gamerTag: string;
  telemetryEnabled: boolean;
  apiBaseUrl: string;
  reportIntervalMs: number;
}

/** Minimal shape of a fetch Response we rely on (injectable for tests). */
interface FetchResponseLike {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
}
type FetchLike = (url: string, init?: unknown) => Promise<FetchResponseLike>;

/** Cross-platform default directory for the config file (headless-safe). */
export function defaultConfigDir(): string {
  const appName = 'make-it-rain';
  if (process.platform === 'win32') {
    const base =
      process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  const base =
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, appName);
}

/** Anonymized, human-readable gamer tag, e.g. "TurboLlama7392". */
export function generateTag(): string {
  const adj = ADJECTIVES[crypto.randomInt(ADJECTIVES.length)];
  const noun = NOUNS[crypto.randomInt(NOUNS.length)];
  const num = crypto.randomInt(1000, 10000); // 4 digits
  return adj + noun + num;
}

/**
 * True only for absolute http(s) URLs. Any other scheme (javascript:, file:,
 * data:, vbscript:, ftp:, …) or unparseable value is rejected. This is a
 * security boundary: apiBaseUrl is fed to fetch() AND to shell.openExternal()
 * (see main.ts openLeaderboardPage), so a malicious/corrupt config could
 * otherwise open an arbitrary URI with the OS default handler.
 */
export function isSafeHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Trim/sanitize a user-supplied tag to a safe, anonymous handle. */
export function sanitizeTag(tag: unknown): string {
  if (typeof tag !== 'string') return '';
  // Anonymous handle only: keep letters, digits, _ and -; drop everything else
  // (whitespace, control chars, punctuation, emoji), then bound the length.
  return tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, TAG_MAX_LENGTH);
}

/**
 * Coerce an arbitrary parsed object into a valid config, filling defaults and
 * generating a tag when missing. Returns a brand-new object (never mutates).
 */
export function normalizeConfig(raw: unknown): LeaderboardConfig {
  const cfg = (raw && typeof raw === 'object' ? raw : {}) as Record<
    string,
    unknown
  >;

  let tag = sanitizeTag(cfg.gamerTag);
  if (!tag) tag = generateTag();

  const telemetryEnabled =
    typeof cfg.telemetryEnabled === 'boolean' ? cfg.telemetryEnabled : true;

  let apiBaseUrl =
    typeof cfg.apiBaseUrl === 'string' && cfg.apiBaseUrl.trim()
      ? cfg.apiBaseUrl.trim()
      : DEFAULT_API_BASE_URL;
  // Scheme allow-list: only absolute http(s) URLs are trusted. Anything else
  // (javascript:, file:, data:, a bare host, garbage) falls back to the
  // default so a tampered config can't redirect reports or hijack the URI
  // handed to shell.openExternal.
  if (!isSafeHttpUrl(apiBaseUrl)) {
    apiBaseUrl = DEFAULT_API_BASE_URL;
  }
  // Migration: older builds saved the placeholder default to disk; treat it as
  // unset so those installs pick up the real server (custom URLs still win).
  if (LEGACY_PLACEHOLDER_URLS.includes(apiBaseUrl.replace(/\/+$/, ''))) {
    apiBaseUrl = DEFAULT_API_BASE_URL;
  }

  const reportIntervalMs =
    typeof cfg.reportIntervalMs === 'number' &&
    isFinite(cfg.reportIntervalMs) &&
    cfg.reportIntervalMs >= 60000
      ? Math.trunc(cfg.reportIntervalMs)
      : DEFAULT_REPORT_INTERVAL_MS;

  return { gamerTag: tag, telemetryEnabled, apiBaseUrl, reportIntervalMs };
}

/** Read + normalize config from disk. Never throws; returns defaults on error. */
export function loadConfig(configDir: string): LeaderboardConfig {
  const file = path.join(configDir, CONFIG_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null; // missing or corrupt — fall back to defaults
  }
  return normalizeConfig(raw);
}

/**
 * Persist config atomically-ish. Never throws; returns true on success.
 *
 * config.json is SHARED with other features (lib/config.ts persists e.g. the
 * `muted` preference to the same file), so our fields are merged over the raw
 * on-disk contents: a leaderboard save must never drop keys it doesn't own.
 */
export function saveConfig(
  configDir: string,
  config: LeaderboardConfig
): boolean {
  try {
    fs.mkdirSync(configDir, { recursive: true });
    const file = path.join(configDir, CONFIG_FILENAME);
    let raw: unknown = null;
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      raw = null; // missing or corrupt — nothing to preserve
    }
    const base =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const tmp = file + '.tmp';
    fs.writeFileSync(
      tmp,
      JSON.stringify({ ...base, ...config }, null, 2) + '\n'
    );
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensures a config exists on disk (creating one with a fresh tag on first run)
 * and returns the normalized config.
 */
export function ensureConfig(configDir: string): LeaderboardConfig {
  const file = path.join(configDir, CONFIG_FILENAME);
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    raw = null;
  }
  const config = normalizeConfig(raw);
  // Persist when the file is new — or when it exists but has no valid tag
  // (e.g. the shared config.json was first created by another feature, such
  // as the mute preference) — so the install's tag stays stable across runs.
  const hadTag = !!(
    raw &&
    typeof raw === 'object' &&
    sanitizeTag((raw as Record<string, unknown>).gamerTag)
  );
  if (!hadTag) saveConfig(configDir, config);
  return config;
}

export interface LeaderboardClientOptions {
  configDir?: string;
  getTotal?: () => number;
  fetchImpl?: FetchLike | null;
  onConfigChange?: (config: LeaderboardConfig) => void;
}

export class LeaderboardClient {
  configDir: string;
  getTotal: () => number;
  fetchImpl: FetchLike | null;
  onConfigChange: ((config: LeaderboardConfig) => void) | null;
  timer: NodeJS.Timeout | null;
  _reporting: boolean;
  config: LeaderboardConfig;

  constructor({
    configDir,
    getTotal,
    fetchImpl,
    onConfigChange,
  }: LeaderboardClientOptions = {}) {
    this.configDir = configDir || defaultConfigDir();
    this.getTotal = typeof getTotal === 'function' ? getTotal : () => 0;
    this.fetchImpl =
      fetchImpl ||
      (typeof fetch === 'function'
        ? (fetch.bind(null) as unknown as FetchLike)
        : null);
    this.onConfigChange =
      typeof onConfigChange === 'function' ? onConfigChange : null;
    this.timer = null;
    this._reporting = false;
    this.config = ensureConfig(this.configDir);
  }

  get gamerTag(): string {
    return this.config.gamerTag;
  }
  get telemetryEnabled(): boolean {
    return this.config.telemetryEnabled;
  }

  _persist(): void {
    saveConfig(this.configDir, this.config);
    if (this.onConfigChange) this.onConfigChange(this.config);
  }

  setTelemetryEnabled(enabled: boolean): void {
    this.config = { ...this.config, telemetryEnabled: !!enabled };
    this._persist();
  }

  /** Make a new anonymous tag (user-facing "reroll"). Returns the new tag. */
  regenerateTag(): string {
    this.config = { ...this.config, gamerTag: generateTag() };
    this._persist();
    return this.config.gamerTag;
  }

  /** Set a custom tag the user typed. Returns the sanitized value used. */
  setTag(tag: unknown): string {
    const clean = sanitizeTag(tag) || generateTag();
    this.config = { ...this.config, gamerTag: clean };
    this._persist();
    return this.config.gamerTag;
  }

  start(): void {
    if (this.timer) return;
    // Report shortly after launch, then on the configured interval.
    this.reportNow();
    this.timer = setInterval(
      () => this.reportNow(),
      this.config.reportIntervalMs
    );
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Send one report. Resolves to true if the server accepted it, false in every
   * other case (disabled, no fetch, network error, bad status). Never throws,
   * never retries — the next scheduled tick is the only "retry".
   */
  async reportNow(): Promise<boolean> {
    if (!this.config.telemetryEnabled) return false;
    if (!this.fetchImpl) return false;
    if (this._reporting) return false; // avoid overlapping in-flight requests
    this._reporting = true;

    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;

    try {
      let total = this.getTotal();
      if (typeof total !== 'number' || !isFinite(total) || total < 0) total = 0;
      total = Math.round(total * 100) / 100;

      const url = this.config.apiBaseUrl.replace(/\/+$/, '') + '/api/report';
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: this.config.gamerTag, total }),
        signal: controller ? controller.signal : undefined,
      });
      return !!(res && res.ok);
    } catch {
      return false; // unreachable / DNS / abort / anything — stay silent
    } finally {
      if (timeout) clearTimeout(timeout);
      this._reporting = false;
    }
  }
}

export { DEFAULT_API_BASE_URL, DEFAULT_REPORT_INTERVAL_MS };
