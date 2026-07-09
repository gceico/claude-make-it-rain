'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const { UsageMonitor } = require('./lib/usage-monitor');

// ── Globals ─────────────────────────────────────────────────────────────────
let tray = null;
let overlay = null;
let overlayReady = false;
let pendingOverlayMessages = [];
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
      { label: 'Stack of Money — $10 (test)', click: () => sendToOverlay('stack', { count: 1, anchor: overlayAnchorFromTray() }) },
      { label: 'A Few Stacks — $50 (test)', click: () => sendToOverlay('stack', { count: 3, anchor: overlayAnchorFromTray() }) },
      { label: 'Make It Rain — $100 (test)', click: () => sendToOverlay('rain') },
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

// ── Overlay window ──────────────────────────────────────────────────────────
function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlay = new BrowserWindow({
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
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  if (process.platform === 'darwin') {
    overlay.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  }
  overlayReady = false;
  overlay.loadFile('overlay.html');
  overlay.webContents.on('did-finish-load', () => {
    overlayReady = true;
    flushOverlayMessages();
  });
  overlay.on('closed', () => {
    overlay = null;
    overlayReady = false;
    pendingOverlayMessages = [];
  });
}

function sendToOverlay(channel, payload) {
  if (!overlay) createOverlay();
  pendingOverlayMessages.push({ channel, payload });
  if (overlayReady) flushOverlayMessages();
}

function flushOverlayMessages() {
  if (!overlay || !overlayReady) return;
  if (!overlay.isVisible()) overlay.showInactive();
  for (const { channel, payload } of pendingOverlayMessages) {
    overlay.webContents.send(channel, payload);
  }
  pendingOverlayMessages = [];
}

ipcMain.on('overlay-idle', () => {
  if (overlay && pendingOverlayMessages.length === 0) overlay.hide();
});

// ── Monitor wiring ──────────────────────────────────────────────────────────
function overlayAnchorFromTray() {
  // Convert global screen coords to overlay-window-local coords.
  const { bounds } = screen.getPrimaryDisplay();
  const a = trayAnchor();
  return { x: a.x - bounds.x, y: a.y - bounds.y, width: a.width, height: a.height };
}

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
    sendToOverlay('fly-bills', { count: dollarsGained, anchor: overlayAnchorFromTray() });
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
      sendToOverlay('stack', { count: stackCount, anchor: overlayAnchorFromTray() });
    }
  }

  // $100-rain: trigger if we crossed at least one multiple of 100.
  const previousHundreds = Math.floor(previousTotal / 100);
  const newHundreds = Math.floor(newTotal / 100);
  if (newHundreds > previousHundreds && newTotal >= 100) {
    sendToOverlay('rain');
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
      setTimeout(() => sendToOverlay('rain'), 1500);
    }
    if (process.env.MIR_TEST_SHOT) {
      setTimeout(async () => {
        try {
          const image = await overlay.webContents.capturePage();
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
