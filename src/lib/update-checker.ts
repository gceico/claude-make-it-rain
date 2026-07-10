'use strict';

/**
 * Update checker (pure Node, no Electron, zero npm deps) for Make It Rain.
 *
 * Asks the public npm registry for the latest published version of this package
 * and reports back when the running install is behind. Mirrors the house style
 * of lib/leaderboard-client.ts: one attempt per tick, short AbortController
 * timeout, injectable fetch for tests, and NEVER throws — a missing network,
 * a slow registry, or malformed JSON must never crash or hang the app.
 */

const REGISTRY_URL =
  'https://registry.npmjs.org/@gceico/claude-make-it-rain/latest';
const REQUEST_TIMEOUT_MS = 8000;
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // daily
// Small delay after launch before the first check, so startup isn't blocked
// and we don't hammer the registry the instant the app opens.
const INITIAL_CHECK_DELAY_MS = 10 * 1000;

/** Minimal shape of a fetch Response we rely on (injectable for tests). */
interface CheckResponse {
  ok: boolean;
  status?: number;
  json: () => Promise<unknown>;
}
type CheckFetch = (url: string, init?: unknown) => Promise<CheckResponse>;

/**
 * Parse a "major.minor.patch" string into a numeric triple, ignoring any
 * pre-release/build suffix (e.g. "1.2.3-beta.1" -> [1,2,3]). Returns null when
 * the leading three components aren't all plain integers — callers treat an
 * unparseable version as "not newer" so garbage can never trigger an update.
 */
export function parseVersion(v: unknown): number[] | null {
  if (typeof v !== 'string') return null;
  const core = v.trim().replace(/^v/, '').split(/[-+]/)[0];
  const parts = core.split('.');
  if (parts.length < 3) return null;
  const nums: number[] = [];
  for (let i = 0; i < 3; i++) {
    const p = parts[i];
    if (!/^\d+$/.test(p)) return null;
    nums.push(parseInt(p, 10));
  }
  return nums;
}

/**
 * Compare two versions numerically. Returns 1 if a > b, -1 if a < b, 0 if
 * equal. Anything unparseable sorts as "not greater": an unparseable `a`
 * against a valid `b` yields -1, and an unparseable `b` yields 1 only when `a`
 * parses. Two unparseable inputs compare equal (0). This guarantees
 * `compareVersions(latest, current) > 0` is only ever true for a genuinely
 * newer, well-formed latest version.
 */
export function compareVersions(a: unknown, b: unknown): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa && !pb) return 0;
  if (!pa) return -1;
  if (!pb) return 1;
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * True when `latest` is a well-formed version strictly newer than `current`.
 * compareVersions already guarantees an unparseable `latest` sorts as
 * not-greater, so no separate parse guard is needed here.
 */
export function isNewerVersion(latest: unknown, current: unknown): boolean {
  return compareVersions(latest, current) > 0;
}

/**
 * Decide whether to fire the "update available" notification for `version`.
 * We notify at most once per version: relaunches must not re-notify for a
 * version the user was already told about. `lastNotifiedVersion` is whatever
 * was persisted last (may be undefined/null/garbage on a fresh install).
 * Returns true only when `version` is a well-formed version we have NOT already
 * notified for (i.e. strictly newer than the last-notified one).
 */
export function shouldNotify(
  version: unknown,
  lastNotifiedVersion: unknown
): boolean {
  if (parseVersion(version) === null) return false;
  if (!lastNotifiedVersion) return true;
  return compareVersions(version, lastNotifiedVersion) > 0;
}

export interface UpdateCheckerOptions {
  currentVersion?: string;
  checkIntervalMs?: number;
  fetchImpl?: CheckFetch | null;
  onUpdateAvailable?: (info: { version: string }) => void;
  registryUrl?: string;
}

export class UpdateChecker {
  currentVersion: string;
  checkIntervalMs: number;
  fetchImpl: CheckFetch | null;
  onUpdateAvailable: ((info: { version: string }) => void) | null;
  registryUrl: string;
  timer: NodeJS.Timeout | null;
  initialTimer: NodeJS.Timeout | null;
  _checking: boolean;

  constructor({
    currentVersion,
    checkIntervalMs,
    fetchImpl,
    onUpdateAvailable,
    registryUrl,
  }: UpdateCheckerOptions = {}) {
    this.currentVersion =
      typeof currentVersion === 'string' ? currentVersion : '0.0.0';
    // Upper bound is the 32-bit signed max: Node clamps any setInterval delay
    // above 2^31-1 ms to 1ms, which would turn the interval check into a
    // per-ms registry request storm. Reject an out-of-range value -> default.
    this.checkIntervalMs =
      typeof checkIntervalMs === 'number' &&
      isFinite(checkIntervalMs) &&
      checkIntervalMs >= 60000 &&
      checkIntervalMs <= 2147483647
        ? Math.trunc(checkIntervalMs)
        : DEFAULT_CHECK_INTERVAL_MS;
    // An explicit `null` means "no network" (see checkNow) and must be honored;
    // only a missing (undefined) fetchImpl falls back to global fetch. A `||`
    // fallback would treat null as falsy and silently go live.
    this.fetchImpl =
      fetchImpl !== undefined
        ? fetchImpl
        : typeof fetch === 'function'
          ? (fetch.bind(null) as unknown as CheckFetch)
          : null;
    this.onUpdateAvailable =
      typeof onUpdateAvailable === 'function' ? onUpdateAvailable : null;
    this.registryUrl = registryUrl || REGISTRY_URL;
    this.timer = null;
    this.initialTimer = null;
    this._checking = false;
  }

  /**
   * Check the registry once. Resolves to `{ version }` when a strictly newer
   * version exists, or `null` in every other case (up to date, no fetch,
   * network error, timeout, bad status, malformed JSON). Never throws.
   * Fires onUpdateAvailable when a newer version is found.
   */
  async checkNow(): Promise<{ version: string } | null> {
    if (!this.fetchImpl) return null;
    if (this._checking) return null; // no overlapping in-flight requests
    this._checking = true;

    const controller =
      typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller
      ? setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
      : null;

    try {
      const res = await this.fetchImpl(this.registryUrl, {
        headers: { accept: 'application/json' },
        signal: controller ? controller.signal : undefined,
      });
      if (!res || !res.ok) return null;
      const data = (await res.json()) as { version?: unknown } | null;
      const latest =
        data && typeof data.version === 'string' ? data.version : null;
      if (latest && isNewerVersion(latest, this.currentVersion)) {
        const info = { version: latest };
        if (this.onUpdateAvailable) {
          try {
            this.onUpdateAvailable(info);
          } catch {
            /* callback must not break the check */
          }
        }
        return info;
      }
      return null;
    } catch {
      return null; // unreachable / DNS / abort / bad JSON — stay silent
    } finally {
      if (timeout) clearTimeout(timeout);
      this._checking = false;
    }
  }

  /** Check shortly after launch, then on the configured interval. */
  start(): void {
    if (this.timer || this.initialTimer) return;
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      this.checkNow();
    }, INITIAL_CHECK_DELAY_MS);
    if (this.initialTimer.unref) this.initialTimer.unref();

    this.timer = setInterval(() => this.checkNow(), this.checkIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.initialTimer) clearTimeout(this.initialTimer);
    if (this.timer) clearInterval(this.timer);
    this.initialTimer = null;
    this.timer = null;
  }
}

export { REGISTRY_URL, DEFAULT_CHECK_INTERVAL_MS };
