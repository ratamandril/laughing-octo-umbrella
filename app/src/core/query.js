'use strict';

// Filtros de notas del lado de la app, con las mismas reglas que la extensión (storage.js: forUrl y filter).
// Sirven para que una extensión consulte las notas de otros perfiles sin copiarlas.

const { normalizeUrl, hostOf, isHttpUrl } = require('./sanitize');

// ¿La nota aplica a esa URL? Alcance "page": misma URL; "domain": mismo sitio.
function matchesUrl(note, url) {
  if (note.scope === 'domain') return note.host === hostOf(url);
  try {
    return note.url === normalizeUrl(url);
  } catch {
    return false;
  }
}

function matchesText(note, q) {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  return [note.title, note.description, note.url, ...(note.tags || [])].some((t) => (t || '').toLowerCase().includes(s));
}

// Notas vivas de un perfil, de más reciente a más antigua, con los filtros indicados
function queryNotes(notes, { url = null, q = '', tag = '' } = {}) {
  return notes
    .filter((n) => !n.deleted && (!url || matchesUrl(n, url)) && (!tag || (n.tags || []).includes(tag)) && matchesText(n, q))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

module.exports = { matchesUrl, matchesText, queryNotes, isHttpUrl };
