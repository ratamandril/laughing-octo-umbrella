'use strict';

// Réplica en la nube. La app local es la fuente de verdad; Firestore es respaldo y punto de encuentro.
//  - Cola de pendientes sin hooks: se guarda un cursor `seq` y un mapa `known` (id -> updatedAt que Firestore ya tiene).
//    Pendiente = nota con seq > cursor y updatedAt > known[id]. Sobrevive a reinicios y a apagones.
//  - Conflictos: gana el updatedAt más reciente (empate: se queda lo local).
//  - Sin conexión: reintenta con espera creciente (5 s … 5 min). Los cambios se acumulan y se suben al volver.

const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { JsonFile } = require('../jsonfile');
const { BROWSERS, DIR_RE } = require('../profiles');

const PROFILE_ID_RE = /^p_[0-9a-f]{12}$/;
const PUSH_CHUNK = 400;

const hashProfile = (p) => crypto.createHash('sha1').update(JSON.stringify([p.id, p.browser, p.dir, p.name, p.email])).digest('hex');
const validProfile = (p) =>
  p && PROFILE_ID_RE.test(p.id) && BROWSERS.includes(p.browser) && typeof p.dir === 'string' && DIR_RE.test(p.dir) && typeof p.name === 'string' && p.name.length > 0 && p.name.length <= 60;

class SyncEngine extends EventEmitter {
  // remote: objeto con connect/fetchAll/push/listen/close (Firestore o un doble en pruebas)
  constructor({ dir, store, registry, remote = null, now = Date.now, retryMs = [5000, 15000, 60000, 300000], pushDelayMs = 1000, onError } = {}) {
    super();
    this.store = store;
    this.registry = registry;
    this.remote = remote;
    this.now = now;
    this.retryMs = retryMs;
    this.pushDelayMs = pushDelayMs;
    this.state = { cursor: 0, known: {}, paletteKnown: 0, profilesKnown: {}, lastSync: null };
    this.file = new JsonFile(path.join(dir, 'sync.json'), () => ({ version: 1, ...this.state }), { delayMs: 200, onError });
    const saved = this.file.read();
    const projectId = remote ? remote.projectId || null : null;
    if (saved && saved.known && (!projectId || !saved.projectId || saved.projectId === projectId)) {
      this.state = { ...this.state, ...saved, known: saved.known || {}, profilesKnown: saved.profilesKnown || {} };
    }
    this.state.projectId = projectId; // otro proyecto de Firebase = empezar de cero

    this.status = { state: remote ? 'connecting' : 'disabled', pending: 0, lastSync: this.state.lastSync, lastError: null, projectId: remote ? remote.projectId || null : null };
    this.stopped = true;
    this.connected = false;
    this.unlisten = null;
    this.pushTimer = null;
    this.retryTimer = null;
    this.failures = 0;
    this.pushing = null;
    this.dirty = false;
  }

  getStatus() {
    return { ...this.status, pending: this._pendingCount() };
  }

  _set(patch) {
    this.status = { ...this.status, ...patch };
    this.emit('status', this.getStatus());
  }

  // ---------- pendientes ----------
  _pendingNotes() {
    return this.store
      .since(this.state.cursor, { includeDeleted: true })
      .filter((n) => n.updatedAt > (this.state.known[n.id] || 0));
  }

  _pendingProfiles() {
    return this.registry.listProfiles().filter((p) => this.state.profilesKnown[p.id] !== hashProfile(p));
  }

  _pendingPalette() {
    const palette = this.store.getPalette();
    return palette && palette.updatedAt > (this.state.paletteKnown || 0) ? palette : null;
  }

  _pendingCount() {
    if (!this.remote) return 0;
    return this._pendingNotes().length + this._pendingProfiles().length + (this._pendingPalette() ? 1 : 0);
  }

  // ---------- ciclo de vida ----------
  async start() {
    if (!this.remote || !this.stopped) return;
    this.stopped = false;
    await this._connect();
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.pushTimer);
    clearTimeout(this.retryTimer);
    this._unlisten();
    this.connected = false;
    if (this.pushing) await this.pushing.catch(() => {});
    if (this.remote) await this.remote.close().catch(() => {});
    await this.file.flush().catch(() => {});
    this._set({ state: this.remote ? 'stopped' : 'disabled' });
  }

  _unlisten() {
    if (this.unlisten) this.unlisten();
    this.unlisten = null;
  }

  async _connect() {
    if (this.stopped) return;
    this._set({ state: 'connecting' });
    try {
      await this.remote.connect();
      const all = await this.remote.fetchAll();
      const applied = this._merge(all, { initial: true });
      await this._pushPending();
      this._unlisten();
      this.unlisten = this.remote.listen((batch) => this._onRemote(batch), (err) => this._fail(err));
      this.connected = true;
      this.failures = 0;
      this._set({ state: 'online', lastError: null });
      this.emit('applied', applied);
    } catch (err) {
      this._fail(err);
    }
  }

  _fail(err) {
    if (this.stopped) return;
    this._unlisten();
    this.connected = false;
    const message = String((err && err.message) || err).slice(0, 300);
    this._set({ state: 'offline', lastError: message });
    clearTimeout(this.pushTimer);
    clearTimeout(this.retryTimer);
    const wait = this.retryMs[Math.min(this.failures, this.retryMs.length - 1)];
    this.failures++;
    this.retryTimer = setTimeout(() => this._connect(), wait);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  // ---------- local -> nube ----------
  // Avisar de que hay cambios locales (la app lo llama tras cada escritura)
  poke() {
    if (!this.remote || this.stopped) return;
    this.emit('status', this.getStatus());
    if (!this.connected || this.pushTimer) return;
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this._pushPending().catch((err) => this._fail(err));
    }, this.pushDelayMs);
    if (this.pushTimer.unref) this.pushTimer.unref();
  }

  async syncNow() {
    if (!this.remote) return this.getStatus();
    if (!this.connected) {
      clearTimeout(this.retryTimer);
      await this._connect();
    } else {
      try {
        await this._pushPending();
      } catch (err) {
        this._fail(err);
      }
    }
    return this.getStatus();
  }

  _pushPending() {
    if (this.pushing) {
      this.dirty = true;
      return this.pushing;
    }
    this.pushing = (async () => {
      do {
        this.dirty = false;
        const scanSeq = this.store.seq;
        const notes = this._pendingNotes();
        const profiles = this._pendingProfiles();
        const palette = this._pendingPalette();
        if (!notes.length && !profiles.length && !palette) {
          this.state.cursor = Math.max(this.state.cursor, scanSeq);
          this.file.markDirty();
          continue;
        }
        for (let i = 0; i < Math.max(1, Math.ceil(notes.length / PUSH_CHUNK)); i++) {
          const chunk = notes.slice(i * PUSH_CHUNK, (i + 1) * PUSH_CHUNK);
          const last = i === Math.ceil(notes.length / PUSH_CHUNK) - 1 || notes.length === 0;
          await this.remote.push({ notes: chunk, profiles: last ? profiles : [], palette: last ? palette : null });
          for (const n of chunk) this.state.known[n.id] = n.updatedAt;
        }
        for (const p of profiles) this.state.profilesKnown[p.id] = hashProfile(p);
        if (palette) this.state.paletteKnown = palette.updatedAt;
        this.state.cursor = Math.max(this.state.cursor, scanSeq);
        this.state.lastSync = this.now();
        this.file.markDirty();
        this._set({ lastSync: this.state.lastSync });
      } while (this.dirty);
    })().finally(() => {
      this.pushing = null;
    });
    return this.pushing;
  }

  // ---------- nube -> local ----------
  _onRemote(batch) {
    try {
      const applied = this._merge(batch, { initial: false });
      this.emit('applied', applied);
    } catch (err) {
      this._fail(err);
    }
  }

  // Aplica lo remoto que sea más reciente. Devuelve lo que cambió para avisar a las extensiones.
  _merge({ notes = [], profiles = [], palette = null }, { initial }) {
    const applied = { notes: [], palette: null, profiles: false };

    for (const raw of profiles) {
      if (!validProfile(raw)) continue;
      this.state.profilesKnown[raw.id] = hashProfile(raw);
      if (this.registry.importProfile(raw)) applied.profiles = true;
    }
    if (applied.profiles) {
      this.file.markDirty();
      this.registry.file.markDirty();
    }

    for (const raw of notes) {
      if (!raw || typeof raw.id !== 'string') continue;
      const remoteUpdated = Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0;
      const local = this.store.get(raw.id);
      if (!local || remoteUpdated > local.updatedAt) {
        const result = this.store.put({ ...raw, deleted: raw.deleted === true }, { keepTimestamps: true, allowDeleted: true });
        if (result.error) continue; // dato remoto inválido: se ignora
        this.state.known[raw.id] = remoteUpdated;
        applied.notes.push(result.note);
      } else {
        // Lo local es igual o más reciente: Firestore tiene al menos esta versión
        this.state.known[raw.id] = Math.max(this.state.known[raw.id] || 0, Math.min(remoteUpdated, local.updatedAt));
      }
    }

    if (palette && Array.isArray(palette.list)) {
      const updated = this.store.applyPalette(palette);
      this.state.paletteKnown = Math.max(this.state.paletteKnown || 0, Number.isFinite(palette.updatedAt) ? palette.updatedAt : 0);
      if (updated) applied.palette = updated;
    }

    if (initial) this.state.cursor = 0; // revisar todo lo local contra lo remoto
    this.file.markDirty();
    return applied;
  }

  flush() {
    return this.file.flush();
  }
}

module.exports = { SyncEngine };
