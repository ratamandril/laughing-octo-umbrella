importScripts('storage.js', 'link.js', 'sync.js');

// ---- Contador en el ícono: notas que aplican a la pestaña activa ----
async function updateBadge(tabId, url) {
  if (!NotesStore.isSupported(url)) {
    chrome.action.setBadgeText({ tabId, text: '' });
    return;
  }
  const notes = NotesStore.forUrl(await NotesStore.getAll(), url);
  chrome.action.setBadgeText({ tabId, text: notes.length ? String(notes.length) : '' });
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#2563eb' });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' || info.url) updateBadge(tabId, tab.url);
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  updateBadge(tabId, tab.url);
});

// Cambios locales o sincronizados desde otro dispositivo
chrome.storage.onChanged.addListener(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) updateBadge(tab.id, tab.url);
});

// ---- Menú contextual: guardar el texto seleccionado ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'nota-root', title: 'Notas por URL: guardar selección', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'nota-title', parentId: 'nota-root', title: 'Como título de la nota', contexts: ['selection'] });
    chrome.contextMenus.create({ id: 'nota-desc', parentId: 'nota-root', title: 'Como descripción de la nota', contexts: ['selection'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!['nota-title', 'nota-desc'].includes(info.menuItemId)) return;
  if (!tab || !NotesStore.isSupported(tab.url)) return;

  const isTitle = info.menuItemId === 'nota-title';
  const raw = (info.selectionText || '').trim();
  const draft = {
    field: isTitle ? 'title' : 'description',
    text: isTitle ? raw.replace(/\s+/g, ' ').slice(0, 150) : raw.slice(0, 2000),
    tabId: tab.id,
    ts: Date.now(),
  };
  await chrome.storage.session.set({ draft });

  // El popup lee el borrador y rellena el formulario (el usuario completa color y etiquetas).
  try {
    await chrome.action.openPopup();
  } catch {
    // Si el navegador no permite abrir el popup, se abre como ventana pequeña
    chrome.windows.create({ url: chrome.runtime.getURL('popup.html'), type: 'popup', width: 420, height: 680 });
  }
});

// ---- Conexión con la app local ----
Sync.start();

chrome.alarms.create('notas-reconectar', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'notas-reconectar') Sync.ensure();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === 'link:restart') Sync.restart();
  if (msg && msg.type === 'link:retry') Sync.ensure();
});

// Cada cambio en la cola de salida se envía a la app
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.outbox || !changes.outbox.newValue) return;
  const { notes, palette } = changes.outbox.newValue;
  if (palette || Object.keys(notes || {}).length) Sync.flush();
});
