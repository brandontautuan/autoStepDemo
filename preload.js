const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('observer', {
  start: (interval) => ipcRenderer.invoke('observer:start', interval),
  stop: () => ipcRenderer.invoke('observer:stop'),
  capture: () => ipcRenderer.invoke('observer:capture'),
  state: () => ipcRenderer.invoke('observer:state'),
  openData: () => ipcRenderer.invoke('observer:open-data'),
  openAccessibility: () => ipcRenderer.invoke('observer:open-accessibility'),
  onSnapshot: (callback) => ipcRenderer.on('snapshot-updated', (_, snapshot) => callback(snapshot))
});
