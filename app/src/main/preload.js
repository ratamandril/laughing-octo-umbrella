'use strict';

// Único puente entre la ventana y el proceso principal: funciones concretas, nada de Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notasApp', {
  getState: () => ipcRenderer.invoke('state:get'),
  newPairingCode: () => ipcRenderer.invoke('pairing:new'),
  cancelPairing: () => ipcRenderer.invoke('pairing:cancel'),
  revokeInstance: (id) => ipcRenderer.invoke('instance:revoke', id),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
