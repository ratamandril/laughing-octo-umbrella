'use strict';

// Interfaz de la app. Todo el texto se inserta con textContent: nunca se interpreta como HTML.
const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BROWSER_NAMES = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', other: 'Navegador' };
let current = null;
let tick = null;
let keyError = ''; // error al elegir la clave (no viene del estado del servidor)

function ago(timestamp) {
  if (!timestamp) return 'sin actividad desde que se abrió la app';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'hace unos segundos';
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  return `hace ${Math.round(seconds / 3600)} h`;
}

function renderPairing(pairing) {
  const box = $('#codeBox');
  $('#cancelCode').hidden = !pairing;
  $('#newCode').textContent = pairing ? 'Generar otro código' : 'Generar código';
  box.hidden = !pairing;
  if (!pairing) return;
  $('#code').textContent = pairing.code;
  const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
  $('#countdown').textContent = `Caduca en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function renderInstances(instances) {
  const list = $('#instances');
  list.replaceChildren();
  $('#noInstances').hidden = instances.length > 0;
  for (const instance of instances) {
    const row = el('div', 'row');
    const dot = el('span', 'dot' + (instance.online ? ' on' : ''));
    dot.title = instance.online ? 'Conectada ahora' : 'Desconectada';

    const info = el('div', 'grow');
    const profile = instance.profile;
    const title = profile
      ? `${BROWSER_NAMES[profile.browser] || 'Navegador'} · ${profile.name}`
      : `${BROWSER_NAMES[instance.browser] || 'Navegador'} · sin perfil asignado`;
    info.append(el('div', 'strong', title));
    const detail = [profile && profile.email, instance.online ? 'conectada' : `última vez ${ago(instance.lastSeen)}`]
      .filter(Boolean)
      .join(' · ');
    info.append(el('div', 'muted', detail));

    const revoke = el('button', 'danger', 'Revocar');
    revoke.addEventListener('click', async () => {
      if (window.confirm(`¿Revocar el acceso de "${title}"? Tendrá que emparejarse de nuevo.`)) {
        await window.notasApp.revokeInstance(instance.id);
        refresh();
      }
    });
    row.append(dot, info, revoke);
    list.append(row);

    // Permiso para ver notas de otros perfiles (por defecto, ninguno)
    const others = (current ? current.registeredProfiles : []).filter((p) => p.id !== instance.profileId);
    if (instance.profileId && others.length) {
      const access = el('div', 'access');
      access.append(el('span', '', 'Puede ver también las notas de:'));
      for (const other of others) {
        const label = el('label');
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = (instance.canSee || []).includes(other.id);
        box.addEventListener('change', async () => {
          const ids = [...access.querySelectorAll('input')].filter((i) => i.checked).map((i) => i.dataset.id);
          await window.notasApp.setAccess(instance.id, ids);
        });
        box.dataset.id = other.id;
        label.append(box, el('span', '', `${BROWSER_NAMES[other.browser] || other.browser} · ${other.name}`));
        access.append(label);
      }
      list.append(access);
    } else if (!instance.profileId) {
      list.append(el('div', 'access', 'Hasta que elija su perfil, esta extensión no recibe notas.'));
    }
  }
}

function renderProfiles(detected, registered) {
  const list = $('#profiles');
  list.replaceChildren();
  $('#noProfiles').hidden = detected.length > 0;
  for (const profile of detected) {
    const assigned = registered.some((r) => r.browser === profile.browser && r.dir === profile.dir);
    const row = el('div', 'row');
    const info = el('div', 'grow');
    info.append(el('div', 'strong', `${BROWSER_NAMES[profile.browser] || profile.browser} · ${profile.name}`));
    info.append(el('div', 'muted', [profile.dir, profile.email].filter(Boolean).join(' · ')));
    row.append(info, el('span', 'tag' + (assigned ? ' ok' : ''), assigned ? 'asignado' : 'libre'));
    list.append(row);
  }
}

const SYNC_TEXT = {
  disabled: 'Sin configurar. Tus notas solo están en este equipo. Elige la clave JSON de una cuenta de servicio de Firebase para guardar una copia en la nube.',
  connecting: 'Conectando con Firestore…',
  online: 'Conectado. Las notas se copian en la nube al instante y se reciben los cambios de otros equipos.',
  offline: 'Sin conexión con Firestore. Los cambios se acumulan y se subirán al volver; se reintenta solo.',
  stopped: 'Detenido.',
};

function renderSync(sync) {
  const enabled = sync.state !== 'disabled';
  const parts = [SYNC_TEXT[sync.state] || ''];
  if (enabled && sync.projectId) parts.push(`Proyecto: ${sync.projectId}.`);
  if (enabled) parts.push(`Pendientes: ${sync.pending}.`);
  if (enabled && sync.lastSync) parts.push(`Última subida ${ago(sync.lastSync)}.`);
  $('#syncText').textContent = parts.filter(Boolean).join(' ');
  $('#chooseKey').textContent = enabled ? 'Cambiar clave…' : 'Elegir clave…';
  $('#syncNow').hidden = !enabled;
  $('#disableSync').hidden = !enabled;
  const error = $('#syncError');
  const message = keyError || sync.lastError || '';
  error.hidden = !message;
  error.textContent = message;
}

function renderCloud(sync) {
  const pill = $('#cloud');
  pill.hidden = false;
  let text = 'Nube sin configurar';
  let cls = 'pill';
  if (sync.state === 'online') {
    text = sync.pending ? `Nube: subiendo ${sync.pending}…` : 'Nube al día';
    cls = sync.pending ? 'pill warn' : 'pill on';
  } else if (sync.state === 'offline') {
    text = sync.pending ? `Sin internet · ${sync.pending} sin subir` : 'Sin conexión con la nube';
    cls = 'pill bad';
  } else if (sync.state === 'connecting') {
    text = 'Conectando con la nube…';
  }
  pill.textContent = text;
  pill.className = cls;
}

function renderSummary(state) {
  const warnings = state.loadWarnings.length ? ` · ${state.loadWarnings.length} nota(s) descartadas al cargar` : '';
  $('#summary').textContent = `${state.notes} nota(s) · cambio nº ${state.seq}${warnings}`;
}

function render(state) {
  current = state;
  const status = $('#status');
  status.textContent = state.running ? `En ejecución · 127.0.0.1:${state.port}` : 'Detenido';
  status.className = 'pill' + (state.running ? ' on' : '');
  renderPairing(state.pairing);
  renderInstances(state.instances);
  renderProfiles(state.detectedProfiles, state.registeredProfiles);
  renderSync(state.sync);
  renderCloud(state.sync);
  const badge = $('#trashBadge');
  badge.hidden = !state.trashCount;
  badge.textContent = state.trashCount;
  if (activeTab === 'notas') scheduleNotes();
  if (activeTab === 'papelera') renderTrash(state);
  renderSummary(state);
}

// ---------- pestañas ----------
let activeTab = 'conexion';
function showTab(name) {
  activeTab = name;
  for (const button of document.querySelectorAll('.tab-btn')) {
    const on = button.dataset.tab === name;
    button.classList.toggle('active', on);
    button.setAttribute('aria-selected', String(on));
  }
  for (const panel of document.querySelectorAll('.tab')) panel.hidden = panel.id !== 'tab-' + name;
  if (name === 'notas') loadNotes();
  if (name === 'papelera') renderTrash(current);
}
for (const button of document.querySelectorAll('.tab-btn')) button.addEventListener('click', () => showTab(button.dataset.tab));

// ---------- notas de todos los perfiles ----------
let notesData = { notes: [], palette: [], profiles: [] };
const collapsed = new Set(JSON.parse(localStorage.getItem('collapsedHosts') || '[]'));
let notesTimer = null;

function profileName(id) {
  const p = notesData.profiles.find((x) => x.id === id);
  return p ? `${BROWSER_NAMES[p.browser] || p.browser} · ${p.name}` : 'Sin perfil';
}

function scheduleNotes() {
  clearTimeout(notesTimer);
  notesTimer = setTimeout(loadNotes, 300);
}

async function loadNotes() {
  notesData = await window.notasApp.listNotes();
  fillNoteFilters();
  renderNotes();
}

function fillNoteFilters() {
  const fp = $('#fProfile');
  const curP = fp.value;
  fp.replaceChildren(new Option('Todos los perfiles', ''), ...notesData.profiles.map((p) => new Option(profileName(p.id), p.id)), new Option('Sin perfil', 'none'));
  fp.value = [...fp.options].some((o) => o.value === curP) ? curP : '';
  const ft = $('#fTag');
  const curT = ft.value;
  const tags = new Map();
  for (const n of notesData.notes) for (const t of n.tags) tags.set(t, (tags.get(t) || 0) + 1);
  ft.replaceChildren(new Option('Todas las etiquetas', ''), ...[...tags].sort((a, b) => b[1] - a[1]).map(([t, c]) => new Option(`#${t} (${c})`, t)));
  ft.value = tags.has(curT) ? curT : '';
}

function noteMatches(n) {
  const q = $('#q').value.trim().toLowerCase();
  const prof = $('#fProfile').value;
  const tag = $('#fTag').value;
  if (prof && (prof === 'none' ? n.profileId : n.profileId !== prof)) return false;
  if (tag && !n.tags.includes(tag)) return false;
  return !q || [n.title, n.description, n.url, ...n.tags].some((t) => (t || '').toLowerCase().includes(q));
}

function saveCollapsed() {
  localStorage.setItem('collapsedHosts', JSON.stringify([...collapsed]));
}

function renderNotes() {
  const filtered = notesData.notes.filter(noteMatches);
  const searching = !!$('#q').value.trim();
  $('#notesCount').textContent = `${filtered.length} de ${notesData.notes.length} notas`;
  $('#noNotes').hidden = filtered.length > 0;

  const groups = new Map();
  for (const n of filtered) {
    if (!groups.has(n.host)) groups.set(n.host, []);
    groups.get(n.host).push(n);
  }
  const list = $('#notesList');
  list.replaceChildren();
  for (const [host, notes] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    const isCollapsed = collapsed.has(host) && !searching; // al buscar se abren los grupos con resultados
    const group = el('section', 'group' + (isCollapsed ? ' collapsed' : ''));
    const head = el('button', 'group-head');
    head.setAttribute('aria-expanded', String(!isCollapsed));
    head.append(el('span', 'chev', '▾'), el('span', '', host), el('span', 'muted', `(${notes.length})`));
    head.addEventListener('click', () => {
      if (collapsed.has(host)) collapsed.delete(host); else collapsed.add(host);
      saveCollapsed();
      renderNotes();
    });
    const body = el('div', 'group-body');
    for (const n of notes) body.append(noteRow(n));
    group.append(head, body);
    list.append(group);
  }
}

function noteRow(n) {
  const cat = notesData.palette.find((c) => c.id === n.color);
  const row = el('article', 'nrow');
  if (cat) row.style.borderLeftColor = cat.hex;
  row.append(el('div', 't', n.title));
  if (n.description) row.append(el('div', 'd', n.description.length > 300 ? n.description.slice(0, 300) + '…' : n.description));
  const meta = el('div', 'meta');
  meta.append(el('span', '', profileName(n.profileId)), el('span', '', n.scope === 'domain' ? 'Todo el sitio' : 'Página'));
  if (cat) meta.append(el('span', '', cat.name));
  for (const t of n.tags) meta.append(el('span', '', '#' + t));
  meta.append(el('span', '', new Date(n.updatedAt).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' })));

  const acts = el('span', 'acts');
  const open = el('button', 'link', 'Abrir en su perfil');
  open.disabled = !n.profileId;
  if (!n.profileId) open.title = 'Esta nota no tiene perfil: asígnale uno para poder abrirla';
  open.addEventListener('click', async () => {
    const res = await window.notasApp.openNote(n.id);
    flash(res.ok ? 'Abriendo…' : openError(res.error), !res.ok);
  });
  if (!n.profileId && notesData.profiles.length) {
    const pick = el('select');
    pick.setAttribute('aria-label', 'Perfil para esta nota');
    pick.append(new Option('Asignar perfil…', ''), ...notesData.profiles.map((p) => new Option(profileName(p.id), p.id)));
    pick.addEventListener('change', async () => {
      if (!pick.value) return;
      const done = await window.notasApp.assignNoteProfile(n.id, pick.value);
      flash(done ? 'Perfil asignado.' : 'No se pudo asignar el perfil.', !done);
      loadNotes();
    });
    acts.append(pick);
  }
  const copy = el('button', 'link', 'Copiar URL');
  copy.addEventListener('click', async () => flash((await window.notasApp.copyNoteUrl(n.id)) ? 'URL copiada.' : 'No se pudo copiar.'));
  const del = el('button', 'danger', 'A la papelera');
  del.addEventListener('click', async () => {
    await window.notasApp.deleteNote(n.id);
    loadNotes();
  });
  acts.append(open, copy, del);
  meta.append(acts);
  row.append(meta);
  return row;
}

const OPEN_ERRORS = {
  profile_missing: 'Ese perfil ya no existe en el equipo.',
  browser_not_found: 'No se encontró el navegador de ese perfil.',
  no_profile: 'La nota no tiene un perfil asignado.',
  unknown_profile: 'La app no conoce el perfil de esa nota.',
  too_many_opens: 'Demasiadas aperturas seguidas. Espera un momento.',
};
const openError = (code) => OPEN_ERRORS[code] || `No se pudo abrir (${code}).`;

let flashTimer = null;
function flash(text, bad = false) {
  const box = $('#summary');
  box.textContent = text;
  box.classList.toggle('err', bad);
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { box.classList.remove('err'); if (current) renderSummary(current); }, 3500);
}

for (const id of ['#q', '#fProfile', '#fTag']) $(id).addEventListener('input', renderNotes);
$('#collapseAll').addEventListener('click', () => {
  for (const n of notesData.notes) collapsed.add(n.host);
  saveCollapsed();
  renderNotes();
});
$('#expandAll').addEventListener('click', () => {
  collapsed.clear();
  saveCollapsed();
  renderNotes();
});

// ---------- papelera ----------
async function renderTrash(state) {
  const items = await window.notasApp.listTrash();
  $('#trashInfo').textContent = `Las notas borradas se conservan ${state ? state.trashDays : 30} días y luego se eliminan para siempre. Las extensiones no ven su contenido.`;
  $('#noTrash').hidden = items.length > 0;
  $('#emptyTrash').hidden = items.length === 0;
  const list = $('#trashList');
  list.replaceChildren();
  for (const n of items) {
    const row = el('article', 'nrow');
    row.append(el('div', 't', n.title));
    if (n.description) row.append(el('div', 'd', n.description.length > 200 ? n.description.slice(0, 200) + '…' : n.description));
    const meta = el('div', 'meta');
    meta.append(el('span', '', n.host), el('span', '', `Borrada ${new Date(n.deletedAt).toLocaleDateString('es-PE', { day: '2-digit', month: 'short' })}`));
    const acts = el('span', 'acts');
    const restore = el('button', 'link', 'Restaurar');
    restore.addEventListener('click', async () => { await window.notasApp.restoreNote(n.id); refresh(); });
    const purge = el('button', 'danger', 'Eliminar para siempre');
    purge.addEventListener('click', async () => {
      if (window.confirm(`¿Eliminar "${n.title}" para siempre? No se podrá recuperar.`)) {
        await window.notasApp.purgeNote(n.id);
        refresh();
      }
    });
    acts.append(restore, purge);
    meta.append(acts);
    row.append(meta);
    list.append(row);
  }
}
$('#emptyTrash').addEventListener('click', async () => {
  if (window.confirm('¿Vaciar la papelera? Las notas se eliminarán para siempre.')) {
    await window.notasApp.emptyTrash();
    refresh();
  }
});

async function refresh() {
  render(await window.notasApp.getState());
}

$('#newCode').addEventListener('click', async () => {
  await window.notasApp.newPairingCode();
  refresh();
});
$('#cancelCode').addEventListener('click', async () => {
  await window.notasApp.cancelPairing();
  refresh();
});
$('#chooseKey').addEventListener('click', async () => {
  const result = await window.notasApp.chooseSyncKey();
  if (!result.canceled) keyError = result.ok ? '' : result.error;
  refresh();
});
$('#syncNow').addEventListener('click', async () => {
  await window.notasApp.syncNow();
  refresh();
});
$('#disableSync').addEventListener('click', async () => {
  if (window.confirm('¿Quitar la clave? Dejará de haber copia en la nube; tus notas locales y las que ya están en Firestore no se borran.')) {
    await window.notasApp.disableSync();
    refresh();
  }
});
$('#openData').addEventListener('click', () => window.notasApp.openDataFolder());

window.notasApp.onState(render);
refresh();

// Cuenta atrás del código y "hace X min" de las instancias
tick = setInterval(() => {
  if (!current) return;
  if (current.pairing && Date.now() > current.pairing.expiresAt) refresh();
  else if (current.pairing) renderPairing(current.pairing);
}, 1000);
window.addEventListener('beforeunload', () => clearInterval(tick));
