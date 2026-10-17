'use strict';

// Registro de instancias (cada extensión emparejada) y de perfiles de navegador.
// Los tokens nunca se guardan: solo su hash SHA-256.

const crypto = require('node:crypto');
const path = require('node:path');
const { JsonFile } = require('./jsonfile');

// Cómo comparte un perfil sus notas con los demás perfiles:
//  private = nadie más las ve · read = las ven en solo lectura · edit = las ven y pueden editarlas (no borrarlas)
const SHARING = ['private', 'read', 'edit'];
const DEFAULT_SHARING = 'read';
const sharingOf = (profile) => (profile && SHARING.includes(profile.sharing) ? profile.sharing : DEFAULT_SHARING);

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const cleanName = (v) => String(v ?? '').trim().slice(0, 60);
// '' si no hay correo; null si lo que se escribió no parece un correo
const cleanEmail = (v) => {
  const mail = String(v ?? '').trim();
  if (!mail) return '';
  return mail.length <= 254 && EMAIL_RE.test(mail) ? mail : null;
};

function publicInstance(instance) {
  if (!instance) return null;
  const { tokenHash, ...rest } = instance; // eslint-disable-line no-unused-vars
  return rest;
}

class Registry {
  constructor({ dir, onError } = {}) {
    this.instances = new Map();
    this.profiles = new Map();
    this.bindings = new Map(); // profileId -> {browser, dir}: solo de esta PC
    this.byTokenHash = new Map();
    this.file = new JsonFile(path.join(dir, 'config.json'), () => this._snapshot(), { delayMs: 50, onError });
  }

  load() {
    const data = this.file.read();
    if (!data) return this;
    for (const inst of Object.values(data.instances || {})) {
      if (inst && typeof inst.id === 'string' && typeof inst.tokenHash === 'string') {
        this.instances.set(inst.id, inst);
        this.byTokenHash.set(inst.tokenHash, inst.id);
      }
    }
    for (const profile of Object.values(data.profiles || {})) {
      if (profile && typeof profile.id === 'string') this.profiles.set(profile.id, profile);
    }
    for (const [id, b] of Object.entries(data.bindings || {})) {
      if (b && this.profiles.has(id) && typeof b.browser === 'string' && typeof b.dir === 'string') this.bindings.set(id, { browser: b.browser, dir: b.dir });
    }
    this._migrate();
    return this;
  }

  _snapshot() {
    return {
      version: 1,
      instances: Object.fromEntries(this.instances),
      profiles: Object.fromEntries(this.profiles),
      bindings: Object.fromEntries(this.bindings),
    };
  }

  // Versiones anteriores guardaban el navegador y la carpeta dentro del perfil: pasan a ser el enlace local de esta PC
  _migrate() {
    let changed = false;
    for (const p of this.profiles.values()) {
      if ('dir' in p || 'browser' in p || 'emailManual' in p) {
        if (typeof p.dir === 'string' && p.dir && typeof p.browser === 'string' && !p.mergedInto) {
          const taken = [...this.bindings].some(([id, b]) => id !== p.id && b.browser === p.browser && b.dir === p.dir);
          if (!taken && !this.bindings.has(p.id)) this.bindings.set(p.id, { browser: p.browser, dir: p.dir });
        }
        delete p.dir;
        delete p.browser;
        delete p.emailManual;
        changed = true;
      }
      if (!SHARING.includes(p.sharing)) { p.sharing = DEFAULT_SHARING; changed = true; }
    }
    if (changed) this.file.markDirty();
  }

  // ----- instancias -----
  addInstance(instance) {
    this.instances.set(instance.id, instance);
    this.byTokenHash.set(instance.tokenHash, instance.id);
    this.file.markDirty();
    return instance;
  }

  removeInstance(id) {
    const instance = this.instances.get(id);
    if (!instance) return false;
    this.instances.delete(id);
    this.byTokenHash.delete(instance.tokenHash);
    this.file.markDirty();
    return true;
  }

  getInstance(id) {
    return this.instances.get(id) || null;
  }

  findByTokenHash(hash) {
    const id = this.byTokenHash.get(hash);
    return id ? this.instances.get(id) || null : null;
  }

  listInstances() {
    return [...this.instances.values()].map(publicInstance);
  }

  setInstanceProfile(instanceId, profileId) {
    const instance = this.instances.get(instanceId);
    if (!instance) return false;
    instance.profileId = profileId;
    this.file.markDirty();
    return true;
  }

  // ----- cuentas ("perfiles" en el código y en el protocolo) -----
  // Una cuenta es una identidad que elige el usuario: {id, name, email, sharing}. Las notas pertenecen a ella y se
  // sincronizan con Firestore. No guarda nada del navegador: eso es el "enlace local" (abajo), propio de cada PC.
  createProfile({ name, email = '' } = {}) {
    const profile = {
      id: 'p_' + crypto.randomBytes(6).toString('hex'),
      name: cleanName(name) || 'Cuenta',
      email: cleanEmail(email) || '',
      sharing: DEFAULT_SHARING,
    };
    this.profiles.set(profile.id, profile);
    this.file.markDirty();
    return profile;
  }

  // Cambia el nombre y/o el correo (el correo es solo una etiqueta; puede quedar vacío)
  updateProfile(id, { name, email } = {}) {
    const profile = this.profiles.get(id);
    if (!profile) return null;
    if (name !== undefined) {
      const clean = cleanName(name);
      if (!clean) return null;
      profile.name = clean;
    }
    if (email !== undefined) {
      const clean = cleanEmail(email);
      if (clean === null) return null;
      profile.email = clean;
    }
    this.file.markDirty();
    return profile;
  }

  setProfileSharing(id, mode) {
    const profile = this.profiles.get(id);
    if (!profile || !SHARING.includes(mode)) return null;
    profile.sharing = mode;
    this.file.markDirty();
    return profile;
  }

  // Cuenta a la que apunta una cuenta ya unida a otra (sigue la cadena)
  resolveProfileId(id) {
    let current = id;
    for (let i = 0; i < 10; i++) {
      const p = this.profiles.get(current);
      if (!p || !p.mergedInto) return current;
      current = p.mergedInto;
    }
    return current;
  }

  // ----- enlace local: "esta cuenta se abre con este perfil de navegador de esta PC" (uno por cuenta) -----
  setBinding(profileId, browser, dir) {
    if (!this.profiles.has(profileId)) return null;
    for (const [id, b] of this.bindings) if (id !== profileId && b.browser === browser && b.dir === dir) this.bindings.delete(id);
    const binding = { browser, dir };
    this.bindings.set(profileId, binding);
    this.file.markDirty();
    return binding;
  }

  clearBinding(profileId) {
    const had = this.bindings.delete(profileId);
    if (had) this.file.markDirty();
    return had;
  }

  bindingOf(profileId) {
    return this.bindings.get(profileId) || null;
  }

  profileAt(browser, dir) {
    for (const [id, b] of this.bindings) if (b.browser === browser && b.dir === dir) return this.profiles.get(id) || null;
    return null;
  }

  // Une la cuenta `from` en `into`: sus extensiones pasan a `into` y `from` queda marcada como unida (no se borra,
  // para que la sincronización no la reviva). Las notas las mueve quien llama.
  mergeProfile(fromId, intoId) {
    const from = this.profiles.get(fromId);
    const into = this.profiles.get(this.resolveProfileId(intoId));
    if (!from || !into || from === into) return null;
    for (const instance of this.instances.values()) if (instance.profileId === from.id) instance.profileId = into.id;
    const binding = this.bindings.get(from.id);
    this.bindings.delete(from.id);
    if (binding && !this.bindings.has(into.id)) this.bindings.set(into.id, binding);
    if (!into.email && from.email) into.email = from.email;
    from.mergedInto = into.id;
    this.file.markDirty();
    return into;
  }

  // Cuenta recibida de la sincronización: solo se añade si aún no existe ese id; lo que sí se propaga es la unión
  // Devuelve 'added' | 'merged' | false
  importProfile(profile) {
    const known = this.profiles.get(profile.id);
    if (!known) {
      const stored = { id: profile.id, name: profile.name, email: profile.email || '', sharing: sharingOf(profile) };
      if (profile.mergedInto) stored.mergedInto = profile.mergedInto;
      this.profiles.set(stored.id, stored);
      this.file.markDirty();
      return stored.mergedInto ? 'merged' : 'added';
    }
    if (profile.mergedInto && !known.mergedInto && this.profiles.has(profile.mergedInto)) {
      return this.mergeProfile(known.id, profile.mergedInto) ? 'merged' : false;
    }
    return false;
  }

  getProfile(id) {
    return (id && this.profiles.get(id)) || null;
  }

  // Cuentas en uso (las unidas a otra no cuentan)
  listProfiles() {
    return [...this.profiles.values()].filter((p) => !p.mergedInto);
  }

  // Todas, también las unidas: es lo que se sincroniza con Firestore
  listAllProfiles() {
    return [...this.profiles.values()];
  }

  listBindings() {
    return [...this.bindings].map(([profileId, b]) => ({ profileId, ...b }));
  }

  flush() {
    return this.file.flush();
  }
}

module.exports = { Registry, publicInstance, SHARING, DEFAULT_SHARING, sharingOf };
