// Capa de datos compartida (popup, páginas y service worker).
// Cada nota se guarda en su propia clave "n_<id>" para respetar el límite
// de 8 KB por elemento de chrome.storage.sync. La paleta y los ajustes
// van en claves aparte ("palette", "settings").
//
// Dos modos:
//  - Sin app: todo en chrome.storage.sync (como siempre).
//  - Conectada a la app (existe "link" en storage.local): las notas y la paleta se leen de una
//    caché en storage.local. Cada cambio se guarda en la caché y en una cola de salida ("outbox")
//    que el service worker envía a la app (ver sync.js). Los ajustes siguen en sync.
const NotesStore = (() => {
  const PREFIX = 'n_';
  const sync = chrome.storage.sync;
  const MAX_TAGS = 10;
  const MAX_COLORS = 12;

  const DEFAULT_PALETTE = [
    { id: 'c-rojo', name: 'Importante', hex: '#ef4444', info: 'Cosas que no debo olvidar' },
    { id: 'c-naranja', name: 'Pendiente', hex: '#f97316', info: 'Por hacer o revisar' },
    { id: 'c-amarillo', name: 'Idea', hex: '#eab308', info: 'Ideas y posibles proyectos' },
    { id: 'c-verde', name: 'Referencia', hex: '#22c55e', info: 'Material para consultar después' },
    { id: 'c-azul', name: 'Estudio', hex: '#3b82f6', info: 'Relacionado con lo que estoy aprendiendo' },
    { id: 'c-morado', name: 'Personal', hex: '#a855f7', info: '' },
  ];

  const isSupported = (url) => /^https?:/i.test(url || '');

  function normalizeUrl(url) {
    try {
      const u = new URL(url);
      u.hash = '';
      let s = u.href;
      if (s.endsWith('/')) s = s.slice(0, -1);
      return s;
    } catch {
      return url;
    }
  }

  function hostOf(url) {
    try { return new URL(url).hostname; } catch { return ''; }
  }

  // "a, B ,#c" -> ["a","b","c"]  (minúsculas, sin repetidos, máx. 10)
  function parseTags(input) {
    const list = Array.isArray(input) ? input : String(input || '').split(',');
    const out = [];
    for (const t of list) {
      const v = String(t).trim().toLowerCase().replace(/^#/, '').slice(0, 30);
      if (v && !out.includes(v)) out.push(v);
      if (out.length >= MAX_TAGS) break;
    }
    return out;
  }

  // ---------- Modo y cola de salida ----------
  async function getLink() {
    const { link } = await chrome.storage.local.get('link');
    return link && link.token ? link : null;
  }

  // Todos los contextos de la extensión comparten este candado para tocar la cola
  const withLock = (fn) => (typeof navigator !== 'undefined' && navigator.locks ? navigator.locks.request('notas-outbox', fn) : fn());

  async function areaNow() {
    return (await getLink()) ? chrome.storage.local : sync;
  }

  const nextT = (prev) => Math.max(Date.now(), ((prev && prev.t) || 0) + 1);

  // Guarda notas y borrados. En modo app también los anota en la cola de salida.
  async function writeNotes({ put = [], del = [], palette = null }) {
    const link = await getLink();
    if (!link) {
      const toSet = {};
      for (const n of put) toSet[PREFIX + n.id] = n;
      if (palette) toSet.palette = palette;
      if (Object.keys(toSet).length) await sync.set(toSet);
      if (del.length) await sync.remove(del.map((id) => PREFIX + id));
      return;
    }
    await withLock(async () => {
      const { outbox: current } = await chrome.storage.local.get('outbox');
      const outbox = { notes: { ...((current && current.notes) || {}) }, palette: (current && current.palette) || null };
      const toSet = {};
      for (const n of put) {
        const note = { ...n, profileId: n.profileId === undefined ? link.profileId || null : n.profileId };
        toSet[PREFIX + n.id] = note;
        outbox.notes[n.id] = { op: 'put', t: nextT(outbox.notes[n.id]) };
      }
      for (const id of del) outbox.notes[id] = { op: 'del', t: nextT(outbox.notes[id]) };
      if (palette) {
        toSet.palette = palette;
        outbox.palette = nextT({ t: outbox.palette });
      }
      toSet.outbox = outbox;
      await chrome.storage.local.set(toSet);
      if (del.length) await chrome.storage.local.remove(del.map((id) => PREFIX + id));
    });
  }

  // ---------- Notas ----------
  async function getAll() {
    const area = await areaNow();
    const data = await area.get(null);
    return Object.entries(data)
      .filter(([k]) => k.startsWith(PREFIX))
      .map(([, v]) => ({ ...v, tags: v.tags || [], color: v.color || null })) // compatible con notas v1.0
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function create({ title, description, url, scope, tags = [], color = null }) {
    const now = Date.now();
    return {
      id: crypto.randomUUID(),
      title,
      description,
      url: normalizeUrl(url),
      host: hostOf(url),
      scope, // "page" | "domain"
      tags: parseTags(tags),
      color,
      createdAt: now,
      updatedAt: now,
    };
  }

  async function save(note) {
    await writeNotes({ put: [note] });
  }

  async function update(id, patch) {
    const note = (await getAll()).find((n) => n.id === id);
    if (!note) throw new Error('La nota ya no existe.');
    if (patch.tags) patch.tags = parseTags(patch.tags);
    await save({ ...note, ...patch, updatedAt: Date.now() });
  }

  async function remove(id) {
    await writeNotes({ del: [id] });
  }

  // Notas que aplican a una pestaña: misma URL (scope page) o mismo dominio (scope domain)
  function forUrl(notes, url) {
    const n = normalizeUrl(url);
    const h = hostOf(url);
    return notes.filter((x) => (x.scope === 'domain' ? x.host === h : x.url === n));
  }

  // Consulta por texto, etiqueta, categoría (color) y alcance. color === 'none' → sin categoría
  function filter(notes, { q = '', tag = '', color = '', scope = '', profile = '' } = {}) {
    const s = q.trim().toLowerCase();
    return notes.filter((n) =>
      (!scope || n.scope === scope) &&
      (!profile || (profile === 'none' ? !n.profileId : n.profileId === profile)) &&
      (!tag || n.tags.includes(tag)) &&
      (!color || (color === 'none' ? !n.color : n.color === color)) &&
      (!s || [n.title, n.description, n.url, ...n.tags].some((t) => (t || '').toLowerCase().includes(s)))
    );
  }

  // Map etiqueta -> cantidad, ordenado por uso
  function allTags(notes) {
    const m = new Map();
    for (const n of notes) for (const t of n.tags) m.set(t, (m.get(t) || 0) + 1);
    return new Map([...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
  }

  // ---------- Paleta (categorías) ----------
  function sanitizeColor(c) {
    if (!c || typeof c !== 'object') return null;
    const id = String(c.id || '');
    if (!/^[\w-]{1,40}$/.test(id)) return null;
    if (!/^#[0-9a-f]{6}$/i.test(String(c.hex || ''))) return null;
    return {
      id,
      hex: c.hex.toLowerCase(),
      name: String(c.name || 'Sin nombre').slice(0, 40),
      info: String(c.info || '').slice(0, 200),
    };
  }

  async function getPalette() {
    const area = await areaNow();
    const { palette } = await area.get('palette');
    return Array.isArray(palette) ? palette : DEFAULT_PALETTE;
  }

  async function savePalette(list) {
    const next = list.map(sanitizeColor).filter(Boolean).slice(0, MAX_COLORS);
    const keep = new Set(next.map((c) => c.id));
    const prev = await getPalette();
    const removed = new Set(prev.filter((c) => !keep.has(c.id)).map((c) => c.id));
    // las notas que usaban una categoría eliminada quedan sin color
    const put = [];
    if (removed.size) {
      for (const n of await getAll()) {
        if (n.color && removed.has(n.color)) put.push({ ...n, color: null, updatedAt: Date.now() });
      }
    }
    await writeNotes({ put, palette: next });
  }

  // ---------- Ajustes ----------
  const DEFAULT_SETTINGS = {
    view: 'normal',        // simple | normal | detailed
    fontSize: 14,          // px, 10-18
    size: 'normal',        // compact | normal | large (tamaño del popup)
    rememberTags: true,    // conservar etiquetas de la última nota creada
    rememberColor: true,   // conservar color de la última nota creada
    formCollapsed: false,  // "Nueva nota" plegada
    theme: null,           // dark | claude-light | claude-dark (null = según el sistema)
  };

  async function getSettings() {
    const { settings } = await sync.get('settings');
    return { ...DEFAULT_SETTINGS, ...(settings || {}) };
  }

  // Últimas etiquetas/color usados al crear una nota. Es por dispositivo (storage.local):
  // no tiene sentido sincronizarlo y evita escrituras innecesarias en sync.
  async function getLast() {
    const { last } = await chrome.storage.local.get('last');
    return { tags: [], color: null, ...(last || {}) };
  }

  async function saveLast(last) {
    await chrome.storage.local.set({ last });
  }

  async function saveSettings(patch) {
    await sync.set({ settings: { ...(await getSettings()), ...patch } });
  }

  // ---------- Exportar / importar ----------
  async function exportData() {
    return {
      app: 'notas-url',
      version: 1,
      exportedAt: new Date().toISOString(),
      palette: await getPalette(),
      notes: await getAll(),
    };
  }

  function sanitizeNote(r) {
    if (!r || typeof r !== 'object') return null;
    const id = String(r.id || '');
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const url = String(r.url || '');
    if (!isSupported(url)) return null;
    const now = Date.now();
    return {
      id,
      title: String(r.title || url).slice(0, 150),
      description: String(r.description || '').slice(0, 2000),
      url: normalizeUrl(url),
      host: hostOf(url),
      scope: r.scope === 'domain' ? 'domain' : 'page',
      tags: parseTags(r.tags || []),
      color: typeof r.color === 'string' ? r.color.slice(0, 40) : null,
      createdAt: Number(r.createdAt) || now,
      updatedAt: Number(r.updatedAt) || now,
    };
  }

  // Combina: una nota importada solo reemplaza a la existente si es más reciente.
  // De la paleta solo se agregan las categorías que no existían.
  async function importData(data) {
    if (!data || data.app !== 'notas-url' || !Array.isArray(data.notes)) {
      throw new Error('El archivo no es una exportación válida de Notas por URL.');
    }
    const existing = new Map((await getAll()).map((n) => [n.id, n]));
    const put = [];
    let added = 0, updated = 0, skipped = 0;

    for (const raw of data.notes) {
      const n = sanitizeNote(raw);
      if (!n) { skipped++; continue; }
      const cur = existing.get(n.id);
      if (cur && cur.updatedAt >= n.updatedAt) { skipped++; continue; }
      put.push(n);
      if (cur) updated++; else added++;
    }

    let palette = null;
    if (Array.isArray(data.palette)) {
      const byId = new Map((await getPalette()).map((c) => [c.id, c]));
      const before = byId.size;
      for (const c of data.palette) {
        const s = sanitizeColor(c);
        if (s && !byId.has(s.id)) byId.set(s.id, s);
      }
      if (byId.size !== before) palette = [...byId.values()].slice(0, MAX_COLORS);
    }

    if (put.length || palette) await writeNotes({ put, palette });
    return { added, updated, skipped };
  }

  // ---------- Notas de antes de conectar con la app (viven en storage.sync) ----------
  async function getLegacy() {
    const data = await sync.get(null);
    const notes = Object.entries(data).filter(([k]) => k.startsWith(PREFIX)).map(([, v]) => sanitizeNote(v)).filter(Boolean);
    const palette = Array.isArray(data.palette) ? data.palette.map(sanitizeColor).filter(Boolean) : null;
    return { notes, palette };
  }

  // Pasa a la app las notas y categorías de este perfil. No borra nada de sync (queda como copia).
  async function importLegacy() {
    const { notes, palette } = await getLegacy();
    const link = await getLink();
    if (!link) throw new Error('Primero conecta la extensión con la app.');
    const existing = new Map((await getAll()).map((n) => [n.id, n]));
    const put = notes.filter((n) => { const c = existing.get(n.id); return !c || c.updatedAt < n.updatedAt; });
    await writeNotes({ put, palette: palette && palette.length ? palette : null });
    await chrome.storage.local.set({ legacyImported: true });
    return { notes: put.length, palette: palette ? palette.length : 0 };
  }

  return {
    MAX_COLORS, DEFAULT_PALETTE,
    getLink, getLegacy, importLegacy,
    internal: { PREFIX, withLock, writeNotes },
    isSupported, normalizeUrl, hostOf, parseTags,
    getAll, create, save, update, remove, forUrl, filter, allTags,
    getPalette, savePalette, DEFAULT_SETTINGS, getSettings, saveSettings, getLast, saveLast,
    exportData, importData,
  };
})();
