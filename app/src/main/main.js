'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, Tray, Menu, ipcMain, nativeImage, shell, dialog } = require('electron');
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

function createTray() {
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  tray = new Tray(image);
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
      if (win && !win.isDestroyed()) win.webContents.send('state', await core.state());
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
