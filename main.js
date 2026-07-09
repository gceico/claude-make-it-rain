'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const { UsageMonitor } = require('./lib/usage-monitor');
const { Config } = require('./lib/config');
const denominations = require('./lib/denominations');
const { LeaderboardClient } = require('./lib/leaderboard-client');
const { History, RANGES, billCount } = require('./lib/history');

// ── Globals ─────────────────────────────────────────────────────────────────
let tray = null;
// One overlay window per display, keyed by Electron's display.id.
// Each entry: { win: BrowserWindow, ready: boolean, pending: [{channel, payload}] }
let overlays = new Map();
let monitor = null;
let config = null;
let leaderboard = null;
let latestSnapshot = { totalCostUSD: 0, inputTokens: 0, outputTokens: 0, entryCount: 0 };
let initialScanHandled = false;
let history = null;
// rangeId -> scan result (or 'loading'); drives the "Past spending" submenu.
const historyData = new Map();
const HISTORY_REFRESH_MS = 60_000;

// First-time-today spend milestones that earn a "stack of money" burst.
// $100 is intentionally NOT here — it keeps the existing full-screen rain below.
// Ordered ascending so we can fire only the highest one crossed in a single update.
const STACK_MILESTONES = [
  { threshold: 10, count: 1 },  // $10: a single stack bursts from the tray.
  { threshold: 50, count: 3 },  // $50: a few stacks.
];

// 16x16 green square fallback for platforms without tray title text (win/linux).
const FALLBACK_ICON_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGPQ2xHznxLMMGrAqAGjBgwXAwBFLUEfBSikAwAAAABJRU5ErkJggg==';

function getTrayIcon() {
  if (process.platform === 'darwin') {
    // The dollar amount lives in the tray title; no icon needed.
    return nativeImage.createEmpty();
  }
  return nativeImage.createFromDataURL('data:image/png;base64,' + FALLBACK_ICON_B64);
}

// ── Tray ────────────────────────────────────────────────────────────────────
function formatTitle(total) {
  const emoji = total >= 100 ? '🤑' : '💸';
  return `${emoji} $${total.toFixed(2)}`;
}

/** N × 💰, one per $100 spent (empty string below $100). */
function billStacks(costUSD) {
  return '💰'.repeat(billCount(costUSD));
}

/** Days in a scan whose own spend hit $100 — the "rain days". */
function rainDayCount(days) {
  return days.filter((d) => d.costUSD >= 100).length;
}

/** Builds the label + per-day submenu for one range from its scan result. */
function historyMenuItem(range) {
  const data = historyData.get(range.id);
  if (!data || data === 'loading') {
    return { label: `${range.label}: …`, enabled: false };
  }

  const stacks = billStacks(data.totalCostUSD);
  const rainDays = rainDayCount(data.days);
  let label = `${range.label}: $${data.totalCostUSD.toFixed(2)}`;
  if (stacks) label += ` — ${stacks}`;
  if (rainDays > 0) label += ` (${rainDays} rain day${rainDays === 1 ? '' : 's'})`;

  // Per-day breakdown, most recent first, with 💰 per $100 that day.
  const dayItems = [...data.days]
    .reverse()
    .map((d) => {
      const s = billStacks(d.costUSD);
      return {
        label: `${d.date}: $${d.costUSD.toFixed(2)}${s ? '  ' + s : ''}`,
        enabled: false,
      };
    });
  const submenu = dayItems.length
    ? [...dayItems, { type: 'separator' }, { label: 'Make it rain 💸', click: () => makeItRainFor(range.id) }]
    : [{ label: 'No spend in this range', enabled: false }];

  return { label, submenu };
}

function rebuildTrayMenu() {
  const s = latestSnapshot;
  const muted = config ? !!config.get('muted') : false;
  const template = [
    { label: `Today: $${s.totalCostUSD.toFixed(2)}`, enabled: false },
    { label: `Tokens today: ${s.inputTokens} in / ${s.outputTokens} out`, enabled: false },
    { type: 'separator' },
    {
      label: 'See your wealth',
      submenu: [
        { label: denominations.format(s.totalCostUSD), enabled: false },
        { type: 'separator' },
        { label: '💰 = $100   💵 = $1   🪙 = 1¢', enabled: false },
      ],
    },
    { label: 'Past spending', submenu: RANGES.map(historyMenuItem) },
  ];

  if (leaderboard) {
    template.push(
      { type: 'separator' },
      { label: `Leaderboard tag: ${leaderboard.gamerTag}`, enabled: false },
      {
        label: 'Share on daily leaderboard',
        type: 'checkbox',
        checked: leaderboard.telemetryEnabled,
        click: (item) => {
          leaderboard.setTelemetryEnabled(item.checked);
          if (item.checked) leaderboard.reportNow();
          rebuildTrayMenu();
        },
      },
      { label: 'New random tag', click: () => { leaderboard.regenerateTag(); rebuildTrayMenu(); } },
      { label: 'View leaderboard…', click: () => openLeaderboardPage() },
    );
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Test animations',
      submenu: [
        { label: 'Stack of Money — $10', click: () => stacksFromTray(1) },
        { label: 'A Few Stacks — $50', click: () => stacksFromTray(3) },
        { label: 'Make It Rain — $100', click: () => rainAllDisplays() },
      ],
    },
    { label: 'Mute sounds', type: 'checkbox', checked: muted, click: (item) => setMuted(item.checked) },
    { label: 'Quit', click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function openLeaderboardPage() {
  try {
    const base = leaderboard.config.apiBaseUrl.replace(/\/+$/, '');
    shell.openExternal(base + '/');
  } catch { /* ignore — opening the page is best-effort */ }
}

function setMuted(muted) {
  if (config) config.set('muted', muted);
  // Update every loaded overlay directly (bypassing queueToOverlay) so
  // toggling mute never shows a hidden overlay window just to sync a flag.
  for (const entry of overlays.values()) {
    if (entry.ready) entry.win.webContents.send('set-muted', muted);
  }
  rebuildTrayMenu();
}

function applySnapshot(snapshot) {
  latestSnapshot = snapshot;
  if (process.platform === 'darwin') {
    tray.setTitle(formatTitle(snapshot.totalCostUSD));
  }
  tray.setToolTip(`Make It Rain — today: $${snapshot.totalCostUSD.toFixed(2)}`);
  rebuildTrayMenu();
}

/** Screen-coordinate anchor for the dollar-fly animation (the tray item). */
function trayAnchor() {
  try {
    const b = tray.getBounds();
    if (b && b.width > 0) return b;
  } catch { /* tray bounds unavailable on some platforms */ }
  // Fallback: top-right corner of the primary display.
  const { bounds } = screen.getPrimaryDisplay();
  return { x: bounds.x + bounds.width - 40, y: bounds.y, width: 20, height: 22 };
}

// ── Overlay windows (one per display) ───────────────────────────────────────
// Marks the window so it floats above everything — including full-screen apps
// and other Spaces — and never steals focus or clicks.
function makeOverlayFloat(win) {
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
function createOverlayForDisplay(display) {
  const existing = overlays.get(display.id);
  if (existing) return existing;

  const { bounds } = display;
  const win = new BrowserWindow({
    x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      // The overlay is non-focusable and never receives a user gesture, so the
      // default autoplay policy would leave its AudioContext suspended. Allow
      // sound without a gesture (the renderer also resumes defensively).
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  makeOverlayFloat(win);

  const entry = { win, ready: false, pending: [] };
  overlays.set(display.id, entry);

  win.loadFile('overlay.html');
  win.webContents.on('did-finish-load', () => {
    entry.ready = true;
    // Sync the persisted mute preference every time this overlay (re)loads.
    win.webContents.send('set-muted', config ? !!config.get('muted') : false);
    flushOverlay(entry);
  });
  win.on('closed', () => { overlays.delete(display.id); });
  return entry;
}

// Ensure every current display has an overlay window.
function ensureOverlays() {
  for (const display of screen.getAllDisplays()) createOverlayForDisplay(display);
}

// The overlay covering the primary display (used by the test screenshot hook).
function primaryOverlayWin() {
  const entry = overlays.get(screen.getPrimaryDisplay().id);
  return entry ? entry.win : null;
}

// Queue a message for one overlay, flushing immediately if it's ready.
function queueToOverlay(entry, channel, payload) {
  entry.pending.push({ channel, payload });
  if (entry.ready) flushOverlay(entry);
}

function flushOverlay(entry) {
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
function rainAllDisplays() {
  ensureOverlays();
  const primaryId = screen.getPrimaryDisplay().id;
  for (const [displayId, entry] of overlays.entries()) {
    queueToOverlay(entry, 'rain', { sound: displayId === primaryId });
  }
}

// Resolve the overlay entry for the display containing the tray anchor, plus
// the anchor converted to that display's local coordinate space. Tray-anchored
// animations (dollar-fly, milestone stacks) play only on that display.
function trayDisplayTarget() {
  ensureOverlays();
  const a = trayAnchor();
  const center = {
    x: a.x + Math.floor(a.width / 2),
    y: a.y + Math.floor(a.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center);
  const entry = createOverlayForDisplay(display);
  const { bounds } = display;
  const anchor = { x: a.x - bounds.x, y: a.y - bounds.y, width: a.width, height: a.height };
  return { entry, anchor };
}

// Dollar-fly plays on whichever display holds the tray anchor.
function flyBillsFromTray(count) {
  const { entry, anchor } = trayDisplayTarget();
  queueToOverlay(entry, 'fly-bills', { count, anchor });
}

// Milestone stacks ($10/$50) burst from the tray anchor on its display.
function stacksFromTray(count) {
  const { entry, anchor } = trayDisplayTarget();
  queueToOverlay(entry, 'stack', { count, anchor });
}

// A renderer reports it went idle; hide only that window (if nothing's queued).
ipcMain.on('overlay-idle', (event) => {
  for (const entry of overlays.values()) {
    if (entry.win.webContents === event.sender) {
      if (entry.pending.length === 0) entry.win.hide();
      break;
    }
  }
});

// Keep overlays in sync with the physical display layout.
function watchDisplays() {
  screen.on('display-added', (_e, display) => createOverlayForDisplay(display));
  screen.on('display-removed', (_e, display) => {
    const entry = overlays.get(display.id);
    if (entry) { entry.win.destroy(); overlays.delete(display.id); }
  });
  screen.on('display-metrics-changed', (_e, display) => {
    const entry = overlays.get(display.id);
    if (entry) entry.win.setBounds(display.bounds);
  });
}

// ── Monitor wiring ──────────────────────────────────────────────────────────
function handleUpdate(previousTotal, snapshot) {
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

  // Milestone stacks ($10, $50): fire the first time today's total crosses the
  // threshold (previousTotal < M <= newTotal). Deriving from the crossing means
  // the flags reset for free at midnight — the monitor resets its total to $0,
  // so the next day's climb crosses each threshold afresh. If several are crossed
  // in one update, fire only the highest to avoid stacking bursts on top of each
  // other. Skipped on the initial scan (see above).
  if (!isInitialScan) {
    let stackCount = 0;
    for (const m of STACK_MILESTONES) {
      if (previousTotal < m.threshold && newTotal >= m.threshold) stackCount = m.count;
    }
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
function refreshHistory({ force = false } = {}) {
  if (!history) return;
  for (const range of RANGES) {
    if (!historyData.has(range.id)) historyData.set(range.id, 'loading');
    history
      .get(range.id, { force })
      .then((data) => {
        historyData.set(range.id, data);
        rebuildTrayMenu();
      })
      .catch((err) => {
        console.warn(`MakeItRain: history scan for ${range.id} failed:`, err.message);
      });
  }
}

/** Make-it-rain for a past range: one $100 downpour if it hit any bill stack. */
function makeItRainFor(rangeId) {
  if (!history) return;
  history
    .get(rangeId, { force: true })
    .then((data) => {
      historyData.set(rangeId, data);
      rebuildTrayMenu();
      const bills = billCount(data.totalCostUSD);
      if (bills > 0) {
        flyBillsFromTray(bills);
        rainAllDisplays();
      }
    })
    .catch((err) => {
      console.warn(`MakeItRain: make-it-rain scan for ${rangeId} failed:`, err.message);
    });
}

// ── App lifecycle ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  console.log('MakeItRain: already running, exiting.');
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

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
    monitor.onUpdate = (previousTotal, snapshot) => handleUpdate(previousTotal, snapshot);
    monitor.start();

    // Cloud daily leaderboard: anonymized tag + today's total, reported hourly.
    // Telemetry is ON by default but disclosed and toggleable from the tray menu.
    leaderboard = new LeaderboardClient({
      configDir: app.getPath('userData'),
      getTotal: () => latestSnapshot.totalCostUSD,
      onConfigChange: () => { if (tray) rebuildTrayMenu(); },
    });
    leaderboard.start();
    rebuildTrayMenu();

    // Retroactive spend history (reads existing logs; no database). The
    // periodic force refresh is cheap: it only rescans files touched today.
    history = new History({ cacheTtlMs: HISTORY_REFRESH_MS });
    refreshHistory();
    const historyTimer = setInterval(() => refreshHistory({ force: true }), HISTORY_REFRESH_MS);
    if (historyTimer.unref) historyTimer.unref();

    // Launch hooks for testing without clicking the menu:
    //   MIR_TEST_RAIN=1  triggers the rain animation after 1.5s
    //   MIR_TEST_SHOT=/path.png  captures the overlay to a PNG a few seconds later
    if (process.env.MIR_TEST_RAIN === '1') {
      setTimeout(() => rainAllDisplays(), 1500);
    }
    if (process.env.MIR_TEST_SHOT) {
      setTimeout(async () => {
        try {
          const win = primaryOverlayWin();
          if (!win) throw new Error('no primary overlay window');
          const image = await win.webContents.capturePage();
          require('fs').writeFileSync(process.env.MIR_TEST_SHOT, image.toPNG());
          console.log(`MakeItRain: overlay screenshot saved to ${process.env.MIR_TEST_SHOT}`);
        } catch (err) {
          console.warn('MakeItRain: overlay screenshot failed:', err.message);
        }
      }, 4000);
    }
  });

  app.on('window-all-closed', (e) => e.preventDefault()); // keep alive in tray
  app.on('will-quit', () => {
    if (monitor) monitor.stop();
    if (leaderboard) leaderboard.stop();
  });
}
