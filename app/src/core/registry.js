'use strict';

// Registro de instancias (cada extensión emparejada) y de perfiles de navegador.
// Los tokens nunca se guardan: solo su hash SHA-256.

const crypto = require('node:crypto');
const path = require('node:path');
const { JsonFile } = require('./jsonfile');

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
  // Un perfil es (navegador, carpeta de perfil). Se crea al asignarlo a una extensión.
  upsertProfile({ browser, dir, name, email }) {
    for (const profile of this.profiles.values()) {
      if (profile.browser === browser && profile.dir === dir) {
        if (name) profile.name = name;
        if (email !== undefined) profile.email = email;
        this.file.markDirty();
        return profile;
      }
    }
    const profile = {
      id: 'p_' + crypto.randomBytes(6).toString('hex'),
      browser,
      dir,
      name: name || dir,
      email: email || '',
    };
    this.profiles.set(profile.id, profile);
    this.file.markDirty();
    return profile;
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

module.exports = { Registry, publicInstance };
