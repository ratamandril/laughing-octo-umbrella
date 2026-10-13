const $ = (s) => document.querySelector(s);
let all = [];
let palette = [];
let editing = null;
let eColor = null;

async function load() {
  [all, palette] = await Promise.all([NotesStore.getAll(), NotesStore.getPalette()]);
  fillFilters();
  render();
}

function fillFilters() {
  const fc = $('#fColor'), ft = $('#fTag');
  const curC = fc.value, curT = ft.value;
  fc.replaceChildren(new Option('Todas las categorías', ''), new Option('Sin categoría', 'none'),
    ...palette.map((c) => new Option(c.name, c.id)));
  const tags = NotesStore.allTags(all);
  ft.replaceChildren(new Option('Todas las etiquetas', ''),
    ...[...tags].map(([t, n]) => new Option('#' + t + ' (' + n + ')', t)));
  fc.value = curC;
  ft.value = curT;
}

function render() {
  const filtered = NotesStore.filter(all, {
    q: $('#search').value, tag: $('#fTag').value, color: $('#fColor').value, scope: $('#fScope').value,
  });
  $('#count').textContent = filtered.length + ' de ' + all.length + ' notas';

  const groups = new Map();
  for (const n of filtered) {
    if (!groups.has(n.host)) groups.set(n.host, []);
    groups.get(n.host).push(n);
  }

  const list = $('#list');
  list.replaceChildren();
  for (const [host, notes] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    list.append(el('h2', { class: 'group-title' }, host));
    for (const n of notes) {
      list.append(noteCard(n, {
        mode: 'detailed', palette, showUrl: true,
        onEdit: openEdit, onDelete: removeNote,
        onTag: (t) => { $('#fTag').value = t; render(); },
      }));
    }
  }
}

function openEdit(note) {
  editing = note;
  eColor = note.color;
  $('#eTitle').value = note.title;
  $('#eDesc').value = note.description;
  $('#eTags').value = note.tags.join(', ');
  $('#eScope').value = note.scope;
  $('#eError').textContent = '';
  swatchPicker($('#eSwatches'), palette, eColor, (id) => { eColor = id; });
  $('#dlg').showModal();
}

async function removeNote(note) {
  if (!confirm('¿Eliminar "' + note.title + '"?')) return;
  await NotesStore.remove(note.id);
}

function msg(text, isError = false) {
  const box = $('#msg');
  box.className = isError ? 'error' : 'ok';
  box.textContent = text;
}

$('#eSave').addEventListener('click', async () => {
  try {
    await NotesStore.update(editing.id, {
      title: $('#eTitle').value.trim() || editing.title,
      description: $('#eDesc').value.trim(),
      scope: $('#eScope').value,
      tags: NotesStore.parseTags($('#eTags').value),
      color: eColor,
    });
    $('#dlg').close();
  } catch (err) {
    $('#eError').textContent = 'No se pudo guardar: ' + err.message;
  }
});
$('#eCancel').addEventListener('click', () => $('#dlg').close());

// ---- Exportar / importar ----
$('#exportBtn').addEventListener('click', async () => {
  const data = await NotesStore.exportData();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = el('a', { href: url, download: 'notas-url-' + new Date().toISOString().slice(0, 10) + '.json' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  msg('Exportadas ' + data.notes.length + ' notas.');
});

$('#importBtn').addEventListener('click', () => $('#importFile').click());
$('#importFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const r = await NotesStore.importData(JSON.parse(await file.text()));
    msg('Importación lista: ' + r.added + ' nuevas, ' + r.updated + ' actualizadas, ' + r.skipped + ' omitidas.');
  } catch (err) {
    msg('No se pudo importar: ' + err.message, true);
  }
  e.target.value = '';
});

$('#optionsBtn').addEventListener('click', () => openPage('options.html'));
$('#search').addEventListener('input', render);
for (const id of ['#fColor', '#fTag', '#fScope']) $(id).addEventListener('change', render);

// Se refresca solo cuando cambian los datos, incluso si vienen de otro dispositivo
chrome.storage.onChanged.addListener(load);

load();
