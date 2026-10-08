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
