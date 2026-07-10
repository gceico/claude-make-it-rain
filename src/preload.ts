'use strict';

// Preload for the transparent overlay renderer. Exposes a tiny, typed bridge on
// window.bridge so the renderer can subscribe to animation IPC messages and
// report going idle — without any direct access to Node or the full ipcRenderer.
// Built as a standalone CJS file (dist/preload.js) that Electron loads.

import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bridge', {
  onFlyBills: (fn: (payload: unknown) => void) =>
    ipcRenderer.on('fly-bills', (_e, payload) => fn(payload)),
  onStack: (fn: (payload: unknown) => void) =>
    ipcRenderer.on('stack', (_e, payload) => fn(payload)),
  onRain: (fn: (payload: unknown) => void) =>
    ipcRenderer.on('rain', (_e, payload) => fn(payload)),
  onSetMuted: (fn: (muted: boolean) => void) =>
    ipcRenderer.on('set-muted', (_e, muted) => fn(!!muted)),
  overlayIdle: () => ipcRenderer.send('overlay-idle'),
});
