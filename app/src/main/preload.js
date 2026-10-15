'use strict';

// Único puente entre la ventana y el proceso principal: funciones concretas, nada de Node.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('notasApp', {
  getState: () => ipcRenderer.invoke('state:get'),
  newPairingCode: () => ipcRenderer.invoke('pairing:new'),
  cancelPairing: () => ipcRenderer.invoke('pairing:cancel'),
  revokeInstance: (id) => ipcRenderer.invoke('instance:revoke', id),
  listNotes: () => ipcRenderer.invoke('notes:list'),
  openNote: (id) => ipcRenderer.invoke('notes:open', id),
  copyNoteUrl: (id) => ipcRenderer.invoke('notes:copy', id),
  deleteNote: (id) => ipcRenderer.invoke('notes:delete', id),
  assignNoteProfile: (id, profileId) => ipcRenderer.invoke('notes:assign', id, profileId),
  listTrash: () => ipcRenderer.invoke('trash:list'),
  restoreNote: (id) => ipcRenderer.invoke('trash:restore', id),
  purgeNote: (id) => ipcRenderer.invoke('trash:purge', id),
  emptyTrash: () => ipcRenderer.invoke('trash:empty'),
  setAccess: (instanceId, ids) => ipcRenderer.invoke('access:set', instanceId, ids),
  chooseSyncKey: () => ipcRenderer.invoke('sync:choose-key'),
  syncNow: () => ipcRenderer.invoke('sync:now'),
  disableSync: () => ipcRenderer.invoke('sync:disable'),
  openDataFolder: () => ipcRenderer.invoke('data:open'),
  onState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('state', handler);
    return () => ipcRenderer.removeListener('state', handler);
  },
});
