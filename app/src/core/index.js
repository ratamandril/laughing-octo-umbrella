'use strict';

// Ensambla el servidor local: datos, autenticación, perfiles, lanzador y servidor HTTP/WebSocket.
// No depende de Electron, así que se puede arrancar solo con Node (src/core/cli.js) y probar en tests.

const fs = require('node:fs');
const { EventEmitter } = require('node:events');
const { Store } = require('./store');
const { Registry } = require('./registry');
const { Auth } = require('./auth');
const { createProfilesProvider } = require('./profiles');
const { createLauncher } = require('./launcher');
const { NotesServer } = require('./server');
const { SyncEngine } = require('./sync/engine');
const { createFirestoreRemote, validateServiceAccount } = require('./sync/firestore-remote');
const path = require('node:path');

const DEFAULT_PORT = 47321;
const TRASH_DAYS = 30;
const version = require('../../package.json').version;

function createCore(options = {}) {
  const dataDir = options.dataDir;
  if (!dataDir) throw new Error('createCore necesita dataDir');
  fs.mkdirSync(dataDir, { recursive: true });

  const events = new EventEmitter();
  const onError = (err) => events.emit('error-storage', err);

  const store = new Store({ dir: dataDir, onError, ...(options.storeOptions || {}) }).load();
  const registry = new Registry({ dir: dataDir, onError }).load();
  const auth = new Auth(registry, options.authOptions);
  const profiles = options.profiles || createProfilesProvider(options.profilesOptions);
  const launcher = options.launcher || createLauncher({ profiles });
  const server = new NotesServer({
    store,
    auth,
    registry,
    profiles,
    launcher,
    port: options.port ?? (Number(process.env.NOTAS_PORT) || DEFAULT_PORT),
    host: options.host,
    allowNoOrigin: options.allowNoOrigin,
    version,
  });

  const notify = () => events.emit('change');

  // ----- respaldo en Firestore (opcional) -----
  const keyFile = path.join(dataDir, 'firebase-key.json');
  const makeRemote = options.remoteFactory || ((serviceAccount) => createFirestoreRemote({ serviceAccount }));
  let sync = null;

  function readKey() {
    try {
      return JSON.parse(fs.readFileSync(keyFile, 'utf8'));
    } catch {
      return null;
    }
  }

  function buildSync(serviceAccount) {
    let remote = null;
    let problem = null;
    if (serviceAccount) {
      try {
        remote = makeRemote(serviceAccount);
      } catch (err) {
        problem = err.message;
      }
    }
    const engine = new SyncEngine({ dir: dataDir, store, registry, remote, onError, ...(options.syncOptions || {}) });
    if (problem) engine.status.lastError = problem;
    engine.on('status', (st) => {
      server.setCloud(st);
      notify();
    });
    server.setCloud(engine.getStatus());
    engine.on('applied', ({ notes, palette, profiles }) => {
      server.broadcastNotes(notes);
      if (palette) server.broadcastPalette(palette);
      if (profiles) server.broadcastProfiles();
      notify();
    });
    return engine;
  }
  sync = buildSync(readKey());
  server.on('change', () => sync.poke());
  server.on('change', notify);
  auth.on('change', notify);
  server.on('error-internal', (err) => events.emit('error-internal', err));

  // ----- papelera -----
  const changed = () => server.emit('change');
  const purgeExpired = () => {
    const gone = store.purgeExpired(TRASH_DAYS * 24 * 3600 * 1000);
    if (gone.length) changed();
    return gone.length;
  };
  let purgeTimer = null;

  // Foto del estado para la interfaz
  async function state() {
    const online = server.onlineInstanceIds();
    const profilesById = new Map(registry.listProfiles().map((p) => [p.id, p]));
    return {
      version,
      running: server.http.listening,
      host: server.host,
      port: server.port,
      dataDir,
      pairing: auth.pairingState(),
      notes: store.count(),
      seq: store.seq,
      instances: registry.listInstances().map((i) => ({
        ...i,
        profile: profilesById.get(i.profileId) || null,
        online: online.has(i.id),
        lastSeen: server.lastSeen.get(i.id) || null,
      })),
      detectedProfiles: await profiles.detect(),
      registeredProfiles: registry.listProfiles(),
      loadWarnings: store.loadWarnings,
      sync: sync.getStatus(),
      trashCount: store.listTrash().length,
      trashDays: TRASH_DAYS,
    };
  }

  return {
    events,
    store,
    registry,
    auth,
    server,
    profiles,
    dataDir,
    state,
    get sync() {
      return sync;
    },
    // ----- cómo comparte cada perfil sus notas -----
    // Lo normal es que lo cambie la propia extensión (Ajustes); esto es el respaldo desde la app
    setSharing(profileId, mode) {
      const profile = registry.setProfileSharing(String(profileId), String(mode));
      if (!profile) return false;
      server.applySharingChange(profile.id);
      changed();
      return true;
    },
    // Abre la nota en su navegador y perfil (desde la propia app)
    openNote: (id) => server.openTarget({ noteId: String(id) }),

    // Todas las notas vivas (vista global de la app)
    notesView() {
      const notes = [...store.notes.values()]
        .filter((n) => !n.deleted)
        .map((n) => ({ id: n.id, title: n.title, description: n.description, url: n.url, host: n.host, scope: n.scope, tags: n.tags, color: n.color, profileId: n.profileId, createdAt: n.createdAt, updatedAt: n.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const palette = store.getPalette();
      return { notes, palette: palette ? palette.list : [], profiles: registry.listProfiles() };
    },
    // Una nota sin perfil no la ve ninguna extensión: solo se puede asignar desde la app
    assignNoteProfile(id, profileId) {
      const note = store.get(String(id));
      if (!note || note.deleted || note.profileId || !registry.getProfile(String(profileId))) return null;
      const result = store.put({ ...note, profileId: String(profileId) });
      if (result.error) return null;
      server.broadcastNotes([result.note]);
      changed();
      return result.note;
    },
    noteUrl: (id) => {
      const note = store.get(String(id));
      return note && !note.deleted ? note.url : null;
    },

    // ----- notas desde la app -----
    trash: () => store.listTrash(),
    deleteNote(id) {
      const note = store.remove(String(id));
      if (note) {
        server.broadcastNotes([note]);
        changed();
      }
      return note;
    },
    restoreNote(id) {
      const note = store.restore(String(id));
      if (note) {
        server.broadcastNotes([note]);
        changed();
      }
      return note;
    },
    purgeNote(id) {
      const note = store.purge(String(id));
      if (note) changed();
      return note;
    },
    emptyTrash() {
      const gone = store.emptyTrash();
      if (gone.length) changed();
      return gone.length;
    },
    purgeExpired,
    async start() {
      const port = await server.start();
      purgeExpired();
      purgeTimer = setInterval(purgeExpired, 6 * 3600 * 1000);
      if (purgeTimer.unref) purgeTimer.unref();
      sync.start().catch((err) => events.emit('error-internal', err)); // no bloquea el arranque si no hay internet
      return port;
    },
    async stop() {
      clearInterval(purgeTimer);
      await sync.stop();
      await server.stop();
    },
    // Recibe el TEXTO del JSON de la cuenta de servicio. Devuelve { ok } o { ok:false, error }.
    async enableSync(text) {
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        return { ok: false, error: 'El archivo no es un JSON válido.' };
      }
      const problem = validateServiceAccount(json);
      if (problem) return { ok: false, error: problem };
      await sync.stop();
      fs.writeFileSync(keyFile, JSON.stringify(json), { mode: 0o600 });
      sync = buildSync(json);
      await sync.start();
      notify();
      return { ok: true, status: sync.getStatus() };
    },
    async disableSync() {
      await sync.stop();
      fs.rmSync(keyFile, { force: true });
      sync = buildSync(null);
      notify();
    },
    syncNow: () => sync.syncNow(),
    newPairingCode: () => auth.createPairingCode(),
    revokeInstance: (id) => auth.revoke(id),
    renameProfile: async (id, name) => {
      const profile = registry.renameProfile(id, String(name).trim().slice(0, 60));
      if (profile) {
        await registry.flush();
        server.broadcastProfiles();
        notify();
      }
      return profile;
    },
  };
}

module.exports = { createCore, DEFAULT_PORT };
