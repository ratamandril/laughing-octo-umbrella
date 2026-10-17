'use strict';

// Fuente de verdad local de las notas y de la paleta de categorías.
//
// Cada cambio recibe un número de secuencia (seq) creciente. Con él las extensiones
// piden "lo que cambió desde N" al reconectarse, y los borrados viajan como
// tombstones (deleted: true) para que una nota eliminada no reaparezca.
//
// Se usa un archivo JSON con escritura atómica en lugar de SQLite: evita un módulo
// nativo que habría que recompilar para Electron en Windows, y para miles de notas
// pequeñas es más que suficiente. La interfaz de esta clase es lo único que usa el resto.

const path = require('node:path');
const { JsonFile } = require('./jsonfile');
const { sanitizeNote, sanitizePalette } = require('./sanitize');

class Store {
  constructor({ dir, now = Date.now, saveDelayMs = 150, onError } = {}) {
    this.now = now;
    this.seq = 0;
    this.notes = new Map();
    this.palette = null; // { list, updatedAt, seq } mientras nadie la haya definido
    this.loadWarnings = [];
    this.file = new JsonFile(path.join(dir, 'notes.json'), () => this._snapshot(), {
      delayMs: saveDelayMs,
      onError,
    });
  }

  load() {
    const data = this.file.read();
    if (!data) return this;
    if (typeof data !== 'object' || typeof data.notes !== 'object' || data.notes === null) {
      const error = new Error('notes.json tiene un formato inesperado');
      error.code = 'CORRUPT';
      throw error;
    }

    let maxSeq = Number(data.seq) || 0;
    for (const [id, raw] of Object.entries(data.notes)) {
      const { note, error } = sanitizeNote({ ...raw, id }, { now: this.now() });
      if (error) {
        this.loadWarnings.push(`nota ${id}: ${error}`);
        continue;
      }
      note.updatedAt = Number(raw.updatedAt) || note.updatedAt;
      note.seq = Number(raw.seq) || 0;
      maxSeq = Math.max(maxSeq, note.seq);
      this.notes.set(id, note);
    }

    if (data.palette && Array.isArray(data.palette.list)) {
      const { list } = sanitizePalette(data.palette.list);
      const seq = Number(data.palette.seq) || 0;
      this.palette = { list, updatedAt: Number(data.palette.updatedAt) || 0, seq };
      maxSeq = Math.max(maxSeq, seq);
    }

    this.seq = maxSeq;
    return this;
  }

  _snapshot() {
    return { version: 1, seq: this.seq, notes: Object.fromEntries(this.notes), palette: this.palette };
  }

  get(id) {
    return this.notes.get(id);
  }

  count() {
    let n = 0;
    for (const note of this.notes.values()) if (!note.deleted) n++;
    return n;
  }

  // Notas cambiadas después de `seq`, en orden. Los tombstones solo se envían a quien ya tiene datos (seq > 0).
  since(seq = 0, { includeDeleted = seq > 0 } = {}) {
    const out = [];
    for (const note of this.notes.values()) {
      if (note.seq > seq && (includeDeleted || !note.deleted)) out.push(note);
    }
    return out.sort((a, b) => a.seq - b.seq);
  }

  // Crea o reemplaza una nota. Devuelve { note, created } o { error }.
  //  - keepTimestamps: conserva el updatedAt recibido (importaciones, sincronización con Firestore).
  //  - allowDeleted: permite que la entrada traiga deleted: true (solo sincronización).
  put(input, { keepTimestamps = false, allowDeleted = false } = {}) {
    const t = this.now();
    const { note, error } = sanitizeNote(input, { now: t });
    if (error) return { error };

    const prev = this.notes.get(note.id);
    const stored = {
      ...note,
      createdAt: prev ? prev.createdAt : note.createdAt,
      updatedAt: keepTimestamps ? note.updatedAt : Math.max(t, (prev ? prev.updatedAt : 0) + 1),
      deleted: allowDeleted ? note.deleted : false,
      seq: ++this.seq,
    };
    if (!stored.deleted) {
      stored.deletedAt = null;
      stored.purged = false;
    }
    this.notes.set(stored.id, stored);
    this.file.markDirty();
    return { note: stored, created: !prev || prev.deleted };
  }

  // Pasa todas las notas (también las de la papelera) de un perfil a otro. Devuelve las notas movidas.
  reassignProfile(fromId, intoId) {
    const moved = [];
    for (const note of [...this.notes.values()]) {
      if (note.profileId !== fromId) continue;
      const stored = { ...note, profileId: intoId, updatedAt: Math.max(this.now(), note.updatedAt + 1), seq: ++this.seq };
      this.notes.set(stored.id, stored);
      moved.push(stored);
    }
    if (moved.length) this.file.markDirty();
    return moved;
  }

  // Manda a la papelera: la nota queda marcada como borrada pero conserva su contenido.
  // Devuelve la nota o null si no existía.
  remove(id) {
    const prev = this.notes.get(id);
    if (!prev || prev.deleted) return null;
    const t = this.now();
    const stored = {
      ...prev,
      deleted: true,
      deletedAt: t,
      purged: false,
      updatedAt: Math.max(t, prev.updatedAt + 1),
      seq: ++this.seq,
    };
    this.notes.set(id, stored);
    this.file.markDirty();
    return stored;
  }

  // Papelera: notas borradas que aún conservan su contenido, las más recientes primero
  listTrash() {
    return [...this.notes.values()].filter((n) => n.deleted && !n.purged).sort((a, b) => (b.deletedAt || 0) - (a.deletedAt || 0));
  }

  // Saca una nota de la papelera. Devuelve la nota restaurada o null.
  restore(id) {
    const prev = this.notes.get(id);
    if (!prev || !prev.deleted || prev.purged) return null;
    const stored = {
      ...prev,
      deleted: false,
      deletedAt: null,
      purged: false,
      updatedAt: Math.max(this.now(), prev.updatedAt + 1),
      seq: ++this.seq,
    };
    this.notes.set(id, stored);
    this.file.markDirty();
    return stored;
  }

  // Elimina el contenido para siempre; queda el marcador para que el borrado se propague.
  purge(id) {
    const prev = this.notes.get(id);
    if (!prev || !prev.deleted || prev.purged) return null;
    const stored = {
      ...prev,
      title: '',
      description: '',
      tags: [],
      purged: true,
      updatedAt: Math.max(this.now(), prev.updatedAt + 1),
      seq: ++this.seq,
    };
    this.notes.set(id, stored);
    this.file.markDirty();
    return stored;
  }

  emptyTrash() {
    return this.listTrash().map((n) => this.purge(n.id));
  }

  // Purga lo que lleva más de maxAgeMs en la papelera
  purgeExpired(maxAgeMs) {
    const limit = this.now() - maxAgeMs;
    return this.listTrash().filter((n) => (n.deletedAt || 0) < limit).map((n) => this.purge(n.id));
  }

  getPalette() {
    return this.palette;
  }

  setPalette(list) {
    const result = sanitizePalette(list);
    if (result.error) return result;
    this.palette = { list: result.list, updatedAt: this.now(), seq: ++this.seq };
    this.file.markDirty();
    return { palette: this.palette };
  }

  // Paleta recibida de la sincronización: conserva su updatedAt y solo se aplica si es más reciente.
  applyPalette(remote) {
    const result = sanitizePalette(remote && remote.list);
    if (result.error) return null;
    const updatedAt = Number.isFinite(remote.updatedAt) ? remote.updatedAt : 0;
    if (this.palette && this.palette.updatedAt >= updatedAt) return null;
    this.palette = { list: result.list, updatedAt, seq: ++this.seq };
    this.file.markDirty();
    return this.palette;
  }

  flush() {
    return this.file.flush();
  }
}

module.exports = { Store };
