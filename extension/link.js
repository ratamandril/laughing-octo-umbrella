// Conexión con la app local (servidor en 127.0.0.1). Lo usan las páginas y el service worker.
// El token y los datos de enlace viven en chrome.storage.local (nunca en sync: es de este perfil).
const Link = (() => {
  const PORT = 47321;
  const BASE = 'http://127.0.0.1:' + PORT;
  const WS_URL = 'ws://127.0.0.1:' + PORT + '/ws';

  const MESSAGES = {
    invalid_code: 'Código incorrecto.',
    no_active_code: 'No hay un código activo: genera uno nuevo en la app.',
    locked: 'Demasiados intentos fallidos: genera otro código en la app.',
    unauthorized: 'La app ya no reconoce esta extensión. Vuelve a conectarla.',
    origin_mismatch: 'La app asoció este acceso a otra extensión. Vuelve a conectarla.',
    profile_missing: 'Ese perfil ya no existe en el equipo.',
    browser_not_found: 'No se encontró el navegador de ese perfil en el equipo.',
    no_profile: 'La nota no tiene un perfil asignado.',
    unknown_profile: 'La app no conoce el perfil de esa nota.',
    not_found: 'No encontrado en la app.',
    too_many_opens: 'Demasiadas aperturas seguidas. Espera un momento.',
    profile_not_found: 'La app no detecta ese perfil.',
    read_only: 'Ese perfil comparte sus notas solo para lectura.',
    too_many_requests: 'Demasiadas consultas seguidas. Espera un momento.',
    invalid_email: 'Ese correo no es válido.',
    email_in_use: 'Ya hay otro perfil con ese correo.',
    invalid_sharing: 'Modo de compartición no válido.',
  };

  const browserKind = () => (navigator.userAgent.includes('Edg/') ? 'edge' : 'chrome');
  const browserLabel = () => (browserKind() === 'edge' ? 'Edge' : 'Chrome');

  async function get() {
    const { link } = await chrome.storage.local.get('link');
    return link && link.token ? link : null;
  }

  async function save(link) {
    await chrome.storage.local.set({ link });
  }

  // Petición a la app. Lanza Error con .offline (no hay conexión), .status y .code (respuesta de la app)
  async function request(path, { method = 'GET', body, auth = true, timeoutMs = 8000 } = {}) {
    const headers = {};
    if (auth) {
      const link = await get();
      if (!link) {
        const err = new Error('Esta extensión no está conectada a la app.');
        err.code = 'not_linked';
        throw err;
      }
      headers.Authorization = 'Bearer ' + link.token;
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(BASE + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal });
    } catch {
      const err = new Error('No se pudo conectar con la app. ¿Está abierta?');
      err.offline = true;
      throw err;
    } finally {
      clearTimeout(timer);
    }
    let json = null;
    try {
      json = await res.json();
    } catch { /* sin cuerpo */ }
    if (!res.ok) {
      const code = (json && json.error) || 'http_' + res.status;
      const err = new Error(MESSAGES[code] || 'La app respondió con un error (' + code + ').');
      err.status = res.status;
      err.code = code;
      throw err;
    }
    return json;
  }

  // Empareja con el código que muestra la app. Reinicia la caché: el servidor manda.
  async function pair(code) {
    const res = await request('/pair', { method: 'POST', auth: false, body: { code, browser: browserKind(), label: browserLabel() } });
    await chrome.storage.local.set({ syncSeq: 0, legacyImported: false });
    await save({ token: res.token, instanceId: res.instanceId, browser: browserKind(), profileId: null, pairedAt: Date.now() });
    restart();
  }

  async function profiles() {
    const { profiles: list } = await chrome.storage.local.get('profiles');
    return Array.isArray(list) ? list : [];
  }

  async function conn() {
    try {
      const { conn: c } = await chrome.storage.session.get('conn');
      return c || { state: 'unknown' };
    } catch {
      return { state: 'unknown' };
    }
  }

  // ---- Notas de otros perfiles: se piden a la app y no se guardan aquí ----
  const query = (params) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
    const s = u.toString();
    return s ? '?' + s : '';
  };
  const others = (url) => request('/others' + query({ url }));
  const profileNotes = (id, { url, q, tag, offset, limit } = {}) => request('/profiles/' + encodeURIComponent(id) + '/notes' + query({ url, q, tag, offset, limit }));
  const search = (q, { tag, limit } = {}) => request('/search' + query({ q, tag, limit }));
  // Cómo comparte este perfil sus notas: 'private' | 'read' | 'edit'
  const setSharing = (mode) => request('/me/sharing', { method: 'PUT', body: { mode } });
  const setEmail = (email, merge = false) => request('/me/email', { method: 'PUT', body: { email, merge } });
  // Edita una nota de otro perfil (solo si ese perfil lo permite); la app conserva al dueño
  const saveForeign = (note, patch) => request('/notes/' + encodeURIComponent(note.id), {
    method: 'PUT', body: { id: note.id, url: note.url, title: note.title, description: note.description, scope: note.scope, tags: note.tags, color: note.color, ...patch },
  });

  // Abre una nota en su navegador y perfil (lo hace la app)
  function openNote(noteId) {
    return request('/open', { method: 'POST', body: { noteId } });
  }

  // Avisa al service worker de que cambió el enlace
  function restart() {
    try {
      chrome.runtime.sendMessage({ type: 'link:restart' }).catch(() => {});
    } catch { /* sin service worker en este contexto */ }
  }

  // Olvida el enlace y la caché de este perfil (los datos siguen en la app)
  async function unlink() {
    try {
      await request('/me', { method: 'DELETE', timeoutMs: 3000 });
    } catch { /* la app puede estar cerrada: el acceso se revoca desde su ventana */ }
    await chrome.storage.local.remove(['link', 'outbox', 'syncSeq', 'profiles', 'palette', 'legacyImported']);
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('n_'));
    if (keys.length) await chrome.storage.local.remove(keys);
    try {
      await chrome.storage.session.remove('conn');
    } catch { /* ignorar */ }
    restart();
  }

  const STATE_TEXT = {
    online: 'Conectado a la app',
    connecting: 'Conectando con la app…',
    offline: 'Sin conexión con la app: los cambios se guardan y se enviarán al volver',
    revoked: 'La app ya no reconoce esta extensión: vuelve a conectarla en Ajustes',
    noprofile: 'Falta elegir el perfil de este navegador en Ajustes',
    unpaired: 'No conectada a la app',
    unknown: '',
  };

  async function cloudState() {
    try {
      const { cloud } = await chrome.storage.session.get('cloud');
      return cloud || null;
    } catch {
      return null;
    }
  }

  async function pendingIds() {
    const { outbox } = await chrome.storage.local.get('outbox');
    return new Set(Object.keys((outbox && outbox.notes) || {}));
  }

  // Resumen del estado para mostrar: { level: ok | warn | bad | off, text, action }
  async function statusInfo() {
    const link = await get();
    if (!link) return { level: 'off', text: 'Sin emparejar con la app', action: 'options' };
    const c = await conn();
    const pending = (await pendingIds()).size;
    const toApp = pending ? ` · ${pending} sin enviar a la app` : '';
    switch (c.state) {
      case 'offline':
        return { level: 'bad', text: 'App cerrada o sin conexión: tus cambios se guardan aquí' + toApp, action: 'retry' };
      case 'revoked':
        return { level: 'bad', text: STATE_TEXT.revoked, action: 'options' };
      case 'noprofile':
        return { level: 'warn', text: STATE_TEXT.noprofile, action: 'options' };
      case 'online': {
        const cloud = await cloudState();
        if (!cloud || cloud.state === 'disabled') return { level: 'ok', text: 'Conectada a la app · nube sin configurar' + toApp };
        if (cloud.state === 'offline') return { level: 'warn', text: 'App conectada, sin internet' + (cloud.pending ? ` · ${cloud.pending} sin subir a la nube` : '') + toApp };
        if (cloud.state === 'connecting') return { level: 'warn', text: 'App conectada · conectando con la nube…' + toApp };
        if (cloud.pending || pending) return { level: 'warn', text: 'Guardando…' + (cloud.pending ? ` ${cloud.pending} cambio(s) subiendo a la nube` : '') + toApp };
        return { level: 'ok', text: 'Todo a salvo en la nube' };
      }
      default:
        return { level: 'warn', text: STATE_TEXT.connecting };
    }
  }

  // Estado de seguridad de una nota: null (a salvo o no aplica), 'app' (sin enviar a la app) o 'cloud' (sin subir a la nube)
  function noteSafety(note, ctx) {
    if (!ctx || !ctx.linked) return null;
    if (ctx.pending.has(note.id)) return 'app';
    const cloud = ctx.cloud;
    if (cloud && cloud.state !== 'disabled' && typeof note.seq === 'number' && note.seq > cloud.syncedSeq) return 'cloud';
    return null;
  }

  async function safetyContext() {
    const link = await get();
    return { linked: !!link, pending: await pendingIds(), cloud: await cloudState() };
  }

  // Pinta la línea de estado (botón #conn). Siempre visible: dice si hay app, nube o nada.
  async function paintStatus(button, onOptions) {
    const info = await statusInfo();
    button.hidden = false;
    button.textContent = '● ' + info.text;
    button.dataset.level = info.level;
    button.title = info.action === 'retry' ? 'Pulsa para reintentar la conexión' : info.action === 'options' ? 'Abrir Ajustes' : '';
    button.onclick = info.action === 'retry'
      ? () => { try { chrome.runtime.sendMessage({ type: 'link:retry' }); } catch { /* sin service worker */ } }
      : info.action === 'options' ? onOptions : null;
    button.style.cursor = info.action ? 'pointer' : 'default';
  }

  return { paintStatus, statusInfo, noteSafety, safetyContext, BASE, WS_URL, PORT, browserKind, browserLabel, get, save, request, pair, profiles, conn, openNote, others, profileNotes, search, setSharing, setEmail, saveForeign, restart, unlink, STATE_TEXT };
})();
