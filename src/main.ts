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
import { Config } from './lib/config';
import * as denominations from './lib/denominations';
import { LeaderboardClient } from './lib/leaderboard-client';
import { History, RANGES, billCount } from './lib/history';
import type { Range, RangeResult, DayEntry } from './lib/history';
import { stackCountForCrossing } from './lib/milestones';
import { UpdateChecker, shouldNotify } from './lib/update-checker';

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
}

// ── Globals ─────────────────────────────────────────────────────────────────
let tray: Tray | null = null;
// One overlay window per display, keyed by Electron's display.id.
// Each entry: { win: BrowserWindow, ready: boolean, pending: [{channel, payload}] }
const overlays = new Map<number, OverlayEntry>();
let monitor: UsageMonitor | null = null;
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
};
let initialScanHandled = false;
let history: History | null = null;
// rangeId -> scan result (or 'loading'); drives the "Past spending" submenu.
const historyData = new Map<string, RangeResult | 'loading'>();
const HISTORY_REFRESH_MS = 60_000;

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

/** N × 💰, one per $100 spent (empty string below $100). */
function billStacks(costUSD: number): string {
  return '💰'.repeat(billCount(costUSD));
}

/** Days in a scan whose own spend hit $100 — the "rain days". */
function rainDayCount(days: DayEntry[]): number {
  return days.filter((d) => d.costUSD >= 100).length;
}

/** Builds the label + per-day submenu for one range from its scan result. */
function historyMenuItem(range: Range): MenuItemConstructorOptions {
  const data = historyData.get(range.id);
  if (!data || data === 'loading') {
    return { label: `${range.label}: …`, enabled: false };
  }

  const stacks = billStacks(data.totalCostUSD);
  const rainDays = rainDayCount(data.days);
  let label = `${range.label}: $${data.totalCostUSD.toFixed(2)}`;
  if (stacks) label += ` — ${stacks}`;
  if (rainDays > 0)
    label += ` (${rainDays} rain day${rainDays === 1 ? '' : 's'})`;

  // Per-day breakdown, most recent first, with 💰 per $100 that day.
  const dayItems: MenuItemConstructorOptions[] = [...data.days]
    .reverse()
    .map((d) => {
      const s = billStacks(d.costUSD);
      return {
        label: `${d.date}: $${d.costUSD.toFixed(2)}${s ? '  ' + s : ''}`,
        enabled: false,
      };
    });
  const submenu: MenuItemConstructorOptions[] = dayItems.length
    ? dayItems
    : [{ label: 'No spend in this range', enabled: false }];

  return { label, submenu };
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

  template.push(
    { label: `Today: $${s.totalCostUSD.toFixed(2)}`, enabled: false },
    {
      label: `Tokens today: ${s.inputTokens} in / ${s.outputTokens} out`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'See your wealth',
      submenu: [
        { label: denominations.format(s.totalCostUSD), enabled: false },
        { type: 'separator' },
        { label: '💰 = $100   💵 = $1   🪙 = 1¢', enabled: false },
      ],
    },
    { label: 'Past spending', submenu: RANGES.map(historyMenuItem) }
  );

  if (leaderboard) {
    const lb = leaderboard;
    template.push(
      { type: 'separator' },
      { label: `Leaderboard tag: ${lb.gamerTag}`, enabled: false },
      {
        label: 'Share on daily leaderboard',
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
      { label: 'View leaderboard…', click: () => openLeaderboardPage() }
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Test animations',
      submenu: [
        { label: 'Stack of Money — $10', click: () => stacksFromTray(1) },
        { label: 'Five Stacks — $50', click: () => stacksFromTray(5) },
        { label: 'Make It Rain — $100', click: () => rainAllDisplays() },
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
    shell.openExternal(base + '/');
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
  const args = ['install', '-g', `${UPDATE_PACKAGE}@latest`];
  execFile('npm', args, { timeout: 5 * 60 * 1000 }, (err) => {
    updateInProgress = false;
    if (err) {
      notify('Make It Rain', 'Update failed — opening the releases page.');
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
    notify('Make It Rain', `Updated to v${target} — quit and restart to apply`);
    rebuildTrayMenu();
  });
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
    tray.setToolTip(
      `Make It Rain — today: $${snapshot.totalCostUSD.toFixed(2)}`
    );
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

  const entry: OverlayEntry = { win, ready: false, pending: [] };
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
  for (const { channel, payload } of entry.pending) {
    entry.win.webContents.send(channel, payload);
  }
  entry.pending = [];
}

// Rain plays everywhere, but the coin shimmer plays only on the primary
// display — otherwise every overlay would layer the same sound simultaneously.
function rainAllDisplays(): void {
  ensureOverlays();
  const primaryId = screen.getPrimaryDisplay().id;
  for (const [displayId, entry] of overlays.entries()) {
    queueToOverlay(entry, 'rain', { sound: displayId === primaryId });
  }
}

// Resolve the overlay entry for the display containing the tray anchor, plus
// the anchor converted to that display's local coordinate space. Tray-anchored
// animations (dollar-fly, milestone stacks) play only on that display.
function trayDisplayTarget(): { entry: OverlayEntry; anchor: Rectangle } {
  ensureOverlays();
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
function flyBillsFromTray(count: number): void {
  const { entry, anchor } = trayDisplayTarget();
  queueToOverlay(entry, 'fly-bills', { count, anchor });
}

// Milestone stacks ($10/$50) burst from the tray anchor on its display.
function stacksFromTray(count: number): void {
  const { entry, anchor } = trayDisplayTarget();
  queueToOverlay(entry, 'stack', { count, anchor });
}

// A renderer reports it went idle; hide only that window (if nothing's queued).
ipcMain.on('overlay-idle', (event: IpcMainEvent) => {
  for (const entry of overlays.values()) {
    if (entry.win.webContents === event.sender) {
      if (entry.pending.length === 0) entry.win.hide();
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
function handleUpdate(previousTotal: number, snapshot: Snapshot): void {
  applySnapshot(snapshot);

  const newTotal = snapshot.totalCostUSD;

  // The very first onUpdate after start() is the initial scan: it jumps from $0
  // to today's already-accumulated total. We suppress the new milestone stacks
  // there so launching the app never replays the whole day's big celebrations.
  // (Per-dollar fly-bills and the $100 rain keep their prior behavior unchanged.)
  const isInitialScan = !initialScanHandled;
  initialScanHandled = true;

  // Dollar-fly: number of whole-dollar boundaries crossed since the last update.
  const dollarsGained = Math.floor(newTotal) - Math.floor(previousTotal);
  if (dollarsGained > 0) {
    flyBillsFromTray(dollarsGained);
  }

  // Milestone stacks ($10 → one 10-bill stack, $50 → five): fire the first
  // time today's total crosses the threshold. The thresholds/counts and the
  // crossing rules (midnight reset for free, highest-only on multi-cross)
  // live in lib/milestones.ts. Skipped on the initial scan (see above).
  if (!isInitialScan) {
    const stackCount = stackCountForCrossing(previousTotal, newTotal);
    if (stackCount > 0) {
      stacksFromTray(stackCount);
    }
  }

  // $100-rain: trigger if we crossed at least one multiple of 100.
  const previousHundreds = Math.floor(previousTotal / 100);
  const newHundreds = Math.floor(newTotal / 100);
  if (newHundreds > previousHundreds && newTotal >= 100) {
    rainAllDisplays();
  }
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

    tray = new Tray(getTrayIcon());
    applySnapshot(latestSnapshot);

    // Create overlays up front so they're loaded and ready to show instantly,
    // and keep them in sync as displays come and go.
    ensureOverlays();
    watchDisplays();

    monitor = new UsageMonitor();
    monitor.onInitialScanComplete = (snapshot) => {
      console.log(
        `MakeItRain: today so far $${snapshot.totalCostUSD.toFixed(2)} (${snapshot.entryCount} entries)`
      );
    };
    monitor.onUpdate = (previousTotal, snapshot) =>
      handleUpdate(previousTotal, snapshot);
    monitor.start();

    // Cloud daily leaderboard: anonymized tag + today's total, reported hourly.
    // Telemetry is ON by default but disclosed and toggleable from the tray menu.
    // MIR_API_BASE_URL=http://localhost:8787 points reports and the "View
    // leaderboard" page at a local server for this process only — it is never
    // written to the persisted config (see `bun run start:all`).
    leaderboard = new LeaderboardClient({
      configDir: app.getPath('userData'),
      getTotal: () => latestSnapshot.totalCostUSD,
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
    history = new History({ cacheTtlMs: HISTORY_REFRESH_MS });
    refreshHistory();
    const historyTimer = setInterval(
      () => refreshHistory({ force: true }),
      HISTORY_REFRESH_MS
    );
    if (historyTimer.unref) historyTimer.unref();

    // Launch hooks for testing without clicking the menu:
    //   MIR_TEST_RAIN=1  triggers the rain animation after 1.5s
    //   MIR_TEST_STACK=<n>  bursts <n> milestone money stacks after 3s (so the
    //                       4s MIR_TEST_SHOT below catches them mid-fall)
    //   MIR_TEST_SHOT=/path.png  captures the overlay to a PNG a few seconds later
    if (process.env.MIR_TEST_RAIN === '1') {
      setTimeout(() => rainAllDisplays(), 1500);
    }
    const stackEnv = process.env.MIR_TEST_STACK;
    if (stackEnv) {
      const n = parseInt(stackEnv, 10) || 1;
      setTimeout(() => stacksFromTray(n), 3000);
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
    if (leaderboard) leaderboard.stop();
    if (updateChecker) updateChecker.stop();
  });
}
