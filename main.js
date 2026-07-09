'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen } = require('electron');
const path = require('path');
const { UsageMonitor } = require('./lib/usage-monitor');
const { History, RANGES, billCount } = require('./lib/history');

// ── Globals ─────────────────────────────────────────────────────────────────
let tray = null;
let overlay = null;
let overlayReady = false;
let pendingOverlayMessages = [];
let monitor = null;
let latestSnapshot = { totalCostUSD: 0, inputTokens: 0, outputTokens: 0, entryCount: 0 };
let history = null;
// rangeId -> scan result (or 'loading'); drives the "Past spending" submenu.
const historyData = new Map();
const HISTORY_REFRESH_MS = 60_000;

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
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Today: $${s.totalCostUSD.toFixed(2)}`, enabled: false },
      { label: `Tokens today: ${s.inputTokens} in / ${s.outputTokens} out`, enabled: false },
      { type: 'separator' },
      { label: 'Past spending', submenu: RANGES.map(historyMenuItem) },
      { type: 'separator' },
      { label: 'Make It Rain (test)', click: () => sendToOverlay('rain') },
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

  // Dollar-fly: number of whole-dollar boundaries crossed since the last update.
  const dollarsGained = Math.floor(newTotal) - Math.floor(previousTotal);
  if (dollarsGained > 0) {
    sendToOverlay('fly-bills', { count: dollarsGained, anchor: overlayAnchorFromTray() });
  }

  // $100-rain: trigger if we crossed at least one multiple of 100.
  const previousHundreds = Math.floor(previousTotal / 100);
  const newHundreds = Math.floor(newTotal / 100);
  if (newHundreds > previousHundreds && newTotal >= 100) {
    sendToOverlay('rain');
  }
}

// ── Past-spending history ─────────────────────────────────────────────────────
/** Lazily (re)scan every range in the background and refresh the menu as each
 *  result lands. Cheap when cached; never blocks the tray. */
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
        sendToOverlay('fly-bills', { count: bills, anchor: overlayAnchorFromTray() });
        sendToOverlay('rain');
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

    // Retroactive spend history (reads existing logs; no database).
    history = new History({ cacheTtlMs: HISTORY_REFRESH_MS });
    refreshHistory();
    const historyTimer = setInterval(() => refreshHistory({ force: true }), HISTORY_REFRESH_MS);
    if (historyTimer.unref) historyTimer.unref();

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
