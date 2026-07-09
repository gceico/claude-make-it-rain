const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  onFlyBills: (fn) => ipcRenderer.on('fly-bills', (_e, payload) => fn(payload)),
  onStack: (fn) => ipcRenderer.on('stack', (_e, payload) => fn(payload)),
  onRain: (fn) => ipcRenderer.on('rain', (_e, payload) => fn(payload)),
  onSetMuted: (fn) => ipcRenderer.on('set-muted', (_e, muted) => fn(!!muted)),
  overlayIdle: () => ipcRenderer.send('overlay-idle'),
});
