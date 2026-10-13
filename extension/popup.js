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

  const ok = tab && NotesStore.isSupported(tab.url);
  $('#pageInfo').textContent = ok ? NotesStore.hostOf(tab.url) : 'Esta pestaña no admite notas (solo páginas http/https).';
  $('#form').hidden = !ok;
  if (!ok) return;

  resetForm();
  if (draft) $(draft.field === 'title' ? '#title' : '#description').value = draft.text;
  await render();
}

// ---------- Lista ----------
function drawSwatches() {
  swatchPicker($('#swatches'), palette, selectedColor, (id) => { selectedColor = id; });
}

function fillFilters(related) {
  const usedColors = palette.filter((c) => related.some((n) => n.color === c.id));
  const tags = [...NotesStore.allTags(related).keys()];
  if (!usedColors.some((c) => c.id === filterColor)) filterColor = '';
  if (!tags.includes(filterTag)) filterTag = '';

  $('#fColor').replaceChildren(new Option('Todas las categorías', ''), ...usedColors.map((c) => new Option(c.name, c.id)));
  $('#fTag').replaceChildren(new Option('Todas las etiquetas', ''), ...tags.map((t) => new Option('#' + t, t)));
  $('#fColor').value = filterColor;
  $('#fTag').value = filterTag;
  $('#filters').hidden = related.length < 2 || (!usedColors.length && !tags.length);
}

async function render() {
  [link, profiles] = await Promise.all([NotesStore.getLink(), Link.profiles()]);
  const related = NotesStore.forUrl(await NotesStore.getAll(), tab.url);
  fillFilters(related);
  const shown = NotesStore.filter(related, { tag: filterTag, color: filterColor });

  $('#empty').hidden = related.length > 0;
  $('#relatedTitle').hidden = related.length === 0;
  $('#relatedTitle').textContent = 'Notas de esta página (' + shown.length + (shown.length !== related.length ? ' de ' + related.length : '') + ')';

  shownNotes = shown;
  draw();
}

// Dibuja las tarjetas con las notas ya cargadas (sin volver a leer el almacenamiento)
function draw() {
  const wrap = $('#listWrap');
  const top = wrap.scrollTop;
  const box = $('#related');
  box.replaceChildren();
  for (const n of shownNotes) {
    // El cambio por nota solo existe mientras la vista general sea "Simple"
    const mode = (settings.view === 'simple' && viewOverride.get(n.id)) || settings.view;
    box.append(noteCard(n, {
      mode, palette,
      onEdit: startEdit, onDelete: removeNote,
      onTag: (t) => { filterTag = t; render(); },
      onCycle: settings.view === 'simple' ? cycleNote : null,
      profiles: link ? profiles : null, myProfileId: link && link.profileId, onOpen: openInProfile,
    }));
  }
  wrap.scrollTop = top;
}

// simple → normal → detallada → simple, solo para la nota pulsada y solo hasta cerrar el popup
const NEXT_VIEW = { simple: 'normal', normal: 'detailed', detailed: 'simple' };
function cycleNote(note) {
  const next = NEXT_VIEW[viewOverride.get(note.id) || 'simple'];
  if (next === 'simple') viewOverride.delete(note.id); else viewOverride.set(note.id, next);
  draw();
}

async function openInProfile(note) {
  try {
    await Link.openNote(note.id);
    $('#error').textContent = '';
  } catch (err) {
    $('#error').textContent = err.message;
  }
}

function paintConn() {
  Link.paintStatus($('#conn'), async () => { await openPage('options.html'); window.close(); });
}

// Cambios que llegan de otros perfiles (a través de la app) o del estado de la conexión
let refreshTimer = null;
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session') return paintConn();
  if (area !== 'local' || !tab) return;
  if (!Object.keys(changes).some((k) => k.startsWith('n_') || k === 'palette' || k === 'profiles' || k === 'link')) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(async () => {
    palette = await NotesStore.getPalette();
    drawSwatches();
    render();
  }, 120);
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

init();
