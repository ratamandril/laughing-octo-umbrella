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

function publicInstance(instance) {
  if (!instance) return null;
  const { tokenHash, ...rest } = instance; // eslint-disable-line no-unused-vars
  return rest;
}

class Registry {
  constructor({ dir, onError } = {}) {
    this.instances = new Map();
    this.profiles = new Map();
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
    return this;
  }

  _snapshot() {
    return {
      version: 1,
      instances: Object.fromEntries(this.instances),
      profiles: Object.fromEntries(this.profiles),
    };
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

  // ----- perfiles -----
  // Un perfil es (navegador, carpeta de perfil) y, si el navegador tiene sesión, su correo.
  // Se crea al asignarlo a una extensión. Para no atribuir notas a otra cuenta:
  //  1. si ya hay un perfil del mismo navegador con ese correo, es el mismo (aunque la carpeta sea distinta: otro equipo);
  //  2. si la carpeta coincide pero el correo es otro, NO se sobrescribe: se crea un perfil nuevo y el anterior
  //     queda "sin vincular" en este equipo (dir vacío) conservando su correo y sus notas.
  upsertProfile({ browser, dir, name, email }) {
    const mail = String(email || '').trim().toLowerCase();
    let found = null;
    if (mail) found = [...this.profiles.values()].find((p) => p.browser === browser && String(p.email || '').toLowerCase() === mail) || null;
    if (!found) {
      const sameDir = [...this.profiles.values()].find((p) => p.browser === browser && p.dir === dir);
      if (sameDir) {
        const known = String(sameDir.email || '').toLowerCase();
        if (known && mail && known !== mail) sameDir.dir = ''; // era otra cuenta: queda sin vincular
        else found = sameDir;
      }
    }
    if (found) {
      // La carpeta puede ser otra (otro equipo): solo se mueve si nadie más la ocupa
      if (found.dir !== dir && ![...this.profiles.values()].some((p) => p !== found && p.browser === browser && p.dir === dir)) found.dir = dir;
      if (name) found.name = name;
      if (email && !found.email) found.email = email;
      if (!SHARING.includes(found.sharing)) found.sharing = DEFAULT_SHARING;
      this.file.markDirty();
      return found;
    }
    const profile = {
      id: 'p_' + crypto.randomBytes(6).toString('hex'),
      browser,
      dir,
      name: name || dir,
      email: email || '',
      sharing: DEFAULT_SHARING,
    };
    this.profiles.set(profile.id, profile);
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

  // Perfil recibido de la sincronización: solo se añade si aún no existe ese id
  importProfile(profile) {
    if (this.profiles.has(profile.id)) return false;
    this.profiles.set(profile.id, { id: profile.id, browser: profile.browser, dir: profile.dir, name: profile.name, email: profile.email || '', sharing: sharingOf(profile) });
    this.file.markDirty();
    return true;
  }

  renameProfile(id, name) {
    const profile = this.profiles.get(id);
    if (!profile) return null;
    profile.name = name;
    this.file.markDirty();
    return profile;
  }

  getProfile(id) {
    return (id && this.profiles.get(id)) || null;
  }

  listProfiles() {
    return [...this.profiles.values()];
  }

  flush() {
    return this.file.flush();
  }
}

module.exports = { Registry, publicInstance, SHARING, DEFAULT_SHARING, sharingOf };
