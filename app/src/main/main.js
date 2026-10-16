'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog, clipboard } = require('electron');
const { createCore } = require('../core');

// Una sola copia a la vez: dos servidores se pelearían por el puerto y por los archivos de datos
if (!app.requestSingleInstanceLock()) app.quit();

const iconPath = path.join(__dirname, '..', '..', 'assets', 'icon.png');
let core = null;
let win = null;
let tray = null;
let quitting = false;

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 780,
    height: 760,
    minWidth: 560,
    minHeight: 520,
    show: false,
    title: 'Notas por URL',
    icon: iconPath,
    backgroundColor: '#faf9f5',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Cerrar la ventana no detiene el servidor: se oculta en la bandeja. Para salir: menú de la bandeja.
  win.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
}

const trayImages = {};
function trayImage(name) {
  if (!trayImages[name]) {
    trayImages[name] = nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', `tray-${name}.png`)).resize({ width: 16, height: 16 });
  }
  return trayImages[name];
}

// Ícono y texto de la bandeja según el estado de la copia en la nube
function trayLook(sync) {
  switch (sync.state) {
    case 'online':
      return sync.pending ? ['warn', `Notas por URL — subiendo ${sync.pending} cambio(s) a la nube`] : ['ok', 'Notas por URL — todo a salvo en la nube'];
    case 'offline':
      return ['bad', `Notas por URL — sin internet${sync.pending ? ` · ${sync.pending} cambio(s) sin subir` : ''}`];
    case 'connecting':
      return ['warn', 'Notas por URL — conectando con la nube…'];
    default:
      return ['off', 'Notas por URL — nube sin configurar (solo en este equipo)'];
  }
}

let lastTray = '';
function updateTray(state) {
  if (!tray || !state) return;
  const [name, tip] = trayLook(state.sync);
  if (name + tip === lastTray) return;
  lastTray = name + tip;
  tray.setImage(trayImage(name));
  tray.setToolTip(tip);
}

function createTray() {
  tray = new Tray(trayImage('off'));
  tray.setToolTip('Notas por URL — servidor local');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar', click: showWindow },
      { type: 'separator' },
      { label: 'Salir', click: () => app.quit() },
    ]),
  );
  tray.on('click', showWindow);
}

// Reenvía el estado a la ventana cuando algo cambia (sin más de ~5 envíos por segundo)
function watchState() {
  let timer = null;
  core.events.on('change', () => {
    if (timer) return;
    timer = setTimeout(async () => {
      timer = null;
      const state = await core.state();
      updateTray(state);
      if (win && !win.isDestroyed()) win.webContents.send('state', state);
    }, 200);
  });
}

function registerIpc() {
  ipcMain.handle('state:get', () => core.state());
  ipcMain.handle('pairing:new', () => core.newPairingCode());
  ipcMain.handle('pairing:cancel', () => core.auth.cancelPairing());
  ipcMain.handle('instance:revoke', (_event, id) => (typeof id === 'string' ? core.revokeInstance(id) : false));
  ipcMain.handle('data:open', () => shell.openPath(core.dataDir));

  // La clave se lee aquí, en el proceso principal: la ventana nunca la ve.
  ipcMain.handle('sync:choose-key', async () => {
    const pick = await dialog.showOpenDialog(win, {
      title: 'Clave de la cuenta de servicio (JSON)',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (pick.canceled || !pick.filePaths[0]) return { ok: false, canceled: true };
    let text;
    try {
      const stat = fs.statSync(pick.filePaths[0]);
      if (stat.size > 64 * 1024) return { ok: false, error: 'El archivo es demasiado grande para ser una clave.' };
      text = fs.readFileSync(pick.filePaths[0], 'utf8');
    } catch (err) {
      return { ok: false, error: 'No se pudo leer el archivo: ' + err.message };
    }
    return core.enableSync(text);
  });
  // ----- notas de todos los perfiles, papelera y permisos -----
  const str = (v) => (typeof v === 'string' ? v : '');
  ipcMain.handle('notes:list', () => core.notesView());
  ipcMain.handle('notes:open', async (_event, id) => {
    try {
      await core.openNote(str(id));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.code || err.message };
    }
  });
  ipcMain.handle('notes:copy', (_event, id) => {
    const url = core.noteUrl(str(id));
    if (url) clipboard.writeText(url);
    return !!url;
  });
  ipcMain.handle('notes:assign', (_event, id, profileId) => !!core.assignNoteProfile(str(id), str(profileId)));
  ipcMain.handle('notes:delete', (_event, id) => !!core.deleteNote(str(id)));
  ipcMain.handle('trash:list', () => core.trash());
  ipcMain.handle('trash:restore', (_event, id) => !!core.restoreNote(str(id)));
  ipcMain.handle('trash:purge', (_event, id) => !!core.purgeNote(str(id)));
  ipcMain.handle('trash:empty', () => core.emptyTrash());
  ipcMain.handle('profiles:sharing', (_event, profileId, mode) => core.setSharing(str(profileId), str(mode)));
  ipcMain.handle('sync:now', () => core.syncNow());
  ipcMain.handle('sync:disable', async () => {
    await core.disableSync();
    return true;
  });
}

app.on('second-instance', showWindow);

app.whenReady().then(async () => {
  core = createCore({ dataDir: app.getPath('userData') });
  core.events.on('error-storage', (err) => console.error('[almacenamiento]', err.message));
  core.events.on('error-internal', (err) => console.error('[interno]', err));

  try {
    await core.start();
  } catch (err) {
    const message =
      err.code === 'EADDRINUSE'
        ? `El puerto ${core.server.port} ya está en uso. Cierra la otra copia de la app o el programa que lo usa.`
        : err.message;
    dialog.showErrorBox('No se pudo iniciar el servidor local', message);
    app.exit(1);
    return;
  }

  registerIpc();
  createWindow();
  createTray();
  updateTray(await core.state());
  watchState();
});

// Antes de salir se guardan los datos pendientes
app.on('before-quit', (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  (core ? core.stop() : Promise.resolve()).catch(() => {}).finally(() => app.exit(0));
});

// La app sigue viva en la bandeja aunque no haya ventanas
app.on('window-all-closed', () => {});
