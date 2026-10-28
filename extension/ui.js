// Utilidades de interfaz (sin innerHTML: el texto de las notas nunca se interpreta como HTML)
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c);
  }
  return node;
}

function fmtDate(ts) {
  return new Date(ts).toLocaleDateString('es-PE', { day: '2-digit', month: 'short', year: 'numeric' });
}

function colorOf(palette, id) {
  return palette.find((c) => c.id === id) || null;
}

// Selector de categoría (colores). Se redibuja solo al elegir.
function swatchPicker(box, palette, selected, onChange) {
  box.replaceChildren();
  const make = (id, hex, label) => {
    const b = el('button', {
      type: 'button',
      class: 'swatch' + (selected === id ? ' sel' : ''),
      title: label,
      onclick: () => { onChange(id); swatchPicker(box, palette, id, onChange); },
    });
    if (hex) b.style.background = hex; else b.textContent = '∅';
    return b;
  };
  box.append(make(null, null, 'Sin categoría'));
  for (const c of palette) box.append(make(c.id, c.hex, c.name + (c.info ? ' — ' + c.info : '')));
}

// mode: "simple" | "normal" | "detailed"

function profileLabel(profile, withEmail = false) {
  return profile.name + (withEmail && profile.email ? ' · ' + profile.email : '');
}

// ---------- Menú "Opciones" de cada nota ----------
let openMenu = null;
const menuIsOpen = () => !!openMenu; // mientras hay un menú abierto no se redibuja la lista (lo cerraría)

function closeMenu({ focusButton = false } = {}) {
  if (!openMenu) return;
  const { menu, button } = openMenu;
  openMenu = null;
  menu.remove();
  button.setAttribute('aria-expanded', 'false');
  if (focusButton) button.focus();
}

document.addEventListener('click', (e) => {
  if (openMenu && !openMenu.menu.contains(e.target) && e.target !== openMenu.button) closeMenu();
});
document.addEventListener('keydown', (e) => {
  if (openMenu && e.key === 'Escape') { e.stopPropagation(); closeMenu({ focusButton: true }); }
}, true);
// Chrome dispara scroll/resize justo al abrir (al enfocar el menú o al ajustar el tamaño del popup): se ignoran un instante
const justOpened = () => openMenu && Date.now() - openMenu.at < 500;
window.addEventListener('scroll', (e) => {
  if (!openMenu || justOpened()) return;
  if (e.target instanceof Node && openMenu.menu.contains(e.target)) return; // el scroll del propio menú no lo cierra
  // Solo se cierra si el botón se desplazó de verdad (así el menú no queda flotando lejos de él)
  const r = openMenu.button.getBoundingClientRect();
  if (Math.abs(r.top - openMenu.top) > 1 || Math.abs(r.left - openMenu.left) > 1) closeMenu();
}, true);
window.addEventListener('resize', () => { if (!justOpened()) closeMenu(); });

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el('textarea', { style: 'position:fixed;opacity:0' });
    area.value = text;
    document.body.append(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

// items: [{ label, onclick, danger, checked, separator }]
function showMenu(button, items) {
  closeMenu();
  const menu = el('div', { class: 'menu', role: 'menu' });
  for (const item of items) {
    if (item.separator) { menu.append(el('div', { class: 'menu-sep', role: 'separator' })); continue; }
    const b = el('button', {
      type: 'button', role: item.checked === undefined ? 'menuitem' : 'menuitemradio',
      class: 'menu-item' + (item.danger ? ' danger' : ''),
      onclick: () => { closeMenu(); item.onclick(); },
    }, item.checked === undefined ? '' : (item.checked ? '● ' : '○ '), item.label);
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(!!item.checked));
    menu.append(b);
  }
  document.body.append(menu);

  // Se coloca junto al botón, dentro de la ventana, hacia abajo o hacia arriba según el espacio
  const r = button.getBoundingClientRect();
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  const left = Math.max(4, Math.min(window.innerWidth - mw - 4, r.right - mw));
  const below = window.innerHeight - r.bottom - 6;
  const top = below >= mh || r.top < mh ? r.bottom + 2 : r.top - mh - 2;
  menu.style.left = left + 'px';
  menu.style.top = Math.max(4, Math.min(window.innerHeight - mh - 4, top)) + 'px';

  openMenu = { menu, button, top: r.top, left: r.left, at: Date.now() };
  button.setAttribute('aria-expanded', 'true');
  const buttons = [...menu.querySelectorAll('button')];
  buttons[0].focus({ preventScroll: true });
  menu.addEventListener('keydown', (e) => {
    const i = buttons.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); buttons[(i + 1) % buttons.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); buttons[(i - 1 + buttons.length) % buttons.length].focus(); }
    else if (e.key === 'Tab') closeMenu();
  });
}

const VIEW_LABELS = { simple: 'Vista simple', normal: 'Vista normal', detailed: 'Vista detallada' };

// mode: "simple" | "normal" | "detailed"
// profiles: perfiles que esta extensión puede ver (null si no se muestran). onOpen: abrir en su perfil (notas de otro perfil).
// onView(note, modo): cambiar la vista solo de esta nota. safety: null | 'app' | 'cloud' (aún no está a salvo).
function noteCard(note, { mode = 'normal', palette = [], onEdit, onDelete, onTag, onCycle, onView, showUrl = false, profiles = null, myProfileId = null, onOpen = null, safety = null, onNotice = null }) {
  const profile = profiles && note.profileId ? profiles.find((p) => p.id === note.profileId) || null : null;
  const foreign = !!(profile && onOpen && note.profileId !== myProfileId);
  const cat = colorOf(palette, note.color);
  const card = el('article', { class: 'card mode-' + mode });
  if (cat) card.style.borderLeftColor = cat.hex;
  if (cat) card.title = cat.name + (cat.info ? ' — ' + cat.info : '');

  // Clic sobre la nota (fuera de botones, enlaces o texto seleccionado) = pasar a la siguiente vista
  if (onCycle) {
    card.classList.add('clickable');
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.title = (card.title ? card.title + ' · ' : '') + 'Clic para cambiar la vista de esta nota';
    card.addEventListener('click', (e) => {
      if (e.target.closest('button, a')) return;
      if (String(window.getSelection())) return;
      onCycle(note);
    });
    card.addEventListener('keydown', (e) => {
      if (e.target === card && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onCycle(note); }
    });
  }

  const menuBtn = el('button', {
    type: 'button', class: 'icon-btn menu-btn', title: 'Opciones', 'aria-label': 'Opciones de la nota',
    'aria-haspopup': 'menu', 'aria-expanded': 'false',
  }, '⋯');
  menuBtn.addEventListener('click', () => {
    if (openMenu && openMenu.button === menuBtn) return closeMenu();
    const items = [
      { label: 'Abrir página', onclick: () => chrome.tabs.create({ url: note.url }) },
    ];
    if (foreign) {
      // Sin enlace local la app no sabe con qué perfil de navegador abrirla: se avisa en vez de fallar al pulsar
      if (profile.linked === false) items.push({ label: 'Abrir en su perfil: cuenta sin enlazar en esta PC', onclick: () => onOpen(note) });
      else items.push({ label: 'Abrir en su perfil (' + profileLabel(profile) + ')', onclick: () => onOpen(note) });
    }
    items.push({ label: 'Copiar URL', onclick: async () => { const ok = await copyText(note.url); if (onNotice) onNotice(ok ? 'URL copiada.' : 'No se pudo copiar.', !ok); } });
    if (onEdit) {
      items.push({ separator: true });
      items.push({ label: 'Editar', onclick: () => onEdit(note) });
    }
    if (onView) {
      items.push({ separator: true });
      for (const m of ['simple', 'normal', 'detailed']) items.push({ label: VIEW_LABELS[m], checked: m === mode, onclick: () => onView(note, m) });
    }
    if (onDelete) {
      items.push({ separator: true });
      items.push({ label: 'Eliminar', danger: true, onclick: () => onDelete(note) });
    }
    showMenu(menuBtn, items);
  });
  const actions = el('span', { class: 'actions' }, menuBtn);

  const safetyBadge = safety
    ? el('span', { class: 'safety', title: safety === 'app' ? 'Todavía no se envió a la app' : 'La app aún no la subió a la nube' },
        safety === 'app' ? '⏳ sin enviar a la app' : '☁ sin subir a la nube')
    : null;

  const tags = note.tags.length
    ? el('div', { class: 'tags' }, ...note.tags.map((t) =>
        el('button', { class: 'chip', onclick: () => onTag && onTag(t) }, '#' + t)))
    : null;

  const scopeLabel = note.scope === 'domain' ? 'Sitio: ' + note.host : 'Página';
  const urlLink = showUrl
    ? el('a', { href: note.url, target: '_blank', rel: 'noopener', class: 'url' }, note.url)
    : null;

  if (mode === 'simple') {
    card.append(el('div', { class: 'simple-row' }, el('strong', { class: 't' }, note.title), safetyBadge, actions));
    return card;
  }

  card.append(el('div', { class: 'card-head' },
    el('strong', {}, note.title),
    el('span', { class: 'badge' }, scopeLabel)
  ));

  if (mode === 'detailed' && cat) {
    card.append(el('div', { class: 'cat' },
      el('span', { class: 'dot' }), // el color ya va en el borde; el punto lo repite
      el('b', {}, cat.name), cat.info ? ' — ' + cat.info : ''));
    card.querySelector('.dot').style.background = cat.hex;
  }

  if (profile) card.append(el('div', { class: 'profile-line muted' }, profileLabel(profile, true) + (note.profileId === myProfileId ? ' (este perfil)' : '')));
  if (note.description) card.append(el('p', { class: 'desc' }, note.description));
  if (urlLink) card.append(urlLink);
  if (tags) card.append(tags);

  const dates = mode === 'detailed'
    ? 'Creada ' + fmtDate(note.createdAt) + ' · Editada ' + fmtDate(note.updatedAt)
    : fmtDate(note.updatedAt);
  card.append(el('div', { class: 'card-foot' }, el('span', { class: 'muted' }, dates, safetyBadge), actions));
  return card;
}

// Abre una página de la extensión en una pestaña. Si ya hay una abierta, la enfoca
// en lugar de crear otra. No usa runtime.openOptionsPage(), que en algunos
// navegadores falla con "Could not create an options page".
async function openPage(file) {
  const url = chrome.runtime.getURL(file);
  try {
    const [existing] = await chrome.tabs.query({ url });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch { /* si la búsqueda falla, se abre una pestaña nueva */ }
  await chrome.tabs.create({ url });
}
