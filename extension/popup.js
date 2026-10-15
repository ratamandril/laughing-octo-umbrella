const $ = (s) => document.querySelector(s);

// Tamaños del popup en px. El navegador limita los popups a 800 × 600.
const SIZES = { compact: [340, 460], normal: [400, 540], large: [520, 600] };

let tab = null;
let editingId = null;
let palette = [];
let settings = { ...NotesStore.DEFAULT_SETTINGS };
let last = { tags: [], color: null };
let selectedColor = null;
let filterColor = '';
let filterTag = '';
let shownNotes = [];
let shownAll = [];
let allLimit = 100;
let query = '';
let safetyCtx = null;
const PAGE_SIZE = 100;
let sections = { page: true, all: false }; // secciones desplegadas (se recuerdan)
try { sections = { ...sections, ...JSON.parse(localStorage.getItem('sections') || '{}') }; } catch { /* sin caché */ }
let link = null; // enlace con la app (null si la extensión no está conectada)
let profiles = [];
const viewOverride = new Map(); // id de nota -> vista temporal

// ---------- Ajustes de vista ----------
function applySettings() {
  document.documentElement.style.fontSize = settings.fontSize + 'px';
  const [w, h] = SIZES[settings.size] || SIZES.normal;
  document.body.style.setProperty('--pw', w + 'px');
  document.body.style.setProperty('--ph', h + 'px');
  $('#form').classList.toggle('collapsed', !!settings.formCollapsed);
  $('#toggleForm').textContent = settings.formCollapsed ? '▸' : '▾';
}

// Copia local de los ajustes: se aplica de inmediato al abrir, antes de que
// responda chrome.storage, para que el popup no "salte" de tamaño.
try {
  const cached = JSON.parse(localStorage.getItem('ui') || 'null');
  if (cached) { settings = { ...settings, ...cached }; applySettings(); }
} catch { /* sin caché: se aplican los valores por defecto al cargar */ }

function cacheSettings() {
  try {
    localStorage.setItem('ui', JSON.stringify({
      fontSize: settings.fontSize, size: settings.size, formCollapsed: settings.formCollapsed,
    }));
  } catch { /* localStorage puede no estar disponible */ }
}

async function setSetting(patch) {
  Object.assign(settings, patch);
  cacheSettings();
  applySettings();
  await NotesStore.saveSettings(patch);
}

function fillSettingsPanel() {
  $('#sTheme').value = document.documentElement.dataset.theme;
  $('#sView').value = settings.view;
  $('#sFont').value = settings.fontSize;
  $('#sFontOut').textContent = settings.fontSize + ' px';
  $('#sSize').value = settings.size;
  $('#sRemTags').checked = settings.rememberTags;
  $('#sRemColor').checked = settings.rememberColor;
}

// ---------- Valores recordados de la nota anterior ----------
function rememberedTags() {
  return settings.rememberTags ? last.tags.join(', ') : '';
}
function rememberedColor() {
  const id = settings.rememberColor ? last.color : null;
  return palette.some((c) => c.id === id) ? id : null; // la categoría pudo haberse eliminado
}

// ---------- Inicio ----------
async function init() {
  // Borrador creado por el menú contextual (texto seleccionado)
  let draft = null;
  try {
    const s = await chrome.storage.session.get('draft');
    if (s.draft && Date.now() - s.draft.ts < 120000) draft = s.draft;
    if (s.draft) await chrome.storage.session.remove('draft');
  } catch { /* storage.session no disponible */ }

  if (draft) { try { tab = await chrome.tabs.get(draft.tabId); } catch { /* la pestaña se cerró */ } }
  if (!tab) [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  [palette, settings, last, link, profiles] = await Promise.all([
    NotesStore.getPalette(), NotesStore.getSettings(), NotesStore.getLast(), NotesStore.getLink(), Link.profiles(),
  ]);
  paintConn();
  cacheSettings();
  applySettings();
  fillSettingsPanel();

  const linked = !!link;
  $('#unlinked').hidden = linked;
  document.querySelector('.p-search').hidden = !linked;
  $('#listWrap').hidden = !linked;

  const ok = tab && NotesStore.isSupported(tab.url);
  $('#pageInfo').textContent = ok ? NotesStore.hostOf(tab.url) : 'Esta pestaña no admite notas (solo páginas http/https).';
  $('#form').hidden = !ok || !linked;
  if (!ok || !linked) {
    $('#filters').hidden = true;
    return;
  }

  resetForm();
  if (draft) $(draft.field === 'title' ? '#title' : '#description').value = draft.text;
  await render();
}

// ---------- Lista ----------
function drawSwatches() {
  swatchPicker($('#swatches'), palette, selectedColor, (id) => { selectedColor = id; });
}

function fillFilters(notes) {
  const usedColors = palette.filter((c) => notes.some((n) => n.color === c.id));
  const tags = [...NotesStore.allTags(notes).keys()];
  if (!usedColors.some((c) => c.id === filterColor)) filterColor = '';
  if (!tags.includes(filterTag)) filterTag = '';

  $('#fColor').replaceChildren(new Option('Todas las categorías', ''), ...usedColors.map((c) => new Option(c.name, c.id)));
  $('#fTag').replaceChildren(new Option('Todas las etiquetas', ''), ...tags.map((t) => new Option('#' + t, t)));
  $('#fColor').value = filterColor;
  $('#fTag').value = filterTag;
  $('#filters').hidden = !usedColors.length && !tags.length;
}

function applySections() {
  // Al buscar se abren las dos secciones para ver todos los resultados (sin cambiar lo que se recuerda)
  const searching = !!query.trim();
  const pageOpen = searching || sections.page;
  const allOpen = searching || sections.all;
  $('#pageHead').setAttribute('aria-expanded', String(pageOpen));
  $('#pageBody').hidden = !pageOpen;
  $('#allHead').setAttribute('aria-expanded', String(allOpen));
  $('#allBody').hidden = !allOpen;
}

function toggleSection(name) {
  sections[name] = !sections[name];
  try { localStorage.setItem('sections', JSON.stringify(sections)); } catch { /* sin caché */ }
  applySections();
  if (name === 'all' && sections.all) drawAll();
}

async function render() {
  [link, profiles, safetyCtx] = await Promise.all([NotesStore.getLink(), Link.profiles(), Link.safetyContext()]);
  const everything = await NotesStore.getAll();
  const related = NotesStore.forUrl(everything, tab.url);
  const relatedIds = new Set(related.map((n) => n.id));
  fillFilters(everything);

  const criteria = { q: query, tag: filterTag, color: filterColor };
  const shown = NotesStore.filter(related, criteria);
  const others = NotesStore.filter(everything.filter((n) => !relatedIds.has(n.id)), criteria);
  const filtering = !!(query.trim() || filterTag || filterColor);

  $('#empty').hidden = shown.length > 0;
  $('#empty').textContent = related.length && filtering ? 'Ninguna nota de esta página coincide.' : 'Aún no hay notas para esta página.';
  $('#pageTitle').textContent = 'Notas de esta página (' + shown.length + (shown.length !== related.length ? ' de ' + related.length : '') + ')';
  $('#allTitle').textContent = 'Todas las notas (' + others.length + ')';

  shownNotes = shown;
  shownAll = others;
  applySections();
  draw();
  drawAll();
}

function cardOptions(n) {
  // Con una sola persona/perfil visible no hace falta mostrar el perfil
  const multi = !!link && profiles.length > 1;
  const mode = viewOverride.get(n.id) || settings.view;
  return {
    mode, palette,
    onEdit: startEdit, onDelete: removeNote,
    onTag: (t) => { filterTag = t; render(); },
    onCycle: settings.view === 'simple' ? cycleNote : null,
    onView: setNoteView,
    onNotice: notice,
    profiles: multi ? profiles : null, myProfileId: link && link.profileId, onOpen: openInProfile,
    safety: Link.noteSafety(n, safetyCtx),
  };
}

// Dibuja las tarjetas con las notas ya cargadas (sin volver a leer el almacenamiento)
function draw() {
  const wrap = $('#listWrap');
  const top = wrap.scrollTop;
  const box = $('#related');
  box.replaceChildren();
  for (const n of shownNotes) box.append(noteCard(n, cardOptions(n)));
  wrap.scrollTop = top;
}

function drawAll() {
  if ($('#allBody').hidden) return; // solo se dibuja lo que se ve
  const wrap = $('#listWrap');
  const top = wrap.scrollTop;
  const box = $('#allNotes');
  box.replaceChildren();
  for (const n of shownAll.slice(0, allLimit)) box.append(noteCard(n, cardOptions(n)));
  $('#moreAll').hidden = shownAll.length <= allLimit;
  $('#moreAll').textContent = 'Mostrar más (' + (shownAll.length - allLimit) + ' restantes)';
  $('#allHint').hidden = !shownNotes.length;
  $('#allEmpty').hidden = shownAll.length > 0;
  wrap.scrollTop = top;
}

function redraw() { draw(); drawAll(); }

let noticeTimer = null;
function notice(text, isError = false) {
  const box = $('#notice');
  box.hidden = false;
  box.textContent = text;
  box.classList.toggle('error', isError);
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { box.hidden = true; }, 3000);
}

function setNoteView(note, mode) {
  if (mode === settings.view) viewOverride.delete(note.id); else viewOverride.set(note.id, mode);
  redraw();
}

// simple → normal → detallada → simple, solo para la nota pulsada y solo hasta cerrar el popup
const NEXT_VIEW = { simple: 'normal', normal: 'detailed', detailed: 'simple' };
function cycleNote(note) {
  const next = NEXT_VIEW[viewOverride.get(note.id) || 'simple'];
  if (next === 'simple') viewOverride.delete(note.id); else viewOverride.set(note.id, next);
  redraw();
}

async function openInProfile(note) {
  try {
    await Link.openNote(note.id);
    notice('Abriendo en su perfil…');
  } catch (err) {
    notice(err.message, true);
  }
}

function paintConn() {
  Link.paintStatus($('#conn'), async () => { await openPage('options.html'); window.close(); });
}

// Cambios que llegan de otros perfiles (a través de la app) o del estado de la conexión
let refreshTimer = null;
function scheduleRefresh(reloadPalette = false) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    if (menuIsOpen()) return scheduleRefresh(reloadPalette); // espera a que se cierre el menú
    if (reloadPalette) { palette = await NotesStore.getPalette(); drawSwatches(); }
    render();
  }, 120);
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (!tab) return;
  if (area === 'session') {
    paintConn();
    if (changes.cloud || changes.conn) scheduleRefresh(); // los avisos "sin subir" dependen de la nube
    return;
  }
  if (area !== 'local') return;
  const keys = Object.keys(changes);
  if (keys.includes('outbox') || keys.includes('link')) paintConn();
  if (keys.some((k) => k.startsWith('n_') || ['palette', 'profiles', 'link', 'outbox'].includes(k))) scheduleRefresh(keys.includes('palette'));
});

// ---------- Formulario ----------
function startEdit(note) {
  editingId = note.id;
  $('#title').value = note.title;
  $('#description').value = note.description;
  $('#tags').value = note.tags.join(', ');
  $('#scope').value = note.scope;
  selectedColor = note.color;
  drawSwatches();
  $('#form').classList.remove('collapsed'); // al editar, el formulario debe verse
  $('#toggleForm').textContent = '▾';
  $('#formTitle').textContent = 'Editar nota';
  $('#cancelBtn').hidden = false;
  $('#title').focus();
}

// Deja el formulario listo para una nota nueva, con etiquetas/color recordados si está activado
function resetForm() {
  editingId = null;
  $('#title').value = '';
  $('#description').value = '';
  $('#tags').value = rememberedTags();
  $('#scope').value = 'page';
  selectedColor = rememberedColor();
  drawSwatches();
  $('#formTitle').textContent = 'Nueva nota';
  $('#cancelBtn').hidden = true;
  $('#error').textContent = '';
}

async function removeNote(note) {
  if (!confirm('¿Eliminar "' + note.title + '"?')) return;
  await NotesStore.remove(note.id);
  if (editingId === note.id) resetForm();
  await render();
}

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('#title').value.trim() || tab.title || tab.url;
  const description = $('#description').value.trim();
  const scope = $('#scope').value;
  const tags = NotesStore.parseTags($('#tags').value);
  try {
    if (editingId) {
      await NotesStore.update(editingId, { title, description, scope, tags, color: selectedColor });
    } else {
      await NotesStore.save(NotesStore.create({ title, description, url: tab.url, scope, tags, color: selectedColor }));
      // Se guardan siempre; solo se reaplican si la opción está activada en el engranaje
      last = { tags, color: selectedColor };
      await NotesStore.saveLast(last);
    }
    resetForm();
    await render();
  } catch (err) {
    $('#error').textContent = 'No se pudo guardar: ' + err.message;
  }
});

$('#description').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#form').requestSubmit();
});
$('#cancelBtn').addEventListener('click', resetForm);
$('#toggleForm').addEventListener('click', () => setSetting({ formCollapsed: !settings.formCollapsed }));

// ---------- Filtros y navegación ----------
$('#search').addEventListener('input', (e) => { query = e.target.value; allLimit = PAGE_SIZE; render(); });
$('#pageHead').addEventListener('click', () => toggleSection('page'));
$('#allHead').addEventListener('click', () => toggleSection('all'));
$('#moreAll').addEventListener('click', () => { allLimit += PAGE_SIZE; drawAll(); });
$('#fColor').addEventListener('change', (e) => { filterColor = e.target.value; render(); });
$('#fTag').addEventListener('change', (e) => { filterTag = e.target.value; render(); });
$('#openAll').addEventListener('click', async () => { await openPage('notes.html'); window.close(); });

// ---------- Engranaje ----------
$('#gear').addEventListener('click', () => { fillSettingsPanel(); $('#settings').hidden = false; });
$('#closeSettings').addEventListener('click', () => { $('#settings').hidden = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#settings').hidden = true; });

$('#sTheme').addEventListener('change', (e) => { applyTheme(e.target.value); setSetting({ theme: e.target.value }); });
$('#sView').addEventListener('change', async (e) => { viewOverride.clear(); await setSetting({ view: e.target.value }); render(); });
$('#sFont').addEventListener('input', (e) => {
  settings.fontSize = Number(e.target.value);
  $('#sFontOut').textContent = settings.fontSize + ' px';
  applySettings(); // vista previa en vivo
});
$('#sFont').addEventListener('change', () => setSetting({ fontSize: settings.fontSize }));
$('#sSize').addEventListener('change', (e) => setSetting({ size: e.target.value }));
$('#sRemTags').addEventListener('change', async (e) => {
  await setSetting({ rememberTags: e.target.checked });
  if (!editingId) $('#tags').value = rememberedTags();
});
$('#sRemColor').addEventListener('change', async (e) => {
  await setSetting({ rememberColor: e.target.checked });
  if (!editingId) { selectedColor = rememberedColor(); drawSwatches(); }
});
$('#optBtn').addEventListener('click', async () => { await openPage('options.html'); window.close(); });
$('#openLink').addEventListener('click', async () => { await openPage('options.html'); window.close(); });

init();
