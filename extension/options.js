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

  // Cuenta de esta extensión y su enlace con un perfil de navegador de esta PC
  const sel = $('#profileSel');
  try {
    const res = await Link.request('/profiles');
    const current = res.registered.find((p) => p.id === link.profileId);
    $('#noAccount').hidden = !!current;
    $('#accountBox').hidden = !current;
    $('#bindBox').hidden = !current;
    $('#sharingBox').hidden = !current;
    $('#emailBox').hidden = !current;
    if (current) {
      $('#accountName').textContent = current.email ? current.name + ' (' + current.email + ')' : current.name;
      if (document.activeElement !== $('#nameInput')) $('#nameInput').value = current.name;
      if (document.activeElement !== $('#emailInput')) $('#emailInput').value = current.email || '';
      $('#sharingSel').value = current.sharing || 'read';
      const mine = res.detected.filter((p) => p.browser === Link.browserKind());
      const options = [new Option('— sin enlace en esta PC —', ''), ...mine.map((p) => new Option(p.name + (p.email ? ' (' + p.email + ')' : '') + ' — ' + p.dir, p.dir))];
      const b = current.binding;
      if (b && b.browser !== Link.browserKind()) options.push(new Option('Enlazada a otro navegador (' + b.browser + ' · ' + b.dir + ')', '__other'));
      sel.replaceChildren(...options);
      sel.value = !b ? '' : b.browser === Link.browserKind() ? b.dir : '__other';
    }
    sel.disabled = false;
  } catch (err) {
    sel.replaceChildren(new Option(err.offline ? 'La app no está abierta' : err.message, ''));
    sel.disabled = true;
    for (const id of ['#sharingBox', '#emailBox', '#accountBox', '#bindBox', '#noAccount']) $(id).hidden = true;
  }

  // Notas de antes de conectar: se ofrecen una sola vez
  const { legacyImported } = await chrome.storage.local.get('legacyImported');
  const legacy = await NotesStore.getLegacy();
  const hasProfile = !!link.profileId;
  $('#importBox').hidden = !(hasProfile && !legacyImported && legacy.notes.length);
  $('#importText').textContent = 'Este perfil tiene ' + legacy.notes.length + ' notas guardadas de antes en la cuenta del navegador. Impórtalas a la app para que pasen a este perfil (quedan también allí como copia). Las que ya haya importado otro perfil de la misma cuenta, la app las ignora.';
}

$('#pairBtn').addEventListener('click', async () => {
  const code = $('#code').value.trim();
  if (!code) return linkMsg('Escribe el código que muestra la app.', true);
  $('#pairBtn').disabled = true;
  try {
    await Link.pair(code);
    $('#code').value = '';
    linkMsg('Conectada.');
  } catch (err) {
    linkMsg(err.message, true);
  } finally {
    $('#pairBtn').disabled = false;
  }
  renderLink();
});

$('#profileSel').addEventListener('change', async () => {
  const dir = $('#profileSel').value;
  if (dir === '__other') return;
  try {
    if (dir) await Link.setBinding(dir);
    else await Link.clearBinding();
    linkMsg(dir ? 'Enlace guardado: los links de la cuenta se abrirán con ese perfil.' : 'Enlace quitado en esta PC.');
  } catch (err) {
    linkMsg(err.message, true);
  }
  renderLink();
});

$('#saveEmail').addEventListener('click', async () => {
  try {
    const link = await NotesStore.getLink();
    const name = $('#nameInput').value.trim();
    const email = $('#emailInput').value.trim();
    if (!name) return linkMsg('El nombre no puede quedar vacío.', true);
    await Link.request('/profiles/' + encodeURIComponent(link.profileId), { method: 'PATCH', body: { name } });
    await Link.setEmail(email);
    linkMsg('Guardado.');
  } catch (err) {
    linkMsg(err.message, true);
  }
  renderLink();
});

$('#sharingSel').addEventListener('change', async () => {
  try {
    await Link.setSharing($('#sharingSel').value);
    linkMsg('Guardado: ' + $('#sharingSel').selectedOptions[0].textContent.split(':')[0].split(',')[0] + '.');
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
  await renderLink();
  linkMsg('Desconectada de la app. Las notas siguen guardadas en la app; este perfil no mostrará notas hasta que lo enlaces de nuevo.');
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' || (area === 'local' && (changes.link || changes.legacyImported))) renderLink();
});
renderLink();
