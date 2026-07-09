'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const { UsageMonitor } = require('./lib/usage-monitor');

// ── Globals ─────────────────────────────────────────────────────────────────
let tray = null;
// One overlay window per display, keyed by Electron's display.id.
// Each entry: { win: BrowserWindow, ready: boolean, pending: [{channel, payload}] }
let overlays = new Map();
let monitor = null;
let latestSnapshot = { totalCostUSD: 0, inputTokens: 0, outputTokens: 0, entryCount: 0 };
let initialScanHandled = false;

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

function rebuildTrayMenu() {
  const s = latestSnapshot;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Today: $${s.totalCostUSD.toFixed(2)}`, enabled: false },
      { label: `Tokens today: ${s.inputTokens} in / ${s.outputTokens} out`, enabled: false },
      { type: 'separator' },
      { label: 'Stack of Money — $10 (test)', click: () => stacksFromTray(1) },
      { label: 'A Few Stacks — $50 (test)', click: () => stacksFromTray(3) },
      { label: 'Make It Rain — $100 (test)', click: () => rainAllDisplays() },
      { label: 'Quit', click: () => app.quit() },
    ])
  );
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
    },
  });
  makeOverlayFloat(win);

  const entry = { win, ready: false, pending: [] };
  overlays.set(display.id, entry);

  win.loadFile('overlay.html');
  win.webContents.on('did-finish-load', () => {
    entry.ready = true;
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

// Rain plays everywhere.
function rainAllDisplays() {
  ensureOverlays();
  for (const entry of overlays.values()) queueToOverlay(entry, 'rain');
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

// ── App lifecycle ───────────────────────────────────────────────────────────
if (!app.requestSingleInstanceLock()) {
  console.log('MakeItRain: already running, exiting.');
  app.quit();
} else {
  app.whenReady().then(() => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

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
  app.on('will-quit', () => { if (monitor) monitor.stop(); });
}
