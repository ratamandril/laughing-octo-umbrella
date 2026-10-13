const $ = (s) => document.querySelector(s);
let palette = [];

function msg(text, isError = false) {
  const box = $('#msg');
  box.className = isError ? 'error' : 'ok';
  box.textContent = text;
}

function render() {
  const box = $('#palette');
  box.replaceChildren();
  palette.forEach((c, i) => {
    const color = el('input', { type: 'color', value: c.hex, title: 'Color' });
    color.addEventListener('input', () => { c.hex = color.value; });

    const name = el('input', { class: 'name', placeholder: 'Nombre', maxlength: '40', value: c.name });
    name.addEventListener('input', () => { c.name = name.value; });

    const info = el('textarea', { placeholder: 'Información: ¿para qué sirve esta categoría?', maxlength: '200' });
    info.value = c.info;
    info.addEventListener('input', () => { c.info = info.value; });

    box.append(el('div', { class: 'pal-row' }, color, name, info,
      el('button', { class: 'link danger', onclick: () => { palette.splice(i, 1); render(); } }, 'Eliminar')));
  });
  $('#addBtn').disabled = palette.length >= NotesStore.MAX_COLORS;
}

async function showShortcut() {
  const cmds = await chrome.commands.getAll();
  const c = cmds.find((x) => x.name === '_execute_action');
  $('#shortcut').textContent = c && c.shortcut ? c.shortcut : 'Sin asignar';
}

$('#addBtn').addEventListener('click', () => {
  palette.push({ id: 'c-' + crypto.randomUUID().slice(0, 8), name: 'Nueva categoría', hex: '#64748b', info: '' });
  render();
});

$('#saveBtn').addEventListener('click', async () => {
  try {
    await NotesStore.savePalette(palette);
    palette = await NotesStore.getPalette();
    render();
    msg('Categorías guardadas.');
  } catch (err) {
    msg('No se pudo guardar: ' + err.message, true);
  }
});

$('#shortcutBtn').addEventListener('click', () => {
  const scheme = navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome';
  chrome.tabs.create({ url: scheme + '://extensions/shortcuts' });
});

$('#theme').addEventListener('change', async (e) => {
  applyTheme(e.target.value);
  await NotesStore.saveSettings({ theme: e.target.value });
});

(async () => {
  const st = await NotesStore.getSettings();
  $('#theme').value = st.theme || document.documentElement.dataset.theme;
  palette = (await NotesStore.getPalette()).map((c) => ({ ...c }));
  render();
  showShortcut();
})();


// ---------- Conexión con la app ----------
function linkMsg(text, isError = false) {
  const box = $('#linkMsg');
  box.className = isError ? 'error' : 'ok';
  box.textContent = text;
}

async function renderLink() {
  const link = await NotesStore.getLink();
  const c = await Link.conn();
  const revoked = !!link && c.state === 'revoked';
  // Si la app dejó de reconocer la extensión, se pide un código nuevo en lugar de mostrar el perfil
  $('#linkOff').hidden = !!link && !revoked;
  $('#linkOn').hidden = !link || revoked;
  $('#linkWarn').hidden = !revoked;
  $('#linkWarn').textContent = revoked ? 'La app ya no reconoce esta extensión. Genera un código nuevo en la app y escríbelo aquí.' : '';
  if (!link || revoked) return;

  $('#linkState').textContent = Link.STATE_TEXT[c.state] || 'Conectada a la app.';

  // Perfiles detectados por la app para este navegador
  const sel = $('#profileSel');
  try {
    const res = await Link.request('/profiles');
    const mine = res.detected.filter((p) => p.browser === Link.browserKind());
    sel.replaceChildren(new Option('— elige —', ''), ...mine.map((p) => new Option(p.name + (p.email ? ' (' + p.email + ')' : '') + ' — ' + p.dir, p.dir)));
    const current = res.registered.find((p) => p.id === link.profileId);
    if (current) sel.value = current.dir;
    sel.disabled = false;
  } catch (err) {
    sel.replaceChildren(new Option(err.offline ? 'La app no está abierta' : err.message, ''));
    sel.disabled = true;
  }

  // Notas de antes de conectar: se ofrecen una sola vez
  const { legacyImported } = await chrome.storage.local.get('legacyImported');
  const legacy = await NotesStore.getLegacy();
  const hasProfile = !!link.profileId;
  $('#importBox').hidden = !(hasProfile && !legacyImported && legacy.notes.length);
  $('#importText').textContent = 'Este perfil tiene ' + legacy.notes.length + ' notas guardadas de antes. Impórtalas a la app para compartirlas con tus otros perfiles (se quedan también aquí como copia).';
}

$('#pairBtn').addEventListener('click', async () => {
  const code = $('#code').value.trim();
  if (!code) return linkMsg('Escribe el código que muestra la app.', true);
  $('#pairBtn').disabled = true;
  try {
    await Link.pair(code);
    $('#code').value = '';
    linkMsg('Conectada. Ahora elige a qué perfil corresponde este navegador.');
  } catch (err) {
    linkMsg(err.message, true);
  } finally {
    $('#pairBtn').disabled = false;
  }
  renderLink();
});

$('#saveProfile').addEventListener('click', async () => {
  const dir = $('#profileSel').value;
  if (!dir) return linkMsg('Elige un perfil.', true);
  try {
    const res = await Link.request('/me/profile', { method: 'PUT', body: { browser: Link.browserKind(), dir } });
    const link = await NotesStore.getLink();
    await Link.save({ ...link, profileId: res.profile.id });
    linkMsg('Perfil guardado: ' + res.profile.name + '.');
  } catch (err) {
    linkMsg(err.message, true);
  }
  renderLink();
});

$('#importLegacy').addEventListener('click', async () => {
  try {
    const r = await NotesStore.importLegacy();
    linkMsg('Importadas ' + r.notes + ' notas' + (r.palette ? ' y ' + r.palette + ' categorías' : '') + '. La app las enviará enseguida.');
  } catch (err) {
    linkMsg(err.message, true);
  }
  renderLink();
});

$('#unpairBtn').addEventListener('click', async () => {
  const { outbox } = await chrome.storage.local.get('outbox');
  const pending = outbox ? Object.keys(outbox.notes || {}).length : 0;
  const warn = pending ? ' Hay ' + pending + ' cambios sin enviar a la app que se perderán.' : '';
  if (!confirm('¿Desconectar este perfil de la app?' + warn + ' Las notas siguen guardadas en la app.')) return;
  await Link.unlink();
  linkMsg('Desconectada.');
  renderLink();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' || (area === 'local' && (changes.link || changes.legacyImported))) renderLink();
});
renderLink();
