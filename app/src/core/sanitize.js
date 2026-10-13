'use strict';

// Validación y normalización de todo lo que llega al servidor. Se usa tanto en
// las peticiones HTTP como al cargar el archivo de datos.

const ID_RE = /^[\w-]{1,64}$/;
const HEX_RE = /^#[0-9a-f]{6}$/i;
const LIMITS = {
  title: 150,
  description: 2000,
  url: 2048,
  tag: 30,
  tags: 10,
  color: 40,
  paletteName: 40,
  paletteInfo: 200,
  palette: 12,
};

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Igual que en la extensión: sin fragmento (#...) ni barra final
function normalizeUrl(value) {
  const url = new URL(value);
  url.hash = '';
  let text = url.href;
  if (text.endsWith('/')) text = text.slice(0, -1);
  return text;
}

function hostOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function parseTags(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(',');
  const out = [];
  for (const tag of list) {
    const value = String(tag).trim().toLowerCase().replace(/^#/, '').slice(0, LIMITS.tag);
    if (value && !out.includes(value)) out.push(value);
    if (out.length >= LIMITS.tags) break;
  }
  return out;
}

function timestamp(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 && n < 8.64e15 ? Math.floor(n) : fallback;
}

// Devuelve { note } o { error }. No asigna seq ni cambia updatedAt: eso lo decide el almacén.
function sanitizeNote(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not_an_object' };

  const id = String(raw.id ?? '');
  if (!ID_RE.test(id)) return { error: 'bad_id' };

  const url = String(raw.url ?? '');
  if (url.length > LIMITS.url || !isHttpUrl(url)) return { error: 'bad_url' };

  let profileId = null;
  if (raw.profileId !== undefined && raw.profileId !== null && raw.profileId !== '') {
    profileId = String(raw.profileId);
    if (!ID_RE.test(profileId)) return { error: 'bad_profile' };
  }

  const deleted = raw.deleted === true;
  const normalized = normalizeUrl(url);
  const title = String(raw.title ?? '').trim().slice(0, LIMITS.title);

  return {
    note: {
      id,
      title: deleted ? '' : title || normalized.slice(0, LIMITS.title),
      description: deleted ? '' : String(raw.description ?? '').slice(0, LIMITS.description),
      url: normalized,
      host: hostOf(url),
      scope: raw.scope === 'domain' ? 'domain' : 'page',
      tags: deleted ? [] : parseTags(raw.tags ?? []),
      color: raw.color === undefined || raw.color === null || raw.color === '' ? null : String(raw.color).slice(0, LIMITS.color),
      profileId,
      createdAt: Math.min(timestamp(raw.createdAt, now), now),
      updatedAt: Math.min(timestamp(raw.updatedAt, now), now + 24 * 3600 * 1000),
      deleted,
    },
  };
}

// Devuelve { list } o { error }. Descarta categorías inválidas y repetidas.
function sanitizePalette(list) {
  if (!Array.isArray(list)) return { error: 'not_an_array' };
  const out = [];
  const seen = new Set();
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id ?? '');
    if (!ID_RE.test(id) || seen.has(id)) continue;
    if (!HEX_RE.test(String(item.hex ?? ''))) continue;
    seen.add(id);
    out.push({
      id,
      hex: String(item.hex).toLowerCase(),
      name: String(item.name || 'Sin nombre').slice(0, LIMITS.paletteName),
      info: String(item.info || '').slice(0, LIMITS.paletteInfo),
    });
    if (out.length >= LIMITS.palette) break;
  }
  return { list: out };
}

module.exports = { ID_RE, LIMITS, isHttpUrl, normalizeUrl, hostOf, parseTags, sanitizeNote, sanitizePalette };
