const $ = (s) => document.querySelector(s);
let all = [];
let palette = [];
let editing = null;
let eColor = null;
let link = null;
let profiles = [];
let editingForeign = null; // nota de otro perfil (solo si ese perfil permite editar)

async function load() {
  [all, palette, link, profiles, safetyCtx] = await Promise.all([NotesStore.getAll(), NotesStore.getPalette(), NotesStore.getLink(), Link.profiles(), Link.safetyContext()]);
  Link.paintStatus($('#conn'), () => openPage('options.html'));
  $('#exportBtn').hidden = $('#importBtn').hidden = !link;
  fillFilters();
  render();
  othersCtl.refresh();
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

  // Filtro por perfil: solo con la app conectada
  const fp = $('#fProfile');
  const curP = fp.value;
  fp.hidden = !multi();
  if (multi()) {
    fp.replaceChildren(new Option('Todos los perfiles', ''),
      ...profiles.map((p) => new Option(profileLabel(p) + (p.id === link.profileId ? ' (este)' : ''), p.id)),
      new Option('Sin perfil', 'none'));
    fp.value = curP;
  }
}

// ---------- Visualización propia de esta página (no depende del ajuste del popup) ----------
const DEFAULT_VIEW = { view: 'detailed', sort: 'recent', group: 'site', collapsed: [] };
let prefs = { ...DEFAULT_VIEW };
try { prefs = { ...DEFAULT_VIEW, ...JSON.parse(localStorage.getItem('pageView') || '{}') }; } catch { /* sin caché */ }
const collapsed = new Set(prefs.collapsed);
const viewOverride = new Map(); // id de nota -> vista temporal

function savePrefs() {
  prefs.collapsed = [...collapsed];
  try { localStorage.setItem('pageView', JSON.stringify(prefs)); } catch { /* sin caché */ }
}

let safetyCtx = null;
const NEXT_VIEW = { simple: 'normal', normal: 'detailed', detailed: 'simple' };

function sortNotes(list) {
  const by = {
    recent: (a, b) => b.updatedAt - a.updatedAt,
    old: (a, b) => a.updatedAt - b.updatedAt,
    az: (a, b) => a.title.localeCompare(b.title, 'es'),
  }[prefs.sort] || ((a, b) => b.updatedAt - a.updatedAt);
  return [...list].sort(by);
}

function cardOptions(n) {
  const mode = viewOverride.get(n.id) || prefs.view;
  return {
    mode, palette, showUrl: true,
    onEdit: openEdit, onDelete: removeNote,
    onTag: (t) => { $('#fTag').value = t; render(); },
    onCycle: prefs.view === 'simple' ? cycleNote : null,
    onView: setNoteView,
    onNotice: (text, isError) => msg(text, isError),
    profiles: multi() ? profiles : null, myProfileId: link && link.profileId, onOpen: openInProfile,
    safety: Link.noteSafety(n, safetyCtx),
  };
}

function foreignCard(note, profile) {
  const mode = viewOverride.get(note.id) || prefs.view;
  return noteCard(note, {
    mode, palette, showUrl: true,
    onEdit: profile.sharing === 'edit' ? (n) => openEdit(n, profile) : null,
    onCycle: prefs.view === 'simple' ? cycleNote : null,
    onView: setNoteView,
    onNotice: (text, isError) => msg(text, isError),
    profiles: [profile], myProfileId: link && link.profileId, onOpen: openInProfile,
  });
}

const othersCtl = Others.mount({
  box: $('#others'),
  getUrl: () => null,
  makeCard: foreignCard,
  onState: ({ profiles: n }) => { $('#globalWrap').hidden = !n; },
});

function syncGlobalSearch() {
  othersCtl.setQuery($('#globalSearch').checked ? $('#search').value : '');
}
let globalTimer = null;
$('#search').addEventListener('input', () => { clearTimeout(globalTimer); globalTimer = setTimeout(syncGlobalSearch, 250); });
$('#globalSearch').addEventListener('change', syncGlobalSearch);

function cycleNote(note) {
  const next = NEXT_VIEW[viewOverride.get(note.id) || 'simple'];
  if (next === 'simple') viewOverride.delete(note.id); else viewOverride.set(note.id, next);
  render();
  othersCtl.redraw();
}

function setNoteView(note, mode) {
  if (mode === prefs.view) viewOverride.delete(note.id); else viewOverride.set(note.id, mode);
  render();
  othersCtl.redraw();
}

// Con una sola persona/perfil visible no hace falta mostrar ni filtrar por perfil
const multi = () => false; // la caché solo tiene notas propias: no hay filtro ni agrupación por perfil

function groupKey(n) {
  if (prefs.group === 'profile') return 'p:' + (n.profileId || 'none');
  return 'h:' + n.host;
}

function groupLabel(key) {
  if (key.startsWith('p:')) {
    const p = profiles.find((x) => x.id === key.slice(2));
    return p ? profileLabel(p) : 'Sin perfil';
  }
  return key.slice(2);
}

function render() {
  if (!link) {
    $('#count').textContent = '';
    $('#list').replaceChildren(el('p', { class: 'muted' }, 'Esta extensión aún no está enlazada con la app. Las notas se guardan en la app: enlázala en Ajustes → Conexión con la app para ver y crear notas.'));
    return;
  }
  if (prefs.group === 'profile' && !multi()) prefs.group = 'site';
  const filtered = NotesStore.filter(all, {
    q: $('#search').value, tag: $('#fTag').value, color: $('#fColor').value, scope: $('#fScope').value,
    profile: multi() ? $('#fProfile').value : '',
  });
  const searching = !!$('#search').value.trim();
  $('#count').textContent = filtered.length + ' de ' + all.length + ' notas';
  $('#pView').value = prefs.view;
  $('#pSort').value = prefs.sort;
  $('#pGroup').value = prefs.group;
  $('#pGroup').querySelector('[value=profile]').hidden = !multi();
  const grouped = prefs.group !== 'none';
  $('#collapseAll').hidden = !grouped;
  $('#expandAll').hidden = !grouped;

  const list = $('#list');
  list.replaceChildren();
  if (!grouped) {
    for (const n of sortNotes(filtered)) list.append(noteCard(n, cardOptions(n)));
    return;
  }

  const groups = new Map();
  for (const n of filtered) {
    const key = groupKey(n);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(n);
  }
  for (const [key, notes] of [...groups].sort((a, b) => groupLabel(a[0]).localeCompare(groupLabel(b[0]), 'es'))) {
    // al buscar se abren los grupos con resultados, sin tocar lo que se recuerda
    const isCollapsed = collapsed.has(key) && !searching;
    const body = el('div', { class: 'group-body' }, ...sortNotes(notes).map((n) => noteCard(n, cardOptions(n))));
    const head = el('button', { type: 'button', class: 'sec-head', 'aria-expanded': String(!isCollapsed) },
      el('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'), groupLabel(key), el('span', { class: 'group-count' }, ' (' + notes.length + ')'));
    head.addEventListener('click', () => {
      if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
      savePrefs();
      render();
    });
    list.append(el('section', { class: 'group-sec' + (isCollapsed ? ' collapsed' : '') }, head, body));
  }
}

$('#pView').addEventListener('change', (e) => { prefs.view = e.target.value; viewOverride.clear(); savePrefs(); render(); });
$('#pSort').addEventListener('change', (e) => { prefs.sort = e.target.value; savePrefs(); render(); });
$('#pGroup').addEventListener('change', (e) => { prefs.group = e.target.value; savePrefs(); render(); });
$('#collapseAll').addEventListener('click', () => {
  for (const n of NotesStore.filter(all, { q: $('#search').value, tag: $('#fTag').value, color: $('#fColor').value, scope: $('#fScope').value, profile: multi() ? $('#fProfile').value : '' })) collapsed.add(groupKey(n));
  savePrefs();
  render();
});
$('#expandAll').addEventListener('click', () => { collapsed.clear(); savePrefs(); render(); });

async function openInProfile(note) {
  try {
    await Link.openNote(note.id);
    msg('Abriendo en ' + (profiles.find((p) => p.id === note.profileId) ? profileLabel(profiles.find((p) => p.id === note.profileId)) : 'su perfil') + '…');
  } catch (err) {
    msg(err.message, true);
  }
}

function openEdit(note, foreignProfile = null) {
  editing = note;
  editingForeign = foreignProfile ? note : null;
  $('#dlg h2').textContent = foreignProfile ? 'Editar nota de ' + profileLabel(foreignProfile) : 'Editar nota';
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
    const patch = {
      title: $('#eTitle').value.trim() || editing.title,
      description: $('#eDesc').value.trim(),
      scope: $('#eScope').value,
      tags: NotesStore.parseTags($('#eTags').value),
      color: eColor,
    };
    if (editingForeign) {
      await Link.saveForeign(editingForeign, patch);
      $('#dlg').close();
      othersCtl.refresh();
      return;
    }
    await NotesStore.update(editing.id, patch);
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
for (const id of ['#fColor', '#fTag', '#fScope', '#fProfile']) $(id).addEventListener('change', render);

// Se refresca solo cuando cambian los datos, incluso si vienen de otro dispositivo
let reloadTimer = null;
function scheduleLoad() {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => (menuIsOpen() ? scheduleLoad() : load()), 150);
}
let othersTimer = null;
function scheduleOthers() {
  clearTimeout(othersTimer);
  othersTimer = setTimeout(() => (menuIsOpen() ? scheduleOthers() : othersCtl.refresh()), 300);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') {
    Link.paintStatus($('#conn'), () => openPage('options.html'));
    if (changes.othersTick) { scheduleOthers(); return; }
  }
  scheduleLoad();
});

load();
