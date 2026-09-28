'use strict';
// P18 — the only bridge between pages and the main process: exactly the IPC contract, nothing else.
// (main.cjs additionally refuses settings:* from anything but the app's own file:// pages.)
const { contextBridge, ipcRenderer } = require('electron');

const arg = (process.argv || []).find((a) => a.startsWith('--alfred-version='));

contextBridge.exposeInMainWorld('alfredNative', {
  version: arg ? arg.slice('--alfred-version='.length) : '',
  isApp: true,
  quickSubmit: (text) => ipcRenderer.invoke('quick:submit', String(text ?? '')),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  testConnection: (s) => ipcRenderer.invoke('settings:test', s),
});
