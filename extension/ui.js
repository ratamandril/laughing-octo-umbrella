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
const BROWSER_NAMES = { chrome: 'Chrome', edge: 'Edge' };

function profileLabel(profile) {
  return (BROWSER_NAMES[profile.browser] || 'Navegador') + ' · ' + profile.name;
}

// profiles: lista de perfiles de la app (null si la extensión no está conectada).
// onOpen: abrir la nota en su navegador y perfil (solo se ofrece si es de otro perfil).
function noteCard(note, { mode = 'normal', palette = [], onEdit, onDelete, onTag, onCycle, showUrl = false, profiles = null, myProfileId = null, onOpen = null }) {
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

  const actions = el('span', { class: 'actions' },
    foreign ? el('button', { class: 'link', title: 'Abrir en ' + profileLabel(profile), onclick: () => onOpen(note) }, 'Abrir en su perfil') : null,
    el('button', { class: 'link', onclick: () => onEdit(note) }, 'Editar'),
    el('button', { class: 'link danger', onclick: () => onDelete(note) }, 'Eliminar')
  );

  const tags = note.tags.length
    ? el('div', { class: 'tags' }, ...note.tags.map((t) =>
        el('button', { class: 'chip', onclick: () => onTag && onTag(t) }, '#' + t)))
    : null;

  const scopeLabel = note.scope === 'domain' ? 'Sitio: ' + note.host : 'Página';
  const urlLink = showUrl
    ? el('a', { href: note.url, target: '_blank', rel: 'noopener', class: 'url' }, note.url)
    : null;

  if (mode === 'simple') {
    card.append(el('div', { class: 'simple-row' }, el('strong', { class: 't' }, note.title), actions));
    return card;
  }

  card.append(el('div', { class: 'card-head' },
    el('strong', {}, note.title),
    el('span', { class: 'badge' }, scopeLabel)
  ));
  if (profile) card.append(el('div', { class: 'profile-line muted' }, profileLabel(profile) + (note.profileId === myProfileId ? ' (este perfil)' : '')));

  if (mode === 'detailed' && cat) {
    card.append(el('div', { class: 'cat' },
      el('span', { class: 'dot' }), // el color ya va en el borde; el punto lo repite
      el('b', {}, cat.name), cat.info ? ' — ' + cat.info : ''));
    card.querySelector('.dot').style.background = cat.hex;
  }

  if (note.description) card.append(el('p', { class: 'desc' }, note.description));
  if (urlLink) card.append(urlLink);
  if (tags) card.append(tags);

  const dates = mode === 'detailed'
    ? 'Creada ' + fmtDate(note.createdAt) + ' · Editada ' + fmtDate(note.updatedAt)
    : fmtDate(note.updatedAt);
  card.append(el('div', { class: 'card-foot' }, el('span', { class: 'muted' }, dates), actions));
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
