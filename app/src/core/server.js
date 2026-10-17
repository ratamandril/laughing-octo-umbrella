'use strict';

// Servidor local (HTTP + WebSocket) en 127.0.0.1 al que se conectan las extensiones.
// El protocolo completo está en docs/protocolo.md.
//
// Capas de seguridad, de fuera hacia dentro:
//   1. Solo escucha en 127.0.0.1 y rechaza cualquier cabecera Host que no sea la suya (anti DNS-rebinding).
//   2. El origen debe ser una extensión (chrome-extension:// o moz-extension://), nunca una página web.
//   3. Los cuerpos deben ser application/json (una página web no puede enviarlos sin preflight).
//   4. Token Bearer, y además el origen debe coincidir con el de la extensión a la que se le entregó.

const http = require('node:http');
const { EventEmitter } = require('node:events');
const { WebSocketServer } = require('ws');
const { sanitizeNote } = require('./sanitize');
const { BROWSERS } = require('./profiles');
const { queryNotes, isHttpUrl } = require('./query');
const { SHARING, sharingOf } = require('./registry');

const PROTOCOL = 1;
const ORIGIN_RE = /^(chrome|moz)-extension:\/\/[a-z0-9-]{8,64}$/i;
const JSON_LIMIT = 1024 * 1024;
const BULK_LIMIT = 5 * 1024 * 1024;
const BULK_MAX_NOTES = 5000;
const BROADCAST_CHUNK = 500;
const MAX_SOCKETS_PER_INSTANCE = 8;
const BROWSER_NAMES = new Set(['chrome', 'edge', 'firefox', 'other']);
const PAGE_DEFAULT = 20;
const PAGE_MAX = 50;
const QUERY_RATE = { windowMs: 10000, max: 80 }; // consultas de otros perfiles por extensión

class HttpError extends Error {
  constructor(status, code, extra) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const ok = (body, status = 200) => ({ status, body });

// Lo que ven las extensiones: una nota borrada nunca lleva su contenido (eso queda en la papelera de la app)
function publicNote(note) {
  if (!note || !note.deleted) return note;
  const { deletedAt, purged, ...rest } = note; // eslint-disable-line no-unused-vars
  return { ...rest, title: '', description: '', tags: [] };
}

function bearer(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header || '');
  return match ? match[1] : null;
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (chunk) => {
      if (tooBig) return; // se sigue leyendo (y descartando) hasta poder responder 413
      size += chunk.length;
      if (size > limit) {
        tooBig = true;
        chunks.length = 0;
        reject(new HttpError(413, 'payload_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

class NotesServer extends EventEmitter {
  constructor({
    store,
    auth,
    registry,
    profiles,
    launcher,
    host = '127.0.0.1',
    port = 47321,
    allowNoOrigin = false, // solo para pruebas: permite escrituras sin cabecera Origin
    version = '0.0.0',
    now = Date.now,
  }) {
    super();
    Object.assign(this, { store, auth, registry, profiles, launcher, host, port, allowNoOrigin, version, now });
    this.clients = new Set();
    this.lastSeen = new Map();
    this.openLog = [];
    this.cloud = { state: 'disabled', pending: 0, syncedSeq: 0 };
    this.cloudTimer = null;
    this.pendingOthers = new Set();
    this.othersTimer = null;
    this.queryLog = new Map();
    this.keepAlive = null;

    this.http = http.createServer((req, res) => {
      this._handle(req, res);
    });
    this.http.maxConnections = 256;
    this.http.requestTimeout = 30000;
    this.http.headersTimeout = 15000;

    this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.http.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));

    this.auth.on('revoked', (instanceId) => this._closeInstance(instanceId));

    const route = (method, re, needsAuth, handler, limit = JSON_LIMIT) => ({ method, re, needsAuth, handler, limit });
    this.routes = [
      route('GET', /^\/health$/, false, () => ok({ ok: true, app: 'notas-por-url', protocol: PROTOCOL, version: this.version })),
      route('POST', /^\/pair$/, false, (ctx) => this._pair(ctx), 1024),
      route('GET', /^\/me$/, true, (ctx) => this._me(ctx)),
      route('DELETE', /^\/me$/, true, (ctx) => this._unpair(ctx)),
      route('GET', /^\/profiles$/, true, (ctx) => this._profiles(ctx)),
      route('PUT', /^\/me\/binding$/, true, (ctx) => this._setBinding(ctx)),
      route('DELETE', /^\/me\/binding$/, true, (ctx) => this._clearBinding(ctx)),
      route('PUT', /^\/me\/email$/, true, (ctx) => this._setEmail(ctx)),
      route('PUT', /^\/me\/sharing$/, true, (ctx) => this._setSharing(ctx)),
      route('PATCH', /^\/profiles\/([\w-]{1,64})$/, true, (ctx) => this._renameProfile(ctx)),
      route('GET', /^\/others$/, true, (ctx) => this._others(ctx)),
      route('GET', /^\/profiles\/([\w-]{1,64})\/notes$/, true, (ctx) => this._profileNotes(ctx)),
      route('GET', /^\/search$/, true, (ctx) => this._search(ctx)),
      route('GET', /^\/notes$/, true, (ctx) => this._listNotes(ctx)),
      route('POST', /^\/notes\/bulk$/, true, (ctx) => this._bulk(ctx), BULK_LIMIT),
      route('PUT', /^\/notes\/([\w-]{1,64})$/, true, (ctx) => this._putNote(ctx)),
      route('DELETE', /^\/notes\/([\w-]{1,64})$/, true, (ctx) => this._deleteNote(ctx)),
      route('GET', /^\/palette$/, true, () => ok({ palette: this.store.getPalette() })),
      route('PUT', /^\/palette$/, true, (ctx) => this._putPalette(ctx)),
      route('POST', /^\/open$/, true, (ctx) => this._open(ctx)),
    ];
  }

  // ---------- ciclo de vida ----------
  start() {
    return new Promise((resolve, reject) => {
      this.http.once('error', reject);
      this.http.listen(this.port, this.host, () => {
        this.http.off('error', reject);
        this.port = this.http.address().port;
        this.keepAlive = setInterval(() => this._pingSockets(), 30000);
        if (this.keepAlive.unref) this.keepAlive.unref();
        resolve(this.port);
      });
    });
  }

  async stop() {
    if (this.keepAlive) clearInterval(this.keepAlive);
    clearTimeout(this.cloudTimer);
    clearTimeout(this.othersTimer);
    for (const ws of this.clients) ws.close(1001, 'server_stopping');
    await new Promise((resolve) => {
      this.http.close(() => resolve());
      if (this.http.closeAllConnections) this.http.closeAllConnections();
    });
    await this.store.flush().catch(() => {});
    await this.registry.flush().catch(() => {});
  }

  // Estado de la copia en la nube: se informa a las extensiones para que muestren si todo está a salvo
  setCloud(status) {
    const next = { state: status.state, pending: status.pending, syncedSeq: status.syncedSeq || 0 };
    if (JSON.stringify(next) === JSON.stringify(this.cloud)) return;
    this.cloud = next;
    clearTimeout(this.cloudTimer);
    this.cloudTimer = setTimeout(() => this._broadcast({ type: 'status', cloud: this.cloud }), 250);
    if (this.cloudTimer.unref) this.cloudTimer.unref();
  }

  // Para cambios que no vienen de una extensión (p. ej. Firestore): se avisa a todas
  broadcastNotes(notes, exceptInstanceId = null) {
    if (!notes.length) return;
    this._queueOthers(notes.map((n) => n.profileId)); // los demás perfiles solo reciben un aviso sin contenido
    for (const ws of this.clients) {
      if (!ws.instanceId || ws.instanceId === exceptInstanceId || ws.readyState !== 1) continue;
      const instance = this.registry.getInstance(ws.instanceId);
      const visible = notes.filter((n) => this._isOwn(instance, n)).map(publicNote);
      if (visible.length) this._sendBuffered(ws, JSON.stringify({ type: 'notes', notes: visible, seq: this.store.seq }));
    }
  }

  broadcastPalette(palette) {
    this._broadcast({ type: 'palette', palette });
  }

  broadcastProfiles() {
    for (const ws of this.clients) {
      if (!ws.instanceId || ws.readyState !== 1) continue;
      const instance = this.registry.getInstance(ws.instanceId);
      this._sendJson(ws, { type: 'profiles', profiles: this._profileList(instance) });
    }
  }

  onlineInstanceIds() {
    const ids = new Set();
    for (const ws of this.clients) if (ws.instanceId) ids.add(ws.instanceId);
    return ids;
  }

  // ---------- visibilidad ----------
  // El flujo de notas de cada extensión (GET /notes y el WebSocket) trae SOLO las de su perfil. Las de los demás
  // perfiles se consultan bajo demanda (/others, /profiles/:id/notes, /search) y solo si ese perfil las comparte.
  _isOwn(instance, note) {
    return !!note && !!instance && !!instance.profileId && note.profileId === instance.profileId;
  }

  // ¿Puede esta extensión leer ese perfil? El suyo siempre; los demás, si no son privados
  _canReadProfile(instance, profileId) {
    if (!instance || !instance.profileId || !profileId) return false;
    if (profileId === instance.profileId) return true;
    const profile = this.registry.getProfile(profileId);
    return !!profile && sharingOf(profile) !== 'private';
  }

  _canRead(instance, note) {
    return !!note && this._canReadProfile(instance, note.profileId);
  }

  // Escribir: el dueño siempre; otro perfil solo si el dueño permite editar, y nunca borrar
  _canWrite(instance, note, { remove = false } = {}) {
    if (this._isOwn(instance, note)) return true;
    return !remove && this._canRead(instance, note) && sharingOf(this.registry.getProfile(note.profileId)) === 'edit';
  }

  _requireProfile(instance) {
    if (!instance.profileId) throw new HttpError(409, 'profile_required');
  }

  // Cómo ve esta extensión a un perfil: el suyo completo; los demás con lo mínimo (los privados, ni siquiera el correo)
  _profileView(instance, p) {
    const sharing = sharingOf(p);
    if (instance && p.id === instance.profileId) return { id: p.id, name: p.name, email: p.email || '', sharing, own: true, binding: this.registry.bindingOf(p.id) };
    if (sharing === 'private') return { id: p.id, name: p.name, sharing, own: false };
    return { id: p.id, name: p.name, email: p.email || '', sharing, own: false };
  }

  _profileList(instance) {
    // Una cuenta sin notas ni extensiones (p. ej. una recién creada y sin usar) no aporta nada a las demás extensiones
    const used = new Set();
    for (const n of this.store.notes.values()) if (!n.deleted && n.profileId) used.add(n.profileId);
    for (const i of this.registry.instances.values()) if (i.profileId) used.add(i.profileId);
    return this.registry.listProfiles()
      .filter((p) => used.has(p.id) || (instance && p.id === instance.profileId))
      .map((p) => this._profileView(instance, p));
  }

  // Avisa a una extensión de que cambió su flujo de notas: vuelve a sincronizar desde cero
  notifyAccess(instanceId) {
    for (const ws of this.clients) if (ws.instanceId === instanceId) this._sendJson(ws, { type: 'access' });
  }

  // Aviso sin contenido, "otro perfil cambió", solo a las extensiones que pueden leer ese perfil.
  // Se agrupan los avisos que llegan seguidos (p. ej. una importación grande).
  _queueOthers(profileIds) {
    for (const id of profileIds) if (id) this.pendingOthers.add(id);
    if (this.othersTimer || !this.pendingOthers.size) return;
    this.othersTimer = setTimeout(() => this._flushOthers(), 250);
    if (this.othersTimer.unref) this.othersTimer.unref();
  }

  _flushOthers() {
    this.othersTimer = null;
    const changed = [...this.pendingOthers];
    this.pendingOthers.clear();
    for (const ws of this.clients) {
      if (!ws.instanceId || ws.readyState !== 1) continue;
      const instance = this.registry.getInstance(ws.instanceId);
      const ids = changed.filter((id) => instance && id !== instance.profileId && this._canReadProfile(instance, id));
      if (ids.length) this._sendJson(ws, { type: 'others', profiles: ids });
    }
  }

  _throttleQueries(instance) {
    const now = this.now();
    const log = (this.queryLog.get(instance.id) || []).filter((t) => now - t < QUERY_RATE.windowMs);
    if (log.length >= QUERY_RATE.max) throw new HttpError(429, 'too_many_requests');
    log.push(now);
    this.queryLog.set(instance.id, log);
  }

  // ---------- comprobaciones comunes ----------
  _checkHost(req) {
    const host = String(req.headers.host || '').toLowerCase();
    const allowed = [`127.0.0.1:${this.port}`, `localhost:${this.port}`, `[::1]:${this.port}`];
    if (!allowed.includes(host)) throw new HttpError(403, 'bad_host');
  }

  // { present, id, raw }: id solo si es un origen de extensión válido
  _parseOrigin(req) {
    const raw = req.headers.origin;
    if (raw === undefined) return { present: false, id: null, raw: null };
    if (!ORIGIN_RE.test(raw)) throw new HttpError(403, 'origin_not_allowed');
    return { present: true, id: raw.toLowerCase(), raw };
  }

  // ---------- HTTP ----------
  async _handle(req, res) {
    const ctx = { req, res, cors: {}, params: [], instance: null, body: null, url: null, origin: null };
    try {
      this._checkHost(req);
      ctx.url = new URL(req.url, 'http://localhost');
      ctx.origin = this._parseOrigin(req);
      if (ctx.origin.id) {
        ctx.cors = {
          'Access-Control-Allow-Origin': ctx.origin.raw,
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
          'Access-Control-Max-Age': '600',
          Vary: 'Origin',
        };
      }
      if (req.method === 'OPTIONS') {
        if (!ctx.origin.id) throw new HttpError(403, 'origin_required');
        this._send(ctx, 204, null);
        return;
      }

      const isRead = req.method === 'GET' || req.method === 'HEAD';
      if (!ctx.origin.present && !isRead && !this.allowNoOrigin) throw new HttpError(403, 'origin_required');

      let route = null;
      let pathMatched = false;
      for (const candidate of this.routes) {
        const match = candidate.re.exec(ctx.url.pathname);
        if (!match) continue;
        pathMatched = true;
        if (candidate.method !== req.method) continue;
        route = candidate;
        ctx.params = match.slice(1);
        break;
      }
      if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method_not_allowed' : 'not_found');

      if (route.needsAuth) {
        const instance = this.auth.authenticate(bearer(req.headers.authorization));
        if (!instance) throw new HttpError(401, 'unauthorized');
        if (ctx.origin.id && instance.origin && instance.origin.toLowerCase() !== ctx.origin.id) {
          throw new HttpError(403, 'origin_mismatch');
        }
        ctx.instance = instance;
        this.lastSeen.set(instance.id, this.now());
      }

      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
          throw new HttpError(415, 'content_type_must_be_json');
        }
        const text = await readBody(req, route.limit);
        try {
          ctx.body = text ? JSON.parse(text) : {};
        } catch {
          throw new HttpError(400, 'invalid_json');
        }
        if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) {
          throw new HttpError(400, 'body_must_be_an_object');
        }
      }

      const result = await route.handler(ctx);
      this._send(ctx, result.status, result.body);
    } catch (err) {
      this._sendError(ctx, err);
    }
  }

  _send(ctx, status, body) {
    const { res } = ctx;
    const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...ctx.cors };
    if (body === null || body === undefined) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    headers['Content-Type'] = 'application/json; charset=utf-8';
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  }

  _sendError(ctx, err) {
    if (ctx.res.headersSent) {
      ctx.res.destroy();
      return;
    }
    if (err instanceof HttpError) {
      if (err.status === 413) {
        // No seguir recibiendo un cuerpo enorme: se responde y se corta la conexión
        ctx.cors.Connection = 'close';
        ctx.res.once('finish', () => ctx.req.destroy());
      }
      this._send(ctx, err.status, { error: err.code, ...(err.extra || {}) });
      return;
    }
    this.emit('error-internal', err);
    this._send(ctx, 500, { error: 'internal_error' });
  }

  // ---------- manejadores ----------
  async _pair(ctx) {
    if (!ctx.origin.id) throw new HttpError(403, 'origin_required');
    const { code, browser, label } = ctx.body;
    const result = await this.auth.pair({
      code,
      origin: ctx.origin.id,
      browser: BROWSER_NAMES.has(browser) ? browser : 'other',
      label: String(label ?? '').slice(0, 60),
    });
    if (!result.ok) {
      const map = { no_code: [410, 'no_active_code'], invalid_code: [401, 'invalid_code'], locked: [429, 'locked'] };
      const [status, code2] = map[result.reason];
      throw new HttpError(status, code2);
    }
    this.emit('change');
    return ok({ token: result.token, instanceId: result.instance.id, protocol: PROTOCOL }, 201);
  }

  _me(ctx) {
    const { instance } = ctx;
    return ok({
      instanceId: instance.id,
      browser: instance.browser,
      label: instance.label,
      profile: instance.profileId ? this._profileView(instance, this.registry.getProfile(instance.profileId)) : null,
      seq: this.store.seq,
      protocol: PROTOCOL,
    });
  }

  // La extensión se desvincula a sí misma
  _unpair(ctx) {
    this.auth.revoke(ctx.instance.id);
    this.emit('change');
    return ok({ ok: true });
  }

  async _profiles(ctx) {
    const detected = (await this.profiles.detect()).map((d) => {
      const bound = this.registry.profileAt(d.browser, d.dir);
      return { ...d, boundTo: bound ? bound.id : null };
    });
    return ok({ detected, registered: this._profileList(ctx.instance) });
  }

  // Enlace local: "la cuenta de esta extensión se abre con este perfil de navegador de esta PC" (uno por cuenta)
  async _setBinding(ctx) {
    this._requireProfile(ctx.instance);
    const { browser, dir } = ctx.body;
    if (!BROWSERS.includes(browser) || typeof dir !== 'string' || !dir) throw new HttpError(400, 'invalid_profile');
    const detected = (await this.profiles.detect()).find((p) => p.browser === browser && p.dir === dir);
    if (!detected) throw new HttpError(400, 'profile_not_found');
    const binding = this.registry.setBinding(ctx.instance.profileId, browser, dir);
    await this.registry.flush();
    this.broadcastProfiles();
    this.emit('change');
    return ok({ profile: this._profileView(ctx.instance, this.registry.getProfile(ctx.instance.profileId)), binding });
  }

  async _clearBinding(ctx) {
    this._requireProfile(ctx.instance);
    this.registry.clearBinding(ctx.instance.profileId);
    await this.registry.flush();
    this.broadcastProfiles();
    this.emit('change');
    return ok({ ok: true });
  }

  // Correo de la cuenta (solo una etiqueta; vacío lo borra)
  async _setEmail(ctx) {
    this._requireProfile(ctx.instance);
    const email = typeof ctx.body.email === 'string' ? ctx.body.email : '';
    const profile = this.registry.updateProfile(ctx.instance.profileId, { email });
    if (!profile) throw new HttpError(400, 'invalid_email');
    await this.registry.flush();
    this.broadcastProfiles();
    this._queueOthers([profile.id]);
    this.emit('change');
    return ok({ profile: this._profileView(ctx.instance, profile) });
  }

  // Pasa las notas e instancias de un perfil a otro (la extensión se resincroniza sola)
  mergeProfiles(fromId, intoId) {
    const movedInstances = this.registry.listInstances().filter((i) => i.profileId === fromId).map((i) => i.id);
    const into = this.registry.mergeProfile(fromId, intoId);
    if (!into) return null;
    const moved = this.store.reassignProfile(fromId, intoId);
    this.registry.flush();
    this.broadcastProfiles();
    for (const id of movedInstances) this.notifyAccess(id);
    if (moved.length) this.broadcastNotes(moved);
    this._queueOthers([fromId, intoId]);
    this.emit('change');
    return into;
  }

  // El dueño del perfil decide cómo lo comparte (desde Ajustes de su extensión o, como respaldo, desde la app)
  async _setSharing(ctx) {
    this._requireProfile(ctx.instance);
    const mode = ctx.body.mode;
    if (!SHARING.includes(mode)) throw new HttpError(400, 'invalid_sharing');
    const profile = this.registry.setProfileSharing(ctx.instance.profileId, mode);
    if (!profile) throw new HttpError(404, 'unknown_profile');
    await this.registry.flush();
    this.applySharingChange(profile.id);
    this.emit('change');
    return ok({ profile: this._profileView(ctx.instance, profile) });
  }

  // Tras cambiar el modo de un perfil: las extensiones actualizan su lista y lo que estén mostrando de él
  applySharingChange(profileId) {
    this.broadcastProfiles();
    this._queueOthers([profileId]);
  }

  _urlParam(ctx) {
    const raw = ctx.url.searchParams.get('url');
    if (!raw) return null;
    if (raw.length > 2048 || !isHttpUrl(raw)) throw new HttpError(400, 'invalid_url');
    return raw;
  }

  _textParam(ctx, name, max) {
    const raw = ctx.url.searchParams.get(name) || '';
    if (raw.length > max) throw new HttpError(400, 'invalid_' + name);
    return raw.trim();
  }

  _pageParams(ctx, defaultLimit = PAGE_DEFAULT) {
    const num = (name, fallback) => {
      const raw = ctx.url.searchParams.get(name);
      if (raw === null) return fallback;
      const n = Number.parseInt(raw, 10);
      if (!Number.isInteger(n) || n < 0) throw new HttpError(400, 'invalid_' + name);
      return n;
    };
    return { offset: num('offset', 0), limit: Math.min(Math.max(num('limit', defaultLimit), 1), PAGE_MAX) };
  }

  _notesByProfile() {
    const map = new Map();
    for (const n of this.store.notes.values()) {
      if (n.deleted || !n.profileId) continue;
      if (!map.has(n.profileId)) map.set(n.profileId, []);
      map.get(n.profileId).push(n);
    }
    return map;
  }

  // Resumen de los demás perfiles: cuántas notas tienen y cuántas aplican a la página dada. Los privados, nada.
  _others(ctx) {
    this._requireProfile(ctx.instance);
    this._throttleQueries(ctx.instance);
    const url = this._urlParam(ctx);
    const byProfile = this._notesByProfile();
    const profiles = this.registry.listProfiles()
      .filter((p) => p.id !== ctx.instance.profileId)
      .map((p) => {
        const view = this._profileView(ctx.instance, p);
        if (view.sharing === 'private') return view;
        const notes = byProfile.get(p.id) || [];
        return { ...view, total: notes.length, forUrl: url ? queryNotes(notes, { url }).length : null };
      });
    return ok({ profiles });
  }

  // Notas de un perfil que se puede leer, por páginas. Filtros: url (las que aplican a esa página), q (texto), tag.
  _profileNotes(ctx) {
    this._requireProfile(ctx.instance);
    this._throttleQueries(ctx.instance);
    const id = ctx.params[0];
    if (!this.registry.getProfile(id) || !this._canReadProfile(ctx.instance, id)) throw new HttpError(404, 'not_found');
    const found = queryNotes(this._notesByProfile().get(id) || [], {
      url: this._urlParam(ctx),
      q: this._textParam(ctx, 'q', 100),
      tag: this._textParam(ctx, 'tag', 30),
    });
    const { offset, limit } = this._pageParams(ctx);
    return ok({ total: found.length, offset, limit, notes: found.slice(offset, offset + limit).map(publicNote) });
  }

  // Búsqueda en los demás perfiles legibles: un grupo por perfil, solo los que tienen coincidencias
  _search(ctx) {
    this._requireProfile(ctx.instance);
    this._throttleQueries(ctx.instance);
    const q = this._textParam(ctx, 'q', 100);
    if (!q) throw new HttpError(400, 'invalid_q');
    const tag = this._textParam(ctx, 'tag', 30);
    const { limit } = this._pageParams(ctx, 10);
    const byProfile = this._notesByProfile();
    const groups = [];
    for (const p of this.registry.listProfiles()) {
      if (p.id === ctx.instance.profileId || !this._canReadProfile(ctx.instance, p.id)) continue;
      const found = queryNotes(byProfile.get(p.id) || [], { q, tag });
      if (found.length) groups.push({ profile: this._profileView(ctx.instance, p), total: found.length, notes: found.slice(0, limit).map(publicNote) });
    }
    groups.sort((a, b) => b.notes[0].updatedAt - a.notes[0].updatedAt);
    return ok({ groups });
  }

  async _renameProfile(ctx) {
    this._requireProfile(ctx.instance);
    const name = typeof ctx.body.name === 'string' ? ctx.body.name.trim().slice(0, 60) : '';
    if (!name) throw new HttpError(400, 'invalid_name');
    if (ctx.params[0] !== ctx.instance.profileId) throw new HttpError(403, 'read_only'); // cada cuenta cambia solo lo suyo
    const profile = this.registry.updateProfile(ctx.params[0], { name });
    if (!profile) throw new HttpError(404, 'unknown_profile');
    await this.registry.flush();
    this.broadcastProfiles();
    this._queueOthers([profile.id]);
    this.emit('change');
    return ok({ profile: this._profileView(ctx.instance, profile) });
  }

  _listNotes(ctx) {
    const raw = ctx.url.searchParams.get('since');
    const since = raw === null ? 0 : Number.parseInt(raw, 10);
    if (!Number.isInteger(since) || since < 0) throw new HttpError(400, 'invalid_since');
    this._requireProfile(ctx.instance);
    const notes = this.store.since(since).filter((n) => this._isOwn(ctx.instance, n));
    return ok({ seq: this.store.seq, notes: notes.map(publicNote) });
  }

  _knownProfileOrThrow(profileId) {
    if (profileId !== null && profileId !== undefined && !this.registry.getProfile(String(profileId))) {
      throw new HttpError(400, 'unknown_profile');
    }
  }

  _putNote(ctx) {
    const id = ctx.params[0];
    const body = ctx.body;
    if (body.id !== undefined && String(body.id) !== id) throw new HttpError(400, 'id_mismatch');

    this._requireProfile(ctx.instance);
    const existing = this.store.get(id);
    let profileId;
    if (existing && !this._isOwn(ctx.instance, existing)) {
      // Nota de otro perfil: si es privado no se revela que existe; si se puede leer pero no editar, 403
      if (!this._canRead(ctx.instance, existing)) throw new HttpError(404, 'not_found');
      if (!this._canWrite(ctx.instance, existing) || existing.deleted) throw new HttpError(403, 'read_only');
      profileId = existing.profileId; // se edita sin cambiar de dueño
    } else {
      const asked = body.profileId === undefined || body.profileId === null || body.profileId === '' ? null : String(body.profileId);
      profileId = asked || (existing ? existing.profileId : ctx.instance.profileId);
      this._knownProfileOrThrow(profileId);
      if (profileId !== ctx.instance.profileId) throw new HttpError(403, 'profile_not_allowed');
    }

    const result = this.store.put({ ...body, id, profileId });
    if (result.error) throw new HttpError(400, 'invalid_note', { detail: result.error });

    this.broadcastNotes([result.note], ctx.instance.id);
    this.emit('change');
    return ok({ note: result.note }, result.created ? 201 : 200);
  }

  _deleteNote(ctx) {
    this._requireProfile(ctx.instance);
    const current = this.store.get(ctx.params[0]);
    if (!current || !this._canRead(ctx.instance, current)) throw new HttpError(404, 'not_found');
    if (!this._canWrite(ctx.instance, current, { remove: true })) throw new HttpError(403, 'read_only'); // solo borra el dueño
    const note = this.store.remove(ctx.params[0]);
    if (!note) throw new HttpError(404, 'not_found');
    this.broadcastNotes([note], ctx.instance.id);
    this.emit('change');
    return ok({ note: publicNote(note) });
  }

  // Importación masiva (p. ej. las notas que ya tenía una extensión). No pisa cambios más recientes ni borrados.
  _bulk(ctx) {
    const list = ctx.body.notes;
    if (!Array.isArray(list) || list.length > BULK_MAX_NOTES) throw new HttpError(400, 'invalid_bulk');
    this._requireProfile(ctx.instance);

    const imported = [];
    let skipped = 0;
    let invalid = 0;
    const rejected = []; // ids que esta extensión no puede tener (pertenecen a otro perfil): debe quitarlos de su caché
    for (const raw of list) {
      const check = sanitizeNote(raw, { now: this.now() });
      if (check.error) {
        invalid++;
        continue;
      }
      const prev = this.store.get(check.note.id);
      if (prev && !this._isOwn(ctx.instance, prev)) {
        invalid++; // ese id pertenece a otro perfil: aquí no se importa
        rejected.push(check.note.id);
        continue;
      }
      if (prev && prev.updatedAt >= check.note.updatedAt) {
        skipped++;
        continue;
      }
      const profileId = raw.profileId === undefined || raw.profileId === null || raw.profileId === '' ? ctx.instance.profileId : raw.profileId;
      if (!profileId || String(profileId) !== ctx.instance.profileId) {
        invalid++;
        rejected.push(check.note.id);
        continue;
      }
      const result = this.store.put({ ...raw, profileId }, { keepTimestamps: true, allowDeleted: true });
      if (result.error) invalid++;
      else imported.push(result.note);
    }

    for (let i = 0; i < imported.length; i += BROADCAST_CHUNK) {
      this.broadcastNotes(imported.slice(i, i + BROADCAST_CHUNK), ctx.instance.id);
    }
    this.emit('change');
    return ok({ imported: imported.length, skipped, invalid, rejected, seq: this.store.seq });
  }

  _putPalette(ctx) {
    const result = this.store.setPalette(ctx.body.list);
    if (result.error) throw new HttpError(400, 'invalid_palette');
    this._broadcast({ type: 'palette', palette: result.palette }, ctx.instance.id);
    this.emit('change');
    return ok({ palette: result.palette });
  }

  async _open(ctx) {
    const { noteId, url, profileId } = ctx.body;
    const result = await this.openTarget({ noteId, url, profileId }, ctx.instance);
    return ok(result);
  }

  // Abre una URL en el navegador y perfil correctos. Con `instance` solo se permiten notas y perfiles que esa
  // extensión puede ver; sin ella (la propia app) no hay restricción.
  async openTarget({ noteId, url, profileId }, instance = null) {
    const now = this.now();
    this.openLog = this.openLog.filter((t) => now - t < 10000);
    if (this.openLog.length >= 20) throw new HttpError(429, 'too_many_opens');
    this.openLog.push(now);

    if (instance) this._requireProfile(instance);
    if (noteId !== undefined) {
      const note = this.store.get(String(noteId));
      if (!note || note.deleted || (instance && !this._canRead(instance, note))) throw new HttpError(404, 'not_found');
      url = note.url;
      if (profileId === undefined) profileId = note.profileId;
    }
    if (!profileId) throw new HttpError(400, 'no_profile');
    const profile = this.registry.getProfile(String(profileId));
    if (!profile || (instance && !this._canReadProfile(instance, profile.id))) throw new HttpError(404, 'unknown_profile');

    // Cada cuenta se abre con el navegador que esta PC tenga enlazado a ella
    const binding = this.registry.bindingOf(profile.id);
    if (!binding) throw new HttpError(409, 'no_binding');
    const detected = await this.profiles.detect();
    if (!detected.some((p) => p.browser === binding.browser && p.dir === binding.dir)) {
      throw new HttpError(409, 'profile_missing');
    }

    try {
      await this.launcher.open({ browser: binding.browser, dir: binding.dir, url });
    } catch (err) {
      const status = { invalid_url: 400, invalid_browser: 400, invalid_profile: 400, browser_not_found: 409 }[err.code] || 500;
      throw new HttpError(status, err.code || 'open_failed');
    }
    return { ok: true, browser: binding.browser, profile: profile.name };
  }

  // ---------- WebSocket ----------
  _upgrade(req, socket, head) {
    try {
      this._checkHost(req);
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/ws') throw new HttpError(404, 'not_found');
      const origin = this._parseOrigin(req);
      if (!origin.id && !this.allowNoOrigin) throw new HttpError(403, 'origin_required');
      this.wss.handleUpgrade(req, socket, head, (ws) => this._onSocket(ws, origin));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      socket.write(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    }
  }

  // Primer mensaje obligatorio: { type: 'hello', token, since? }. Después: { type: 'ping' } -> { type: 'pong' }.
  _onSocket(ws, origin) {
    let pending = 0;
    for (const other of this.clients) if (!other.instanceId) pending++;
    if (pending >= 32) {
      ws.close(4429, 'too_many_pending');
      return;
    }
    ws.isAlive = true;
    ws.instanceId = null;
    this.clients.add(ws);
    const helloTimer = setTimeout(() => ws.close(4401, 'hello_timeout'), 5000);

    ws.on('error', () => {});
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('close', () => {
      clearTimeout(helloTimer);
      this.clients.delete(ws);
      if (ws.instanceId) this.emit('change');
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400, 'text_only');
      let msg;
      try {
        msg = JSON.parse(data.toString('utf8'));
      } catch {
        return ws.close(4400, 'invalid_json');
      }
      if (!msg || typeof msg !== 'object') return ws.close(4400, 'invalid_message');

      if (!ws.instanceId) {
        if (msg.type !== 'hello') return ws.close(4401, 'hello_required');
        const instance = this.auth.authenticate(msg.token);
        if (!instance) return ws.close(4401, 'unauthorized');
        if (origin.id && instance.origin && instance.origin.toLowerCase() !== origin.id) {
          return ws.close(4403, 'origin_mismatch');
        }
        let open = 0;
        for (const other of this.clients) if (other.instanceId === instance.id) open++;
        if (open >= MAX_SOCKETS_PER_INSTANCE) return ws.close(4429, 'too_many_connections');

        clearTimeout(helloTimer);
        ws.instanceId = instance.id;
        this.lastSeen.set(instance.id, this.now());
        this._sendJson(ws, {
          type: 'ready',
          protocol: PROTOCOL,
          instanceId: instance.id,
          profile: this.registry.getProfile(instance.profileId),
          profiles: this._profileList(instance),
          seq: this.store.seq,
          cloud: this.cloud,
        });
        if (Number.isInteger(msg.since) && msg.since >= 0 && instance.profileId) {
          const palette = this.store.getPalette();
          this._sendJson(ws, {
            type: 'catchup',
            seq: this.store.seq,
            notes: this.store.since(msg.since).filter((n) => this._isOwn(instance, n)).map(publicNote),
            palette: palette && palette.seq > msg.since ? palette : null,
          });
        }
        this.emit('change');
        return undefined;
      }

      if (msg.type === 'ping') this._sendJson(ws, { type: 'pong', t: this.now() });
      return undefined;
    });
  }

  _sendJson(ws, payload) {
    if (ws.readyState === 1) ws.send(JSON.stringify(payload));
  }

  _broadcast(payload, exceptInstanceId = null) {
    const text = JSON.stringify(payload);
    for (const ws of this.clients) {
      if (!ws.instanceId || ws.instanceId === exceptInstanceId || ws.readyState !== 1) continue;
      this._sendBuffered(ws, text);
    }
  }

  _sendBuffered(ws, text) {
    if (ws.bufferedAmount > 8 * 1024 * 1024) {
      ws.terminate(); // cliente que no lee: no acumular memoria
      return;
    }
    ws.send(text);
  }

  _pingSockets() {
    for (const ws of this.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }

  _closeInstance(instanceId) {
    for (const ws of this.clients) if (ws.instanceId === instanceId) ws.close(4403, 'revoked');
  }
}

module.exports = { NotesServer, HttpError, PROTOCOL, publicNote };
