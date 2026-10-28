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
  const target = pairing.profileId && current ? current.registeredProfiles.find((p) => p.id === pairing.profileId) : null;
  $('#codeFor').textContent = target ? `Para la cuenta «${target.name}»` : pairing.create ? `Para una cuenta nueva: «${pairing.create.name}»` : '';
  const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
  $('#countdown').textContent = `Caduca en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

const NEW_ACCOUNT = '__new';
let pairOptionsSig = '';
// Lista de cuentas para elegir al generar el código; no se rehace si no cambió (para no cerrar el desplegable)
function renderPairForm(state) {
  const sel = $('#pairAccount');
  const sig = JSON.stringify(state.registeredProfiles.map((p) => [p.id, p.name, p.email]));
  if (sig !== pairOptionsSig) {
    const keep = sel.value;
    pairOptionsSig = sig;
    sel.replaceChildren(...state.registeredProfiles.map((p) => new Option(accountLabel(p), p.id)), new Option('Nueva cuenta…', NEW_ACCOUNT));
    const known = [...sel.options].some((o) => o.value === keep);
    sel.value = known ? keep : (state.registeredProfiles[0] ? state.registeredProfiles[0].id : NEW_ACCOUNT);
  }
  $('#newAccount').hidden = sel.value !== NEW_ACCOUNT;
}

const accountLabel = (p) => (p.email ? `${p.name} (${p.email})` : p.name);

const SHARING_TEXT = [
  ['private', 'Privado (los demás no las ven)'],
  ['read', 'Compartido, solo lectura'],
  ['edit', 'Compartido, otros pueden editar'],
];

function renderInstances(instances, current) {
  const list = $('#instances');
  list.replaceChildren();
  $('#noInstances').hidden = instances.length > 0;
  for (const instance of instances) {
    const row = el('div', 'row');
    const dot = el('span', 'dot' + (instance.online ? ' on' : ''));
    dot.title = instance.online ? 'Conectada ahora' : 'Desconectada';

    const info = el('div', 'grow');
    const profile = instance.profile;
    const title = `${BROWSER_NAMES[instance.browser] || 'Navegador'} · ${profile ? profile.name : 'sin cuenta asignada'}`;
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

    // Cuenta de esta extensión (se puede cambiar sin volver a emparejar)
    const access = el('div', 'access');
    access.append(el('span', '', 'Cuenta:'));
    const sel = document.createElement('select');
    if (!instance.profileId) sel.append(new Option('— sin cuenta —', ''));
    for (const p of current.registeredProfiles) sel.append(new Option(accountLabel(p), p.id));
    sel.value = instance.profileId || '';
    sel.addEventListener('change', async () => {
      if (!sel.value) return;
      const target = current.registeredProfiles.find((p) => p.id === sel.value);
      if (window.confirm(`¿Pasar esta extensión a la cuenta «${target.name}»? Mostrará y guardará las notas de esa cuenta.`)) {
        await window.notasApp.assignInstance(instance.id, sel.value);
      }
      refresh();
    });
    access.append(sel);
    if (!instance.profileId) access.append(el('span', '', 'Hasta que tenga una cuenta no recibe notas.'));
    list.append(access);
  }
}

// ---------- Cuentas ----------
// Menú flotante de acciones (una sola instancia)
let accMenu = null;
function closeAccMenu() {
  if (accMenu) { accMenu.remove(); accMenu = null; }
}
document.addEventListener('click', (e) => { if (accMenu && !accMenu.contains(e.target) && !e.target.closest('.acc-menu-btn')) closeAccMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeAccMenu(); });
window.addEventListener('resize', closeAccMenu);

function showAccMenu(button, items) {
  closeAccMenu();
  const menu = el('div', 'menu');
  menu.setAttribute('role', 'menu');
  for (const item of items) {
    if (item.separator) { menu.append(el('div', 'menu-sep')); continue; }
    const b = el('button', 'menu-item' + (item.danger ? ' danger' : ''), item.label);
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', () => { closeAccMenu(); item.onclick(); });
    menu.append(b);
  }
  document.body.append(menu);
  const r = button.getBoundingClientRect();
  const left = Math.max(4, Math.min(window.innerWidth - menu.offsetWidth - 4, r.right - menu.offsetWidth));
  const below = window.innerHeight - r.bottom - 6;
  const top = below >= menu.offsetHeight || r.top < menu.offsetHeight ? r.bottom + 2 : r.top - menu.offsetHeight - 2;
  menu.style.left = left + 'px';
  menu.style.top = Math.max(4, top) + 'px';
  accMenu = menu;
  menu.querySelector('button').focus();
}

// Ventana de diálogo: body es un nodo; onOk() devuelve un texto de error para quedarse abierta, o nada para cerrar
function openDialog(title, body, { okText = 'Guardar', danger = false, onOk } = {}) {
  const dlg = $('#accDlg');
  $('#accDlgTitle').textContent = title;
  $('#accDlgBody').replaceChildren(body);
  const ok = $('#accDlgOk');
  ok.textContent = okText;
  ok.className = danger ? 'primary danger-fill' : 'primary';
  $('#accDlgError').textContent = '';
  ok.onclick = async () => {
    ok.disabled = true;
    try {
      const error = await onOk();
      if (error) { $('#accDlgError').textContent = error; return; }
      dlg.close();
    } finally {
      ok.disabled = false;
    }
    accountsSig = '';
    refresh();
  };
  $('#accDlgCancel').onclick = () => dlg.close();
  dlg.showModal();
}

function field(label, input) {
  const wrap = el('label', 'dlg-field');
  wrap.append(el('span', '', label), input);
  return wrap;
}

function detectedLabel(d, registered, selfId) {
  const owner = d.boundTo && d.boundTo !== selfId ? registered.find((r) => r.id === d.boundTo) : null;
  return `${BROWSER_NAMES[d.browser] || d.browser} · ${d.name}${d.email ? ' (' + d.email + ')' : ''}${owner ? ' · ahora de «' + owner.name + '»' : ''}`;
}

function editAccountDialog(profile) {
  const body = el('div', 'dlg-stack');
  const name = document.createElement('input');
  name.value = profile.name; name.maxLength = 60;
  const mail = document.createElement('input');
  mail.type = 'email'; mail.value = profile.email || ''; mail.placeholder = 'opcional';
  body.append(field('Nombre', name), field('Correo (solo una etiqueta para reconocerla)', mail));
  openDialog('Editar cuenta', body, {
    onOk: async () => {
      const r = await window.notasApp.updateProfile(profile.id, { name: name.value.trim(), email: mail.value.trim() });
      return r && r.error ? 'Revisa el nombre y el correo.' : '';
    },
  });
}

function bindAccountDialog(profile, detected, registered) {
  const body = el('div', 'dlg-stack');
  const bind = document.createElement('select');
  bind.append(new Option('— sin enlace en esta PC —', ''));
  for (const d of detected) bind.append(new Option(detectedLabel(d, registered, profile.id), `${d.browser}|${d.dir}`));
  bind.value = profile.binding ? `${profile.binding.browser}|${profile.binding.dir}` : '';
  body.append(field('Los links de esta cuenta se abren con este perfil de navegador de esta PC', bind));
  body.append(el('p', 'muted', 'Solo vale en esta PC y no se sube a la nube. Si ese perfil ya estaba enlazado a otra cuenta, pasa a esta.'));
  openDialog('Enlazar con un perfil de navegador', body, {
    onOk: async () => {
      const [browser, dir] = bind.value ? bind.value.split('|') : ['', ''];
      const r = await window.notasApp.bindProfile(profile.id, browser, dir);
      return r && r.error ? 'Ese perfil de navegador ya no se detecta.' : '';
    },
  });
}

function shareAccountDialog(profile) {
  const body = el('div', 'dlg-stack');
  const share = document.createElement('select');
  for (const [value, text] of SHARING_TEXT) share.append(new Option(text, value));
  share.value = profile.sharing || 'read';
  body.append(field('Qué pueden hacer las otras cuentas con las notas de «' + profile.name + '»', share));
  openDialog('Compartir notas', body, { onOk: async () => { await window.notasApp.setSharing(profile.id, share.value); return ''; } });
}

function mergeAccountDialog(profile, registered) {
  const body = el('div', 'dlg-stack');
  const pick = document.createElement('select');
  for (const other of registered.filter((o) => o.id !== profile.id)) pick.append(new Option(accountLabel(other), other.id));
  body.append(field('Unir «' + profile.name + '» con', pick));
  body.append(el('p', 'muted', 'Todas sus notas y extensiones pasan a la cuenta elegida y «' + profile.name + '» deja de existir (también en los demás equipos al sincronizar).'));
  openDialog('Unir con otra cuenta', body, {
    okText: 'Unir',
    onOk: async () => { await window.notasApp.mergeProfiles(profile.id, pick.value); return ''; },
  });
}

async function deleteAccountDialog(profile, registered) {
  const impact = await window.notasApp.profileImpact(profile.id);
  if (!impact) { flash('Esa cuenta ya no existe.', true); accountsSig = ''; refresh(); return; }
  const others = registered.filter((o) => o.id !== profile.id);
  const body = el('div', 'dlg-stack');
  body.append(el('p', '', `Vas a eliminar «${profile.name}». Esto es lo que se ve afectado; decide qué hacer en cada punto:`));

  const mk = (name, value, text, checked) => {
    const label = el('label', 'dlg-radio');
    const input = document.createElement('input');
    input.type = 'radio'; input.name = name; input.value = value; input.checked = !!checked;
    label.append(input, el('span', '', text));
    return { label, input };
  };
  const target = document.createElement('select');
  for (const o of others) target.append(new Option(accountLabel(o), o.id));
  target.disabled = true;

  // Notas
  const nCount = impact.notes + (impact.trashed ? ` (y ${impact.trashed} en la papelera)` : '');
  const notesBox = el('fieldset', 'dlg-group');
  notesBox.append(el('legend', '', `Notas: ${nCount}`));
  const nTrash = mk('dn', 'trash', 'Mandarlas a la papelera (se pueden restaurar 30 días)', true);
  notesBox.append(nTrash.label);
  let nMove = null;
  if (others.length) {
    nMove = mk('dn', 'move', 'Pasarlas a otra cuenta:');
    notesBox.append(nMove.label);
  }
  if (impact.notes || impact.trashed) body.append(notesBox);

  // Extensiones
  const iBox = el('fieldset', 'dlg-group');
  let iUn = null; let iRev = null; let iMove = null;
  if (impact.instances.length) {
    iBox.append(el('legend', '', `Extensiones emparejadas: ${impact.instances.map((i) => i.label || i.browser).join(', ')}`));
    iUn = mk('di', 'unassign', 'Dejarlas sin cuenta (no reciben notas hasta que les asignes una)', true);
    iRev = mk('di', 'revoke', 'Desconectarlas de la app (habrá que emparejarlas de nuevo)');
    iBox.append(iUn.label, iRev.label);
    if (others.length) { iMove = mk('di', 'move', 'Pasarlas a otra cuenta:'); iBox.append(iMove.label); }
    body.append(iBox);
  }
  if (nMove || iMove) body.append(field('Cuenta de destino', target));
  const syncTarget = () => { target.disabled = !((nMove && nMove.input.checked) || (iMove && iMove.input.checked)); };
  for (const r of [nTrash, nMove, iUn, iRev, iMove]) if (r) r.input.addEventListener('change', syncTarget);

  const extra = [];
  if (impact.binding) extra.push('El enlace con el perfil de navegador de esta PC se quita.');
  extra.push('La cuenta se elimina también en los demás equipos al sincronizar con la nube.');
  body.append(el('p', 'muted', extra.join(' ')));

  openDialog('Eliminar cuenta', body, {
    okText: 'Eliminar cuenta',
    danger: true,
    onOk: async () => {
      const notes = nMove && nMove.input.checked ? 'move' : 'trash';
      const instances = iMove && iMove.input.checked ? 'move' : iRev && iRev.input.checked ? 'revoke' : 'unassign';
      const r = await window.notasApp.deleteProfile(profile.id, { notes, instances, moveTo: target.disabled ? null : target.value });
      if (r && r.error) return r.error === 'invalid_target' ? 'Elige la cuenta de destino.' : 'No se pudo eliminar la cuenta.';
      flash(`Cuenta «${profile.name}» eliminada.`);
      return '';
    },
  });
}

let accountsSig = '';
let accountsFilter = 'all';
$('#accFilter').addEventListener('change', () => { accountsFilter = $('#accFilter').value; accountsSig = ''; refresh(); });
function renderProfiles(detected, registered) {
  // Solo se redibuja si cambió algo
  const sig = JSON.stringify([detected, registered, accountsFilter]);
  if (sig === accountsSig) return;
  accountsSig = sig;
  const list = $('#profiles');
  list.replaceChildren();
  $('#noProfiles').hidden = registered.length > 0;
  $('#accFilter').hidden = registered.length < 2;
  const linkedCount = registered.filter((p) => p.binding).length;
  $('#accSummary').textContent = registered.length ? `${linkedCount} enlazada${linkedCount === 1 ? '' : 's'} · ${registered.length - linkedCount} sin enlazar` : '';
  const shown = registered.filter((p) => accountsFilter === 'all' || (accountsFilter === 'linked' ? p.binding : !p.binding));
  if (registered.length && !shown.length) list.append(el('p', 'muted', 'Ninguna cuenta coincide con el filtro.'));

  for (const profile of shown) {
    const row = el('div', 'row acct');
    const info = el('div', 'grow');
    const head = el('div', 'acct-head');
    head.append(el('span', 'strong', profile.name));
    const linked = !!profile.binding;
    const det = linked ? detected.find((d) => d.browser === profile.binding.browser && d.dir === profile.binding.dir) : null;
    const badge = linked
      ? el('span', det ? 'tag ok' : 'tag warn', det ? `Enlazada · ${BROWSER_NAMES[det.browser] || det.browser} · ${det.name}` : 'Enlazada a un perfil que ya no existe')
      : el('span', 'tag warn', 'Sin enlazar');
    badge.title = linked ? 'Sus links se abren con ese perfil de navegador en esta PC' : 'No se puede «Abrir en su perfil» hasta enlazarla con un perfil de navegador de esta PC';
    head.append(badge);
    if (profile.sharing && profile.sharing !== 'read') head.append(el('span', 'tag', profile.sharing === 'private' ? 'Privada' : 'Editable por otros'));
    info.append(head);
    info.append(el('div', 'muted', [profile.email || 'sin correo', `${profile.notes} ${profile.notes === 1 ? 'nota' : 'notas'}`, `${profile.instances} ${profile.instances === 1 ? 'extensión' : 'extensiones'}`].join(' · ')));
    row.append(info);

    const more = el('button', 'ghost small acc-menu-btn', 'Acciones ▾');
    more.type = 'button';
    more.setAttribute('aria-haspopup', 'menu');
    more.addEventListener('click', () => {
      if (accMenu) return closeAccMenu();
      const items = [
        { label: 'Editar nombre y correo…', onclick: () => editAccountDialog(profile) },
        { label: linked ? 'Cambiar el perfil enlazado…' : 'Enlazar con un perfil de navegador…', onclick: () => bindAccountDialog(profile, detected, registered) },
      ];
      if (linked) items.push({ label: 'Quitar el enlace', onclick: async () => { await window.notasApp.bindProfile(profile.id, '', ''); accountsSig = ''; refresh(); } });
      items.push({ label: 'Compartir notas…', onclick: () => shareAccountDialog(profile) });
      if (registered.length > 1) items.push({ label: 'Unir con otra cuenta…', onclick: () => mergeAccountDialog(profile, registered) });
      items.push({ separator: true }, { label: 'Eliminar cuenta…', danger: true, onclick: () => deleteAccountDialog(profile, registered) });
      showAccMenu(more, items);
    });
    row.append(more);
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
  renderPairForm(state);
  renderInstances(state.instances, state);
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
  return p ? accountLabel(p) : 'Sin cuenta';
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
  fp.replaceChildren(new Option('Todas las cuentas', ''), ...notesData.profiles.map((p) => new Option(profileName(p.id), p.id)), new Option('Sin cuenta', 'none'));
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
    pick.append(new Option('Asignar cuenta…', ''), ...notesData.profiles.map((p) => new Option(profileName(p.id), p.id)));
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

$('#pairAccount').addEventListener('change', () => { $('#newAccount').hidden = $('#pairAccount').value !== NEW_ACCOUNT; });
$('#newCode').addEventListener('click', async () => {
  const choice = $('#pairAccount').value;
  if (choice === NEW_ACCOUNT) {
    const name = $('#newName').value.trim();
    if (!name) return flash('Escribe un nombre para la cuenta nueva.', true);
    await window.notasApp.newPairingCode({ create: { name, email: $('#newEmail').value.trim() } });
    $('#newName').value = '';
    $('#newEmail').value = '';
  } else {
    await window.notasApp.newPairingCode({ profileId: choice });
  }
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
