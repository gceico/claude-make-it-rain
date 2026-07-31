'use strict';

import {
  app,
  BrowserWindow,
  Tray,
  Menu,
  Notification,
  ipcMain,
  nativeImage,
  screen,
  shell,
  session,
  dialog,
} from 'electron';
import type {
  MenuItemConstructorOptions,
  MenuItem,
  Display,
  Rectangle,
  IpcMainEvent,
  NativeImage,
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { UsageMonitor } from './lib/usage-monitor';
import type { Snapshot } from './lib/usage-monitor';
import { CodexMonitor, emptyCodexSnapshot } from './lib/codex-monitor';
import type { CodexSnapshot } from './lib/codex-monitor';
import { mergeSnapshots, providerSplit } from './lib/snapshot-merge';
import { Config } from './lib/config';
import * as denominations from './lib/denominations';
import * as equivalences from './lib/equivalences';
import { LeaderboardClient } from './lib/leaderboard-client';
import { History, RANGES, billStacksLabel, dayKey } from './lib/history';
import type { Range, RangeResult, DayEntry } from './lib/history';
import {
  stackCountForCrossing,
  dollarsCrossed,
  crossedHundred,
} from './lib/milestones';
import { UpdateChecker, shouldNotify } from './lib/update-checker';
import { AnalyticsStore, emptyDailySnapshot } from './lib/analytics-store';
import type { ToolingState } from './lib/analytics-store';
import { runHabitDetectors, habitOfTheDay } from './lib/habits';
import type { HabitInput } from './lib/habits';
import { optimizationScore } from './lib/score';
import {
  detectTooling,
  installPlan,
  runInstallPlan,
  fetchRtkGainJson,
  enrichPath,
  TOOL_COMMANDS,
  TOOL_IDS,
  TOOL_LABELS,
} from './lib/tooling';
import type { CommandResult } from './lib/tooling';
import {
  parseRtkGainJson,
  parseRtkDailySavings,
  estimateDailyToolSavings,
} from './lib/score';
import type { DayToolSavings } from './lib/score';
import type { DailySnapshot } from './lib/analytics-store';
import { pricingForModel } from './lib/pricing';

// We only ever play synthesized output audio (Web Audio oscillators in the
// overlay) — nothing here captures audio. On macOS, Chromium's audio stack can
// still initialize a CoreAudio *input* unit when an AudioContext starts, which
// trips the OS microphone-permission prompt (attributed to the launching
// terminal, since the CLI isn't a signed .app bundle). As a belt-and-suspenders
// against any capture path ever opening the real device, route media streams to
// a fake device. The authoritative fix is the permission handlers registered in
// whenReady() below. Switches must be set before app is ready, so this lives at
// module top level.
app.commandLine.appendSwitch('use-fake-device-for-media-stream');

// ── Overlay bookkeeping types ─────────────────────────────────────────────────
interface PendingMessage {
  channel: string;
  payload: unknown;
}
interface OverlayEntry {
  win: BrowserWindow;
  ready: boolean;
  pending: PendingMessage[];
  // Wall-clock ms of the last flush that actually sent messages. Guards against
  // hiding the window on a stale in-flight 'overlay-idle' that races a freshly
  // flushed animation (see the 'overlay-idle' handler).
  lastFlushAt: number;
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray: Tray | null = null;
// One overlay window per display, keyed by Electron's display.id.
// Each entry: { win: BrowserWindow, ready: boolean, pending: [{channel, payload}] }
const overlays = new Map<number, OverlayEntry>();
let monitor: UsageMonitor | null = null;
let codexMonitor: CodexMonitor | null = null;
let config: Config | null = null;
let leaderboard: LeaderboardClient | null = null;
let updateChecker: UpdateChecker | null = null;
// Set once a newer version is seen; drives the top "⬆️ Update to vX.Y.Z" tray
// item. Cleared implicitly when the app relaunches (already up to date).
let availableUpdateVersion: string | null = null;
// True while `npm install -g …` is running, so the tray item shows "Updating…"
// and can't be clicked twice.
let updateInProgress = false;
const UPDATE_PACKAGE = '@gceico/claude-make-it-rain';
const RELEASES_URL = 'https://github.com/gceico/claude-make-it-rain/releases';
let latestSnapshot: Snapshot = {
  totalCostUSD: 0,
  inputTokens: 0,
  outputTokens: 0,
  entryCount: 0,
  perModel: {},
  cache: { readTokens: 0, creationTokens: 0 },
  sessions: { count: 0, maxContextTokens: 0 },
  userTurns: [],
  sessionGaps: [],
};
// Two independent spend sources — Claude Code and OpenAI Codex — each emit
// their own snapshot on their own poll. We hold the latest of each and combine
// them into `latestSnapshot` centrally (see onSourceUpdate) so the tray,
// milestone animations, and leaderboard see ONE running total with a single
// prev→new transition. Animations must not fire until BOTH sources have
// finished their first scan, or the second source's initial scan would replay
// its whole day as bills/stacks/rain.
let claudeSnapshot: Snapshot = latestSnapshot;
let codexSnapshot: CodexSnapshot = emptyCodexSnapshot();
let lastCombinedTotal = 0;
let claudeInitialDone = false;
let codexInitialDone = false;
// Set once BOTH sources have finished their first scan and the combined
// baseline has been seeded; only after that do transitions animate.
let baselineSeeded = false;
let history: History | null = null;
// rangeId -> scan result (or 'loading'); drives the "Past spending" submenu.
const historyData = new Map<string, RangeResult | 'loading'>();
const HISTORY_REFRESH_MS = 60_000;
const DAILY_TOOLING_CHECK_MS = 24 * 60 * 60 * 1000;

// ── Optimize / analytics globals ────────────────────────────────────────────
let analyticsStore: AnalyticsStore | null = null;
let toolingState: ToolingState = {
  rtk: { installed: false, version: null, detectedAtMs: 0 },
  caveman: { installed: false, version: null, detectedAtMs: 0 },
  ponytail: { installed: false, version: null, detectedAtMs: 0 },
};
let optimizeInProgress = false;
// Previous savings.lifetimeUSD, so tray/animation code can detect a crossing
// the same way spend milestones do (see lib/milestones.ts's savings* wrappers).
let previousSavingsUSD = 0;
// date 'YYYY-MM-DD' -> real RTK savedUSD for that day (from `rtk gain` daily[]).
let rtkDailySavings: Record<string, number> = {};
// RTK's real lifetime saved (priced summary.total_saved); the lifetime clamp
// uses this authoritative figure as its floor.
let previousRtkLifetimeReal = 0;
// True when an installed tool has a newer version available (rtk via brew).
let toolingUpdateAvailable = false;
let toolingUpdateInProgress = false;

/** Real command runner for lib/tooling.ts: execFile with a static argv array
 *  (never a shell string built from interpolated input — mirrors runUpdate()
 *  below). shell:true is intentionally NEVER passed here; RTK's universal
 *  installer already encodes its one deliberate curl|sh pipeline as a static
 *  `sh -c '<literal>'` argv element, so no shell wrapping is needed. */
function realCommandRunner(
  cmd: string,
  args: string[]
): Promise<CommandResult> {
  // A Finder/GUI-launched Electron app inherits a minimal PATH that omits
  // /opt/homebrew/bin, ~/.local/bin, ~/.cargo/bin — so rtk/claude/brew/which
  // all fail even when installed. Enrich PATH for the child (see enrichPath).
  const env = { ...process.env, PATH: enrichPath(process.env.PATH) };
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: 5 * 60 * 1000, env },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as NodeJS.ErrnoException).code !== 'number'
            ? 1
            : err
              ? ((err as unknown as { code?: number }).code ?? 1)
              : 0;
        resolve({
          code,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
        });
      }
    );
  });
}

// 16x16 green square fallback for platforms without tray title text (win/linux).
const FALLBACK_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPQ2xHznxLMMGrAqAGjBgwXAwBFLUEfBSikAwAAAABJRU5ErkJggg==';

function getTrayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    // The dollar amount lives in the tray title; no icon needed.
    return nativeImage.createEmpty();
  }
  return nativeImage.createFromDataURL(
    'data:image/png;base64,' + FALLBACK_ICON_B64
  );
}

// ── Tray ────────────────────────────────────────────────────────────────────
function formatTitle(total: number): string {
  const emoji = total >= 100 ? '🤑' : '💸';
  return `${emoji} $${total.toFixed(2)}`;
}

/** Token count as a compact figure: 1M / 12.3k / 950. */
function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${m >= 10 ? Math.round(m) : m.toFixed(1)}M`;
  }
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return `${n}`;
}

/** Days in a scan whose own spend hit $100 — the "rain days". */
function rainDayCount(days: DayEntry[]): number {
  return days.filter((d) => d.costUSD >= 100).length;
}

/** The Optimize tray item, reflecting tooling state: install missing tools,
 *  else offer an update when one is available, else a status line. */
function optimizeMenuItem(anyMissing: boolean): MenuItemConstructorOptions {
  if (anyMissing) {
    return {
      label: optimizeInProgress ? '⚡ Optimizing…' : '⚡ Optimize your spend…',
      enabled: !optimizeInProgress,
      click: () => runOptimize(),
    };
  }
  if (toolingUpdateAvailable) {
    return {
      label: toolingUpdateInProgress
        ? '⚡ Updating tools…'
        : '⚡ Update your tools (new version)',
      enabled: !toolingUpdateInProgress,
      click: () => runToolUpdate(),
    };
  }
  return {
    label: '⚡ Optimize (tools up to date)',
    enabled: !optimizeInProgress,
    click: () => runOptimize(), // shows the "everything installed" status sheet
  };
}

/** ` · saved [≈ ]$Y` suffix for a savings figure, or '' when zero. `≈` marks
 *  an estimated (Caveman/Ponytail) contribution; a pure-RTK figure is exact. */
function savedSuffix(savedUSD: number, hasEstimate: boolean): string {
  if (savedUSD <= 0) return '';
  return ` · saved ${hasEstimate ? '≈ ' : ''}$${savedUSD.toFixed(2)}`;
}

/** Builds the label + per-day submenu for one range from its scan result.
 *  Cost is already net (post-savings, see item E) so labels read `net $X`;
 *  the money avoided is shown alongside as `saved [≈ ]$Y`. */
function historyMenuItem(range: Range): MenuItemConstructorOptions {
  const data = historyData.get(range.id);
  if (!data || data === 'loading') {
    return { label: `${range.label}: …`, enabled: false };
  }

  // Sum per-day savings over the range (real RTK + estimated Caveman/Ponytail).
  let rangeSaved = 0;
  let rangeHasEstimate = false;
  for (const d of data.days) {
    const sv = daySavings(d.date);
    rangeSaved += sv.total;
    rangeHasEstimate = rangeHasEstimate || sv.hasEstimate;
  }

  const stacks = billStacksLabel(data.totalCostUSD);
  const rainDays = rainDayCount(data.days);
  let label = `${range.label}: net $${data.totalCostUSD.toFixed(2)}`;
  label += savedSuffix(rangeSaved, rangeHasEstimate);
  if (stacks) label += ` · ${stacks}`;
  if (rainDays > 0)
    label += ` (${rainDays} rain day${rainDays === 1 ? '' : 's'})`;

  // Per-day breakdown, most recent first, with 💰 per $100 (capped) that day.
  const dayItems: MenuItemConstructorOptions[] = [...data.days]
    .reverse()
    .map((d) => {
      const s = billStacksLabel(d.costUSD);
      const sv = daySavings(d.date);
      return {
        label: `${d.date}: net $${d.costUSD.toFixed(2)}${savedSuffix(sv.total, sv.hasEstimate)}${s ? '  ' + s : ''}`,
        enabled: false,
      };
    });
  const submenu: MenuItemConstructorOptions[] = dayItems.length
    ? dayItems
    : [{ label: 'No spend in this range', enabled: false }];

  return { label, submenu };
}

/**
 * The "See your wealth" submenu: the physical-money breakdown plus tangible
 * equivalences ("≈ 2 burgers", "≈ 10% of a trip to Greece") that reframe the
 * number as spend you can feel, not a score to beat.
 */
function wealthSubmenu(totalUSD: number): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: denominations.format(totalUSD), enabled: false },
    { type: 'separator' },
    { label: '💰 = $100   💵 = $1   🪙 = 1¢', enabled: false },
  ];
  // Rotate the featured items once per day so the reflection stays fresh.
  const day = equivalences.localDayIndex();
  const treat = equivalences.treats(totalUSD, day);
  const slice = equivalences.bigTicketFraction(totalUSD, day);
  if (treat || slice) {
    items.push({ type: 'separator' });
    if (treat) {
      items.push({ label: `≈ ${treat.text} ${treat.emoji}`, enabled: false });
    }
    if (slice) {
      items.push({ label: `≈ ${slice.text} ${slice.emoji}`, enabled: false });
    }
    items.push({ label: 'Was it worth building it?', enabled: false });
  }
  return items;
}

/** Maps the live, in-memory Snapshot (usage-monitor.ts) to the analytics
 *  store's DailySnapshot shape, for feeding today's numbers into the habit
 *  engine / score before today has been persisted (only completed days are
 *  written to analytics-store — see history.ts's ledger scan). Sessions,
 *  user turns, and idle gaps are now tracked live by the monitor, so all
 *  detectors fire on today's data. */
function liveDailySnapshot(): import('./lib/analytics-store').DailySnapshot {
  const s = latestSnapshot;
  const perModel: Record<
    string,
    { costUSD: number; inTok: number; outTok: number }
  > = {};
  for (const [model, m] of Object.entries(s.perModel)) {
    perModel[model] = {
      costUSD: m.costUSD,
      inTok: m.inputTokens,
      outTok: m.outputTokens,
    };
  }
  const totalCacheTok = s.cache.readTokens + s.cache.creationTokens;
  return {
    costUSD: s.totalCostUSD,
    perModel,
    cache: {
      readTok: s.cache.readTokens,
      creationTok: s.cache.creationTokens,
      hitRatio: totalCacheTok > 0 ? s.cache.readTokens / totalCacheTok : 0,
    },
    sessions: { ...s.sessions },
    habitCounts: {},
  };
}

function buildHabitInput(): HabitInput {
  return {
    snapshot: liveDailySnapshot(),
    toolingState,
    userTurns: latestSnapshot.userTurns,
    sessionGaps: latestSnapshot.sessionGaps,
  };
}

/** Cumulative "seen N×" total for a habit id: sum of every stored day's
 *  habitCounts[id] (finalized days) plus today's live count on top. */
function cumulativeHabitCount(id: string, liveCount: number): number {
  let total = liveCount;
  if (analyticsStore) {
    for (const day of Object.values(analyticsStore.data.dailySnapshots)) {
      total += day.habitCounts[id] || 0;
    }
  }
  return total;
}

/** The "Your habits" submenu: every non-"info" detector with its cumulative
 *  occurrence count (stored history + today's live count), neutral-coach
 *  copy, no roasting. */
function habitsSubmenu(): MenuItemConstructorOptions[] {
  const results = runHabitDetectors(buildHabitInput());
  const actionable = results.filter((r) => r.severity !== 'info');
  if (actionable.length === 0) {
    return [{ label: 'No habits flagged today', enabled: false }];
  }
  return actionable.map((r) => {
    const seen = cumulativeHabitCount(r.id, r.count);
    return {
      label: `${r.triggered ? '•' : '✓'} ${r.coachCopy}${seen > 0 ? ` (seen ${seen}×)` : ''}`,
      enabled: false,
    };
  });
}

/** Awareness facts (model split, cache rate, Optimization Score, net saved)
 *  appended to the "See your numbers" submenu. */
function awarenessItems(): MenuItemConstructorOptions[] {
  const results = runHabitDetectors(buildHabitInput());
  const byId = new Map(results.map((r) => [r.id, r]));
  const giantPasteCount = byId.get('giant-paste')?.count ?? 0;
  const staleCacheIdleCount = byId.get('stale-cache-idle')?.count ?? 0;
  const score = optimizationScore({
    snapshot: liveDailySnapshot(),
    toolingState,
    giantPasteCount,
    staleCacheIdleCount,
  });
  const lifetime = analyticsStore ? analyticsStore.data.savings.lifetimeUSD : 0;

  const items: MenuItemConstructorOptions[] = [{ type: 'separator' }];
  // The tray total folds both coding agents together; this is the only place
  // the per-provider breakdown survives. Shown only once Codex has spent
  // something, so Claude-only users see no extra noise.
  const split = providerSplit(latestSnapshot.perModel);
  if (split.codex > 0) {
    items.push({
      label: `By tool: Claude Code $${split.claude.toFixed(2)} · Codex $${split.codex.toFixed(2)}`,
      enabled: false,
    });
  }
  const modelSplit = byId.get('model-split');
  const cacheRate = byId.get('cache-rate');
  if (modelSplit) items.push({ label: modelSplit.coachCopy, enabled: false });
  if (cacheRate) items.push({ label: cacheRate.coachCopy, enabled: false });
  items.push({ label: `Optimization Score: ${score}/100`, enabled: false });
  items.push({
    label: `Net saved (lifetime): $${lifetime.toFixed(2)}`,
    enabled: false,
  });
  return items;
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const s = latestSnapshot;
  const muted = config ? !!config.get('muted') : false;
  const template: MenuItemConstructorOptions[] = [];

  // Top item: only present once a newer version has been detected. While the
  // install runs it disables itself and reads "Updating…".
  if (availableUpdateVersion) {
    template.push(
      updateInProgress
        ? { label: 'Updating…', enabled: false }
        : {
            label: `⬆️ Update to v${availableUpdateVersion}`,
            click: () => runUpdate(),
          },
      { type: 'separator' }
    );
  }

  // The shown cost is already net (RTK compression lowered real token cost);
  // "(net)" makes clear we are NOT subtracting savings again. The headline
  // saved figure is TODAY's (matches "Today (net)"); lifetime lives in the
  // savings drawer. `≈` marks an estimated (Caveman/Ponytail) contribution.
  const todaySaved = daySavings(dayKey(new Date()));

  template.push(
    { label: `Today (net): $${s.totalCostUSD.toFixed(2)}`, enabled: false },
    {
      label: `Saved today ${todaySaved.hasEstimate ? '≈ ' : ''}$${todaySaved.total.toFixed(2)}`,
      enabled: false,
    },
    {
      label: `Tokens today: ${formatTokens(s.inputTokens)} in / ${formatTokens(s.outputTokens)} out`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'See your numbers',
      submenu: [...wealthSubmenu(s.totalCostUSD), ...awarenessItems()],
    },
    { label: 'Past spending', submenu: RANGES.map(historyMenuItem) }
  );

  const dayHabit = habitOfTheDay(runHabitDetectors(buildHabitInput()));
  const anyMissing = TOOL_IDS.some((id) => !toolingState[id].installed);
  template.push({ type: 'separator' }, optimizeMenuItem(anyMissing));
  template.push(
    {
      label: dayHabit ? `${dayHabit.coachCopy}` : 'Habit of the day',
      enabled: false,
    },
    { label: 'Your habits', submenu: habitsSubmenu() }
  );

  if (leaderboard) {
    const lb = leaderboard;
    template.push(
      { type: 'separator' },
      { label: `User tag: ${lb.gamerTag}`, enabled: false },
      {
        label: 'Share on collective spend',
        type: 'checkbox',
        checked: lb.telemetryEnabled,
        click: (item: MenuItem) => {
          lb.setTelemetryEnabled(item.checked);
          if (item.checked) lb.reportNow();
          rebuildTrayMenu();
        },
      },
      {
        label: 'New random tag',
        click: () => {
          lb.regenerateTag();
          rebuildTrayMenu();
        },
      },
      { label: "View everyone's spend…", click: () => openLeaderboardPage() }
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Test animations',
      submenu: [
        // Pure single-animation previews (no mixed spend+save) — the real
        // down-then-up choreography is wired in onUpdate at actual milestones.
        { label: 'Spend: $10 stack', click: () => stacksFromTray(1, 'spend') },
        { label: 'Spend: $50 stacks', click: () => stacksFromTray(5, 'spend') },
        { label: 'Spend: $100 rain', click: () => rainAllDisplays('spend') },
        { type: 'separator' },
        { label: 'Saved: $10 stack', click: () => stacksFromTray(1, 'save') },
        { label: 'Saved: $50 stacks', click: () => stacksFromTray(5, 'save') },
      ],
    },
    {
      label: 'Mute sounds',
      type: 'checkbox',
      checked: muted,
      click: (item: MenuItem) => setMuted(item.checked),
    },
    { label: 'Quit', click: () => app.quit() }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function openLeaderboardPage(): void {
  try {
    if (!leaderboard) return;
    const base = leaderboard.apiBaseUrl.replace(/\/+$/, '');
    // Open the personal reflection view for this install's tag. The tag is
    // already sanitized to [A-Za-z0-9_-] (leaderboard-client sanitizeTag) and
    // apiBaseUrl is isSafeHttpUrl-guarded, so the URL handed to openExternal is
    // safe; encodeURIComponent is belt-and-suspenders.
    const tag = encodeURIComponent(leaderboard.gamerTag);
    shell.openExternal(base + '/?tag=' + tag);
  } catch {
    /* ignore — opening the page is best-effort */
  }
}

/** Fire-and-forget desktop notification. Never throws (best-effort UX). */
function notify(title: string, body: string): void {
  try {
    if (Notification.isSupported && !Notification.isSupported()) return;
    new Notification({ title, body }).show();
  } catch {
    /* notifications are best-effort; never crash on them */
  }
}

/**
 * Called when the update checker finds a newer version. Records it for the tray
 * item, and shows exactly ONE notification per version — gated on the
 * `lastNotifiedUpdateVersion` key in the shared config so relaunches don't
 * re-notify for a version the user already saw.
 */
function onUpdateAvailable({ version }: { version: string }): void {
  availableUpdateVersion = version;
  const lastNotified = config ? config.get('lastNotifiedUpdateVersion') : null;
  if (shouldNotify(version, lastNotified)) {
    if (config) config.set('lastNotifiedUpdateVersion', version);
    notify('Make It Rain', `Make It Rain v${version} is available`);
  }
  if (tray) rebuildTrayMenu();
}

/**
 * Update in place via the global npm install. Uses execFile (argv array, NOT a
 * shell string) so the version is never shell-interpolated. On success we can't
 * hot-swap a running Electron app, so we ask the user to restart; on failure we
 * fall back to opening the GitHub releases page. Never crashes the app.
 */
function runUpdate(): void {
  if (updateInProgress || !availableUpdateVersion) return;
  updateInProgress = true;
  rebuildTrayMenu();

  const target = availableUpdateVersion;
  const args = ['install', '-g', `${UPDATE_PACKAGE}@${target}`];
  // On Windows the npm CLI is npm.cmd, which cannot be spawned without a shell
  // (Node throws EINVAL for implicit .cmd spawns since CVE-2024-27980); with
  // shell:true cmd.exe resolves npm.cmd via PATHEXT. shell:true is safe here
  // ONLY because every argv element is a static literal (UPDATE_PACKAGE const +
  // 'install'/'-g'/`target`, already validated by the update checker's
  // parseVersion) — no shell interpolation, preserving the doc-comment invariant.
  const isWin = process.platform === 'win32';
  execFile('npm', args, { timeout: 5 * 60 * 1000, shell: isWin }, (err) => {
    updateInProgress = false;
    if (err) {
      notify('Make It Rain', 'Update failed. Opening the releases page.');
      try {
        shell.openExternal(RELEASES_URL);
      } catch {
        /* best-effort */
      }
      rebuildTrayMenu();
      return;
    }
    // Installed the new global binary; the running process still holds the old
    // code, so a restart is required to pick it up.
    availableUpdateVersion = null;
    notify('Make It Rain', `Updated to v${target}. Quit and restart to apply.`);
    rebuildTrayMenu();
  });
}

/**
 * Refresh toolingState from the real detect commands and persist it. Never
 * throws — detectTooling's individual detectors are already best-effort.
 */
async function refreshToolingState(): Promise<void> {
  const detected = await detectTooling(realCommandRunner);
  const now = Date.now();
  toolingState = {
    rtk: { ...detected.rtk, detectedAtMs: now },
    caveman: { ...detected.caveman, detectedAtMs: now },
    ponytail: { ...detected.ponytail, detectedAtMs: now },
  };
  if (analyticsStore) {
    for (const id of TOOL_IDS)
      analyticsStore.setToolingState(id, toolingState[id]);
  }
}

/**
 * Re-check RTK's `rtk gain` savings and fold it into the running lifetime
 * total. RTK reports an authoritative TOKEN count (summary.total_saved),
 * priced conservatively at input rate in parseRtkGainJson — it is not a raw
 * dollar figure. Best-effort: a parse/exec failure just leaves the lifetime
 * total unchanged rather than fabricating a number.
 */
async function refreshSavingsFromRtk({
  animate = true,
}: { animate?: boolean } = {}): Promise<void> {
  if (!analyticsStore) return;
  if (toolingState.rtk.installed) {
    const json = await fetchRtkGainJson(realCommandRunner);
    rtkDailySavings = parseRtkDailySavings(json, pricingForModel);
    const parsed = parseRtkGainJson(json, pricingForModel);
    if (parsed) previousRtkLifetimeReal = Math.max(0, parsed.savedUSD);
  } else {
    rtkDailySavings = {};
    previousRtkLifetimeReal = 0;
  }

  // Lifetime = RTK's authoritative real total (floor) + the accumulated
  // estimated Caveman/Ponytail portion across stored days, clamped so lifetime
  // saved can never exceed lifetime spend. Never decreases (max with stored).
  let estPortion = 0;
  let lifetimeSpend = 0;
  for (const [date, snap] of Object.entries(
    analyticsStore.data.dailySnapshots
  )) {
    lifetimeSpend += snap.costUSD;
    const d = estimateDailyToolSavings({
      snapshot: snap,
      toolingState,
      rtkRealUSD: rtkDailySavings[date] || 0,
      pricingForModelFn: pricingForModel,
    });
    estPortion += d.cavemanEst + d.ponytailEst;
  }
  const capped = Math.min(previousRtkLifetimeReal + estPortion, lifetimeSpend);
  const lifetime = Math.max(analyticsStore.data.savings.lifetimeUSD, capped);
  analyticsStore.setSavings({
    lifetimeUSD: lifetime,
    lastReportedUSD: analyticsStore.data.savings.lastReportedUSD,
  });

  // Reuse the same whole-dollar crossing math as the red spend side (see
  // lib/milestones.ts's dollarsCrossed) so a growing lifetime saving fires
  // its own green dollar-up flies, on the display holding the tray anchor.
  // The launch call passes animate:false: on a first run (stored lifetime $0)
  // RTK's whole existing savings total would otherwise fly as green bills at
  // startup. Startup only seeds the baseline.
  const dollarsGained = dollarsCrossed(previousSavingsUSD, lifetime);
  if (animate && dollarsGained > 0) flyBillsFromTray(dollarsGained, 'save');
  previousSavingsUSD = lifetime;
}

/** Best-effort daily version-outdated check. Only RTK-via-brew exposes a clean
 *  signal (`brew outdated rtk`, exit 0 + non-empty = outdated); plugins have no
 *  clean `outdated` command, so we don't fake one. Fail-silent → "current". */
async function refreshToolingOutdated(): Promise<void> {
  if (!toolingState.rtk.installed) {
    toolingUpdateAvailable = false;
    return;
  }
  const [cmd, args] = TOOL_COMMANDS.rtk.outdated;
  const r = await realCommandRunner(cmd, args);
  toolingUpdateAvailable = r.code === 0 && /rtk/.test(r.stdout);
}

/** Savings for one day: real RTK (daily map) + estimated Caveman/Ponytail,
 *  using the day's stored snapshot (or today's live one). */
function daySavings(dateKey: string): DayToolSavings {
  const todayKey = dayKey(new Date());
  // Past dates read their stored snapshot; with no store there is no history,
  // so fall back to an empty day (NOT today's live snapshot — that would
  // credit a past date with today's numbers).
  const snapshot: DailySnapshot =
    dateKey === todayKey
      ? liveDailySnapshot()
      : analyticsStore
        ? analyticsStore.getDay(dateKey)
        : emptyDailySnapshot();
  return estimateDailyToolSavings({
    snapshot,
    toolingState,
    rtkRealUSD: rtkDailySavings[dateKey] || 0,
    pricingForModelFn: pricingForModel,
  });
}

/**
 * "⚡ Optimize your spend…" — the confirm-sheet-driven installer. Native
 * dialog.showMessageBox IS the transparent confirm sheet (no custom modal
 * window exists in this app); its `detail` text lists every command that will
 * run verbatim ("Show commands" disclosure), and every argv handed to
 * execFile is a static literal from lib/tooling.ts — never built from user
 * input. On success: re-detect tooling, persist an optimizeMilestone, and
 * fire the first green 💵💚 as the reward.
 */
async function runOptimize(): Promise<void> {
  if (optimizeInProgress) return;
  const missing = TOOL_IDS.filter((id) => !toolingState[id].installed);

  if (missing.length === 0) {
    dialog.showMessageBox({
      type: 'info',
      title: 'Make It Rain — Optimize',
      message: 'Everything is already installed.',
      detail: TOOL_IDS.map(
        (id) => `${TOOL_LABELS[id]}: ${toolingState[id].version || 'installed'}`
      ).join('\n'),
    });
    return;
  }

  const steps = await installPlan(missing, realCommandRunner);
  const commandsPreview = steps
    .map((s) => `${s.label}: ${s.argv.join(' ')}`)
    .join('\n');

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Install'],
    defaultId: 1,
    cancelId: 0,
    title: 'Make It Rain — Optimize',
    message: `Install ${missing.map((id) => TOOL_LABELS[id]).join(', ')}?`,
    detail: `This runs the following official commands on your machine — nothing else:\n\n${commandsPreview}`,
  });
  if (response !== 1) return;

  optimizeInProgress = true;
  rebuildTrayMenu();

  try {
    const baselineCostRate = latestSnapshot.totalCostUSD;
    const results = await runInstallPlan(steps, realCommandRunner);
    const allOk = results.every((r) => r.ok);

    await refreshToolingState();
    if (analyticsStore) {
      analyticsStore.addOptimizeMilestone({
        atMs: Date.now(),
        tools: missing,
        baselineCostRate,
      });
    }
    await refreshSavingsFromRtk();

    if (allOk) {
      notify('Make It Rain', 'Optimize complete — tooling installed.');
      flyBillsFromTray(1, 'save'); // the reward: first green 💵⬆️
    } else {
      notify('Make It Rain', 'Optimize finished with some steps failing.');
    }
  } catch (err) {
    notify('Make It Rain', 'Optimize failed to run.');
    console.warn('MakeItRain: optimize failed:', (err as Error).message);
  } finally {
    optimizeInProgress = false;
    rebuildTrayMenu();
  }
}

/**
 * "⚡ Update your tools (new version)" — RTK is the only tool with a clean
 * update signal (brew), so it's the only one this runs. Same confirm-sheet
 * transparency pattern as runOptimize: the exact command is shown verbatim in
 * `detail` before anything executes. Fail-silent, never throws.
 */
async function runToolUpdate(): Promise<void> {
  if (toolingUpdateInProgress) return;

  const [cmd, args] = TOOL_COMMANDS.rtk.upgrade;
  const commandPreview = `${TOOL_LABELS.rtk}: ${[cmd, ...args].join(' ')}`;

  const { response } = await dialog.showMessageBox({
    type: 'question',
    buttons: ['Cancel', 'Update'],
    defaultId: 1,
    cancelId: 0,
    title: 'Make It Rain — Optimize',
    message: `Update ${TOOL_LABELS.rtk}?`,
    detail: `This runs the following official command on your machine — nothing else:\n\n${commandPreview}`,
  });
  if (response !== 1) return;

  toolingUpdateInProgress = true;
  rebuildTrayMenu();

  try {
    const result = await realCommandRunner(cmd, args);
    await refreshToolingState();
    await refreshToolingOutdated();
    await refreshSavingsFromRtk();

    if (result.code === 0) {
      notify('Make It Rain', 'RTK updated.');
    } else {
      notify('Make It Rain', 'RTK update finished with errors.');
    }
  } catch (err) {
    notify('Make It Rain', 'RTK update failed to run.');
    console.warn('MakeItRain: tool update failed:', (err as Error).message);
  } finally {
    toolingUpdateInProgress = false;
    rebuildTrayMenu();
  }
}

function setMuted(muted: boolean): void {
  if (config) config.set('muted', muted);
  // Update every loaded overlay directly (bypassing queueToOverlay) so
  // toggling mute never shows a hidden overlay window just to sync a flag.
  for (const entry of overlays.values()) {
    if (entry.ready) entry.win.webContents.send('set-muted', muted);
  }
  rebuildTrayMenu();
}

function applySnapshot(snapshot: Snapshot): void {
  latestSnapshot = snapshot;
  if (tray && process.platform === 'darwin') {
    tray.setTitle(formatTitle(snapshot.totalCostUSD));
  }
  if (tray)
    tray.setToolTip(`Make It Rain today: $${snapshot.totalCostUSD.toFixed(2)}`);
  rebuildTrayMenu();
}

/** Screen-coordinate anchor for the dollar-fly animation (the tray item). */
function trayAnchor(): Rectangle {
  try {
    if (tray) {
      const b = tray.getBounds();
      if (b && b.width > 0) return b;
    }
  } catch {
    /* tray bounds unavailable on some platforms */
  }
  // Fallback: top-right corner of the primary display.
  const { bounds } = screen.getPrimaryDisplay();
  return {
    x: bounds.x + bounds.width - 40,
    y: bounds.y,
    width: 20,
    height: 22,
  };
}

// ── Overlay windows (one per display) ───────────────────────────────────────
// Marks the window so it floats above everything — including full-screen apps
// and other Spaces — and never steals focus or clicks.
function makeOverlayFloat(win: BrowserWindow): void {
  // 'screen-saver' is the highest standard level, above full-screen apps.
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setIgnoreMouseEvents(true);
  if (process.platform === 'darwin') {
    // Show on every Space and over full-screen apps rather than only the
    // Space that happens to be focused.
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
}

// Create (or return the existing) overlay window for a given display.
function createOverlayForDisplay(display: Display): OverlayEntry {
  const existing = overlays.get(display.id);
  if (existing) return existing;

  const { bounds } = display;
  const win = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      // Resolved from the app root (where package.json lives) rather than
      // __dirname: Bun's bundler inlines __dirname as a build-time constant,
      // which would bake this machine's absolute source path into dist/.
      preload: path.join(app.getAppPath(), 'dist', 'preload.js'),
      // The overlay is non-focusable and never receives a user gesture, so the
      // default autoplay policy would leave its AudioContext suspended. Allow
      // sound without a gesture (the renderer also resumes defensively).
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  makeOverlayFloat(win);

  const entry: OverlayEntry = {
    win,
    ready: false,
    pending: [],
    lastFlushAt: 0,
  };
  overlays.set(display.id, entry);

  // The overlay HTML lives at the app root (kept alongside package.json,
  // unbundled).
  win.loadFile(path.join(app.getAppPath(), 'overlay.html'));
  win.webContents.on('did-finish-load', () => {
    entry.ready = true;
    // Sync the persisted mute preference every time this overlay (re)loads.
    win.webContents.send('set-muted', config ? !!config.get('muted') : false);
    flushOverlay(entry);
  });
  win.on('closed', () => {
    overlays.delete(display.id);
  });
  return entry;
}

// Ensure every current display has an overlay window.
function ensureOverlays(): void {
  for (const display of screen.getAllDisplays())
    createOverlayForDisplay(display);
}

// The overlay covering the primary display (used by the test screenshot hook).
function primaryOverlayWin(): BrowserWindow | null {
  const entry = overlays.get(screen.getPrimaryDisplay().id);
  return entry ? entry.win : null;
}

// Queue a message for one overlay, flushing immediately if it's ready.
function queueToOverlay(
  entry: OverlayEntry,
  channel: string,
  payload: unknown
): void {
  entry.pending.push({ channel, payload });
  if (entry.ready) flushOverlay(entry);
}

function flushOverlay(entry: OverlayEntry): void {
  if (!entry.ready) return;
  // showInactive() reveals the window without stealing focus from the
  // foreground app, so the animation plays even when we're not focused.
  if (!entry.win.isVisible()) entry.win.showInactive();
  // Re-assert the float level in case the window was recreated or the OS
  // demoted it while hidden.
  makeOverlayFloat(entry.win);
  if (entry.pending.length > 0) {
    for (const { channel, payload } of entry.pending) {
      entry.win.webContents.send(channel, payload);
    }
    entry.pending = [];
    entry.lastFlushAt = Date.now();
  }
}

type Variant = 'spend' | 'save';

// Rain plays everywhere, but the coin shimmer plays only on the primary
// display — otherwise every overlay would layer the same sound simultaneously.
// variant: 'spend' (default, red — every $100 spent) | 'save' (green — used
// as the closer after a spend-triggered rain to show savings, never on its
// own).
function rainAllDisplays(variant: Variant = 'spend'): void {
  ensureOverlays();
  const primaryId = screen.getPrimaryDisplay().id;
  for (const [displayId, entry] of overlays.entries()) {
    queueToOverlay(entry, 'rain', { sound: displayId === primaryId, variant });
  }
}

// Resolve the overlay entry for the display containing the tray anchor, plus
// the anchor converted to that display's local coordinate space. Tray-anchored
// animations (dollar-fly, milestone stacks) play only on that display.
function trayDisplayTarget(): { entry: OverlayEntry; anchor: Rectangle } {
  const a = trayAnchor();
  const center = {
    x: a.x + Math.floor(a.width / 2),
    y: a.y + Math.floor(a.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center);
  const entry = createOverlayForDisplay(display);
  const { bounds } = display;
  const anchor: Rectangle = {
    x: a.x - bounds.x,
    y: a.y - bounds.y,
    width: a.width,
    height: a.height,
  };
  return { entry, anchor };
}

// Dollar-fly plays on whichever display holds the tray anchor.
function flyBillsFromTray(count: number, variant: Variant = 'spend'): void {
  const { entry, anchor } = trayDisplayTarget();
  queueToOverlay(entry, 'fly-bills', { count, anchor, variant });
}

// Milestone stacks ($10/$50) burst from the tray anchor on its display.
function stacksFromTray(count: number, variant: Variant = 'spend'): void {
  const { entry, anchor } = trayDisplayTarget();
  queueToOverlay(entry, 'stack', { count, anchor, variant });
}

// A renderer reports it went idle; hide only that window (if nothing's queued).
ipcMain.on('overlay-idle', (event: IpcMainEvent) => {
  for (const entry of overlays.values()) {
    if (entry.win.webContents === event.sender) {
      // Ignore a stale idle report that raced a just-flushed animation: every
      // animation runs >= 1.8 s plus the renderer's 500 ms idle debounce, so a
      // genuine idle report always arrives well beyond 1 s after the last
      // flush, while an in-flight stale one arrives within milliseconds of it.
      if (entry.pending.length === 0 && Date.now() - entry.lastFlushAt > 1000)
        entry.win.hide();
      break;
    }
  }
});

// Keep overlays in sync with the physical display layout.
function watchDisplays(): void {
  screen.on('display-added', (_e, display) => createOverlayForDisplay(display));
  screen.on('display-removed', (_e, display) => {
    const entry = overlays.get(display.id);
    if (entry) {
      entry.win.destroy();
      overlays.delete(display.id);
    }
  });
  screen.on('display-metrics-changed', (_e, display) => {
    const entry = overlays.get(display.id);
    if (entry) entry.win.setBounds(display.bounds);
  });
}

// ── Monitor wiring ──────────────────────────────────────────────────────────
/**
 * Recombine the latest Claude + Codex snapshots into one total and drive the
 * animations off a single combined prev→new transition. Called on every update
 * from either source. Baseline gating (no animation until both sources have
 * completed their initial scan) lives here rather than in handleUpdate, so the
 * second source coming online never replays a day of spend as animations.
 */
function onSourceUpdate(): void {
  const combined = mergeSnapshots(claudeSnapshot, codexSnapshot);

  // Until both sources' first scans are in AND the combined baseline has been
  // seeded, just update the tray/latestSnapshot without animating: the jump
  // from $0 to today's already-accumulated total (and the second source coming
  // online) must never replay the day as bills, stacks, or rain.
  if (!(claudeInitialDone && codexInitialDone) || !baselineSeeded) {
    if (claudeInitialDone && codexInitialDone) baselineSeeded = true;
    lastCombinedTotal = combined.totalCostUSD;
    applySnapshot(combined);
    return;
  }

  const previousTotal = lastCombinedTotal;
  lastCombinedTotal = combined.totalCostUSD;
  handleUpdate(previousTotal, combined);
}

function handleUpdate(previousTotal: number, snapshot: Snapshot): void {
  applySnapshot(snapshot);

  const newTotal = snapshot.totalCostUSD;

  // Dollar-fly: number of whole-dollar boundaries crossed since the last update.
  const dollarsGained = dollarsCrossed(previousTotal, newTotal);
  if (dollarsGained > 0) {
    flyBillsFromTray(dollarsGained);
  }

  // Milestone stacks ($10 → one 10-bill stack, $50 → five): fire the first
  // time today's total crosses the threshold. The thresholds/counts and the
  // crossing rules (midnight reset for free, highest-only on multi-cross)
  // live in lib/milestones.ts.
  //
  // Choreography (per the release plan): red spend-stack first, THEN — once
  // it lands — a green savings-stack showing the running lifetime savings
  // total, so a spend milestone always closes on "but here's what you saved".
  const stackCount = stackCountForCrossing(previousTotal, newTotal);
  if (stackCount > 0) {
    stacksFromTray(stackCount, 'spend');
    scheduleSavingsFollowUp();
  }

  // $100-rain: trigger if we crossed at least one multiple of 100. Full red
  // spend rain (all 💵🔻) first, THEN the green savings reinforcement as the
  // closer once the first rain has cleared (rain runs ~6s in the overlay) — so
  // a $100 milestone shows both the money gone and the money saved back.
  if (crossedHundred(previousTotal, newTotal)) {
    rainAllDisplays('spend');
    scheduleSavingsFollowUp(6200);
  }
}

/** The green "here's what you saved" reinforcement that closes a spend
 *  milestone. Mirrors spend magnitude off TODAY's tool savings (matches the
 *  "Saved today" tray line): nothing under $1, dollar-flies at $1–$9, stacks
 *  ($10 each, capped at 5) from $10 up. Never an empty gesture. */
function playSavingsReinforcement(): void {
  const saved = daySavings(dayKey(new Date())).total;
  if (saved < 1) return; // under $1 — show nothing
  if (saved < 10) {
    flyBillsFromTray(Math.floor(saved), 'save'); // $1–$9 — that many green bills
    return;
  }
  const stacks = Math.max(1, Math.min(5, Math.floor(saved / 10)));
  stacksFromTray(stacks, 'save'); // $10+ — one green stack per $10
}

/** Schedules the savings reinforcement after `delayMs` (default: just after the
 *  preceding red stack lands), but ONLY when there is at least $1 saved today —
 *  green never plays on a sub-dollar (or zero) saving. */
function scheduleSavingsFollowUp(delayMs = 900): void {
  if (daySavings(dayKey(new Date())).total < 1) return;
  setTimeout(playSavingsReinforcement, delayMs);
}

// ── Past-spending history ─────────────────────────────────────────────────────
/** Lazily (re)scan every range in the background and refresh the menu as each
 *  result lands. Never blocks the tray. Past days come from History's
 *  immutable per-day ledger (built once per local day), so even a forced
 *  refresh only re-reads files touched today — steady-state cost stays near
 *  zero regardless of how much log history exists. */
function refreshHistory({ force = false }: { force?: boolean } = {}): void {
  if (!history) return;
  for (const range of RANGES) {
    if (!historyData.has(range.id)) historyData.set(range.id, 'loading');
    history
      .get(range.id, { force })
      .then((data) => {
        historyData.set(range.id, data);
        rebuildTrayMenu();
      })
      .catch((err: Error) => {
        console.warn(
          `MakeItRain: history scan for ${range.id} failed:`,
          err.message
        );
      });
  }
}

// ── App lifecycle ───────────────────────────────────────────────────────────
// MIR_TEST_USER_DATA=/path  points a test launch at its own userData dir so it
// neither collides with a running real instance (the single-instance lock is
// scoped to userData) nor pollutes its config. Pre-seed the dir's config.json
// with {"telemetryEnabled": false} to keep test launches off the leaderboard.
if (process.env.MIR_TEST_USER_DATA) {
  app.setPath('userData', process.env.MIR_TEST_USER_DATA);
}
if (!app.requestSingleInstanceLock()) {
  console.log('MakeItRain: already running, exiting.');
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    // This app never needs the microphone, camera, or any other gated device.
    // Deny every permission request/check so Chromium never escalates to the OS
    // (and the user never sees a stray mic prompt from the launching terminal).
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_wc, _permission, callback) =>
      callback(false)
    );
    ses.setPermissionCheckHandler(() => false);
    if (ses.setDevicePermissionHandler)
      ses.setDevicePermissionHandler(() => false);

    config = new Config(path.join(app.getPath('userData'), 'config.json'));
    // Separate, versioned analytics.json store (see lib/analytics-store.ts) —
    // NOT the shared config.json — for per-day rollups, tooling state, and
    // the running net-savings total that drives the green celebration + the
    // one savedUSD KPI reported to the collective board.
    analyticsStore = new AnalyticsStore(
      path.join(app.getPath('userData'), 'analytics.json')
    );
    toolingState = analyticsStore.data.toolingState;
    previousSavingsUSD = analyticsStore.data.savings.lifetimeUSD;
    // Re-detect in the background at launch so a relaunch after installing a
    // tool outside the app (or the very first launch) reflects reality.
    refreshToolingState()
      .then(() => refreshSavingsFromRtk({ animate: false }))
      .then(() => refreshToolingOutdated())
      .then(() => rebuildTrayMenu())
      .catch((err: Error) =>
        console.warn(
          'MakeItRain: initial tooling detection failed:',
          err.message
        )
      );
    const toolingOutdatedTimer = setInterval(
      () => refreshToolingOutdated().then(() => rebuildTrayMenu()),
      DAILY_TOOLING_CHECK_MS
    );
    if (toolingOutdatedTimer.unref) toolingOutdatedTimer.unref();

    tray = new Tray(getTrayIcon());
    applySnapshot(latestSnapshot);

    // Create overlays up front so they're loaded and ready to show instantly,
    // and keep them in sync as displays come and go.
    ensureOverlays();
    watchDisplays();

    monitor = new UsageMonitor();
    monitor.onInitialScanComplete = (snapshot) => {
      claudeSnapshot = snapshot;
      claudeInitialDone = true;
      console.log(
        `MakeItRain: Claude today so far $${snapshot.totalCostUSD.toFixed(2)} (${snapshot.entryCount} entries)`
      );
      onSourceUpdate();
    };
    monitor.onUpdate = (_previousTotal, snapshot) => {
      claudeSnapshot = snapshot;
      onSourceUpdate();
    };
    monitor.start();

    // OpenAI Codex CLI/IDE spend (~/.codex/sessions), folded into the same
    // combined total as Claude Code so the widget and board treat both coding
    // agents together.
    codexMonitor = new CodexMonitor();
    codexMonitor.onInitialScanComplete = (snapshot) => {
      codexSnapshot = snapshot;
      codexInitialDone = true;
      console.log(
        `MakeItRain: Codex today so far $${snapshot.totalCostUSD.toFixed(2)} (${snapshot.entryCount} entries)`
      );
      onSourceUpdate();
    };
    codexMonitor.onUpdate = (snapshot) => {
      codexSnapshot = snapshot;
      onSourceUpdate();
    };
    codexMonitor.start();

    // Cloud daily leaderboard: anonymized tag + today's total, reported every 10 min.
    // Telemetry is ON by default but disclosed and toggleable from the tray menu.
    // MIR_API_BASE_URL=http://localhost:8787 points reports and the "View
    // leaderboard" page at a local server for this process only — it is never
    // written to the persisted config (see `bun run start:all`).
    leaderboard = new LeaderboardClient({
      configDir: app.getPath('userData'),
      getTotal: () => latestSnapshot.totalCostUSD,
      // Today's tool savings (matches the board's per-day spend figure), NOT
      // lifetime — the board is a daily snapshot.
      getSavedUSD: () => daySavings(dayKey(new Date())).total,
      getOptimized: () => TOOL_IDS.every((id) => toolingState[id].installed),
      apiBaseUrlOverride: process.env.MIR_API_BASE_URL,
      onConfigChange: () => {
        if (tray) rebuildTrayMenu();
      },
    });
    leaderboard.start();

    // Update checker: ask npm daily whether a newer version is published and
    // surface an in-tray update path. Fully fail-silent (see lib/update-checker).
    updateChecker = new UpdateChecker({
      currentVersion: app.getVersion(),
      onUpdateAvailable,
    });
    updateChecker.start();

    rebuildTrayMenu();

    // Retroactive spend history (reads existing logs; no database). The
    // periodic force refresh is cheap: it only rescans files touched today.
    history = new History({ cacheTtlMs: HISTORY_REFRESH_MS, analyticsStore });
    refreshHistory();
    const historyTimer = setInterval(
      () => refreshHistory({ force: true }),
      HISTORY_REFRESH_MS
    );
    if (historyTimer.unref) historyTimer.unref();

    // Launch hooks for testing without clicking the menu:
    //   MIR_TEST_RAIN=1  triggers the rain animation after 1.5s
    //   MIR_TEST_SAVE_RAIN=1  triggers the GREEN savings rain after 1.5s
    //   MIR_TEST_STACK=<n>  bursts <n> milestone money stacks after 3s (so the
    //                       4s MIR_TEST_SHOT below catches them mid-fall)
    //   MIR_TEST_SHOT=/path.png  captures the overlay to a PNG a few seconds later
    if (process.env.MIR_TEST_RAIN === '1') {
      setTimeout(() => rainAllDisplays('spend'), 1500);
    }
    if (process.env.MIR_TEST_SAVE_RAIN === '1') {
      setTimeout(() => rainAllDisplays('save'), 1500);
    }
    const stackEnv = process.env.MIR_TEST_STACK;
    if (stackEnv) {
      const n = parseInt(stackEnv, 10) || 1;
      setTimeout(() => stacksFromTray(n, 'spend'), 3000);
    }
    const shotPath = process.env.MIR_TEST_SHOT;
    if (shotPath) {
      setTimeout(async () => {
        try {
          const win = primaryOverlayWin();
          if (!win) throw new Error('no primary overlay window');
          const image = await win.webContents.capturePage();
          fs.writeFileSync(shotPath, image.toPNG());
          console.log(`MakeItRain: overlay screenshot saved to ${shotPath}`);
        } catch (err) {
          console.warn(
            'MakeItRain: overlay screenshot failed:',
            (err as Error).message
          );
        }
      }, 4000);
    }
  });

  // Keep the app alive in the tray after the (hidden) overlay windows close.
  // Electron passes the event at runtime; preventing default stops the quit.
  app.on('window-all-closed', (e?: Electron.Event) => {
    if (e) e.preventDefault();
  });
  app.on('will-quit', () => {
    if (monitor) monitor.stop();
    if (codexMonitor) codexMonitor.stop();
    if (leaderboard) leaderboard.stop();
    if (updateChecker) updateChecker.stop();
  });
}
