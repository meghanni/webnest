const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('webnest', Object.freeze({
  getState: () => ipcRenderer.invoke('get-state'),
  addApp: (data) => ipcRenderer.invoke('add-app', data),
  updateApp: (id, data) => ipcRenderer.invoke('update-app', id, data),
  removeApp: (id) => ipcRenderer.invoke('remove-app', id),
  setAppTray: (id, enabled) => ipcRenderer.invoke('set-app-tray', id, enabled),
  fetchIcon: (url) => ipcRenderer.invoke('fetch-icon', url),
  openApp: (id) => ipcRenderer.invoke('open-app', id),
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  exportConfig: () => ipcRenderer.invoke('export-config'),
  importConfig: () => ipcRenderer.invoke('import-config'),
  onState: (callback) => ipcRenderer.on('state', (_event, state) => callback(state))
}));
