'use strict';

const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('path');
const { UsageMonitor } = require('./lib/usage-monitor');
const { LeaderboardClient } = require('./lib/leaderboard-client');

// ── Globals ─────────────────────────────────────────────────────────────────
let tray = null;
let overlay = null;
let overlayReady = false;
let pendingOverlayMessages = [];
let monitor = null;
let leaderboard = null;
let latestSnapshot = { totalCostUSD: 0, inputTokens: 0, outputTokens: 0, entryCount: 0 };

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
  const template = [
    { label: `Today: $${s.totalCostUSD.toFixed(2)}`, enabled: false },
    { label: `Tokens today: ${s.inputTokens} in / ${s.outputTokens} out`, enabled: false },
    { type: 'separator' },
    { label: 'Make It Rain (test)', click: () => sendToOverlay('rain') },
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

  template.push({ label: 'Quit', click: () => app.quit() });
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function openLeaderboardPage() {
  try {
    const base = leaderboard.config.apiBaseUrl.replace(/\/+$/, '');
    shell.openExternal(base + '/');
  } catch { /* ignore — opening the page is best-effort */ }
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

    // Cloud daily leaderboard: anonymized tag + today's total, reported hourly.
    // Telemetry is ON by default but disclosed and toggleable from the tray menu.
    leaderboard = new LeaderboardClient({
      configDir: app.getPath('userData'),
      getTotal: () => latestSnapshot.totalCostUSD,
      onConfigChange: () => { if (tray) rebuildTrayMenu(); },
    });
    leaderboard.start();
    rebuildTrayMenu();

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
  app.on('will-quit', () => {
    if (monitor) monitor.stop();
    if (leaderboard) leaderboard.stop();
  });
}
