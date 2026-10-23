const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webnestTabs', Object.freeze({
  onState: (callback) => ipcRenderer.on('app-tabs-state', (_event, state) => callback(state)),
  select: (tabId) => ipcRenderer.invoke('app-tab-select', tabId),
  close: (tabId) => ipcRenderer.invoke('app-tab-close', tabId),
  create: () => ipcRenderer.invoke('app-tab-new')
}));
