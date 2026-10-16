'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Store } = require('../src/core/store');
const { Registry } = require('../src/core/registry');
const { SyncEngine } = require('../src/core/sync/engine');
const { validateServiceAccount, createFirestoreRemote } = require('../src/core/sync/firestore-remote');
const { tmpDir, startCore, fakeProfiles, sleep } = require('./helpers');

// Doble en memoria de Firestore, con corte de red simulable
class FakeRemote {
  constructor(cloud = { notes: new Map(), profiles: new Map(), palette: null }) {
    this.cloud = cloud;
    this.projectId = 'proj-1';
    this.down = false;
    this.listener = null;
    this.pushes = [];
  }
  _check() { if (this.down) throw new Error('sin conexión'); }
  async connect() { this._check(); }
  async fetchAll() {
    this._check();
    return { notes: [...this.cloud.notes.values()].map((n) => ({ ...n })), profiles: [...this.cloud.profiles.values()], palette: this.cloud.palette };
  }
  async push({ notes = [], profiles = [], palette = null }) {
    this._check();
    this.pushes.push({ notes: notes.map((n) => n.id), profiles: profiles.length, palette: !!palette });
    const echo = { notes: [], profiles: [], palette: null };
    for (const n of notes) { const { seq, ...rest } = n; this.cloud.notes.set(n.id, rest); echo.notes.push(rest); }
    for (const p of profiles) { this.cloud.profiles.set(p.id, p); echo.profiles.push(p); }
    if (palette) { this.cloud.palette = { list: palette.list, updatedAt: palette.updatedAt }; echo.palette = this.cloud.palette; }
    if (this.listener) this.listener.onBatch(echo); // Firestore devuelve también lo propio
  }
  listen(onBatch, onError) { this.listener = { onBatch, onError }; return () => { this.listener = null; }; }
  async close() {}
  // Cambio hecho "desde otro equipo"
  external(note) { this.cloud.notes.set(note.id, note); if (this.listener) this.listener.onBatch({ notes: [note] }); }
  cut() { this.down = true; if (this.listener) this.listener.onError(new Error('conexión perdida')); }
}

const mkEngine = (dir, remote, extra = {}) => {
  const store = new Store({ dir, saveDelayMs: 5 }).load();
  const registry = new Registry({ dir }).load();
  const engine = new SyncEngine({ dir, store, registry, remote, pushDelayMs: 5, retryMs: [20, 40], ...extra });
  return { store, registry, engine, dir };
};
const n = (id, extra = {}) => ({ id, url: 'https://x.com/' + id, title: id, ...extra });

describe('sync con Firestore (doble en memoria)', () => {
  test('sin remoto queda desactivado y no hace nada', async () => {
    const { engine } = mkEngine(tmpDir(), null);
    await engine.start();
    assert.equal(engine.getStatus().state, 'disabled');
    engine.poke();
    assert.equal(engine.getStatus().pending, 0);
  });

  test('primer arranque: sube todo lo local, incluida la paleta y los perfiles', async () => {
    const remote = new FakeRemote();
    const { store, registry, engine } = mkEngine(tmpDir(), remote);
    store.put(n('a'));
    store.put(n('b'));
    store.remove('b');
    store.setPalette([{ id: 'r', hex: '#ff0000', name: 'Rojo' }]);
    registry.upsertProfile({ browser: 'chrome', dir: 'Default', name: 'Personal' });
    await engine.start();
    assert.equal(engine.getStatus().state, 'online');
    assert.equal(engine.getStatus().pending, 0);
    assert.equal(remote.cloud.notes.size, 2);
    assert.equal(remote.cloud.notes.get('b').deleted, true); // el borrado también viaja
    assert.equal(remote.cloud.profiles.size, 1);
    assert.equal(remote.cloud.palette.list[0].hex, '#ff0000');
    assert.ok(!('seq' in remote.cloud.notes.get('a')));
    await engine.stop();
  });

  test('un cambio local se sube solo (sin repetir lo ya subido)', async () => {
    const remote = new FakeRemote();
    const { store, engine } = mkEngine(tmpDir(), remote);
    store.put(n('a'));
    await engine.start();
    remote.pushes.length = 0;
    store.put(n('c'));
    engine.poke();
    await sleep(60);
    assert.deepEqual(remote.pushes.map((p) => p.notes), [['c']]);
    await engine.stop();
  });

  test('recuperación: un equipo vacío descarga todo de la nube y avisa a las extensiones', async () => {
    const remote = new FakeRemote();
    const first = mkEngine(tmpDir(), remote);
    first.store.put(n('a', { description: 'hola' }));
    first.store.put(n('b'));
    first.registry.upsertProfile({ browser: 'edge', dir: 'Profile 1', name: 'Trabajo' });
    await first.engine.start();
    await first.engine.stop();

    const second = mkEngine(tmpDir(), new FakeRemote(remote.cloud)); // laptop nueva
    let applied = null;
    second.engine.on('applied', (a) => { applied = a; });
    await second.engine.start();
    assert.equal(second.store.count(), 2);
    assert.equal(second.store.get('a').description, 'hola');
    assert.equal(second.registry.listProfiles().length, 1);
    assert.equal(applied.notes.length, 2);
    assert.equal(second.engine.getStatus().pending, 0);
    await second.engine.stop();
  });

  test('un cambio remoto posterior se aplica, se avisa y no rebota hacia la nube', async () => {
    const remote = new FakeRemote();
    const { store, engine } = mkEngine(tmpDir(), remote);
    store.put(n('a', { title: 'viejo' }));
    await engine.start();
    const applied = [];
    engine.on('applied', (a) => applied.push(a));
    remote.pushes.length = 0;
    remote.external({ ...n('a', { title: 'desde otro equipo' }), updatedAt: Date.now() + 5000, createdAt: 1, deleted: false, tags: [], description: '', scope: 'url', color: '', profileId: null, host: 'x.com' });
    assert.equal(store.get('a').title, 'desde otro equipo');
    assert.equal(applied[0].notes[0].id, 'a');
    engine.poke();
    await sleep(40);
    assert.equal(remote.pushes.length, 0);
    await engine.stop();
  });

  test('conflicto: gana el updatedAt más reciente; un remoto viejo no pisa lo local', async () => {
    const remote = new FakeRemote();
    const { store, engine } = mkEngine(tmpDir(), remote);
    store.put(n('a', { title: 'local' }));
    await engine.start();
    remote.external({ ...n('a', { title: 'antiguo' }), updatedAt: 1, createdAt: 1 });
    assert.equal(store.get('a').title, 'local');
    await engine.stop();
  });

  test('un borrado remoto se propaga como tombstone', async () => {
    const remote = new FakeRemote();
    const { store, engine } = mkEngine(tmpDir(), remote);
    store.put(n('a'));
    await engine.start();
    remote.external({ ...n('a'), deleted: true, title: '', updatedAt: Date.now() + 9000, createdAt: 1 });
    assert.equal(store.get('a').deleted, true);
    assert.equal(store.count(), 0);
    await engine.stop();
  });

  test('datos remotos inválidos se ignoran (no rompen ni se guardan)', async () => {
    const remote = new FakeRemote();
    const { store, registry, engine } = mkEngine(tmpDir(), remote);
    await engine.start();
    remote.external({ id: 'mala', url: 'javascript:alert(1)', updatedAt: Date.now() + 1 });
    remote.listener.onBatch({ profiles: [{ id: '../x', browser: 'chrome', dir: '..', name: 'x' }, { id: 'p_aaaaaaaaaaaa', browser: 'chrome', dir: '..', name: 'x' }] });
    assert.equal(store.get('mala'), undefined);
    assert.equal(registry.listProfiles().length, 0);
    await engine.stop();
  });

  test('un perfil de otro equipo (sin carpeta) y su modo de compartición se importan', async () => {
    const remote = new FakeRemote();
    const { registry, engine } = mkEngine(tmpDir(), remote);
    await engine.start();
    remote.listener.onBatch({ profiles: [{ id: 'p_bbbbbbbbbbbb', browser: 'edge', dir: '', name: 'Trabajo', email: 't@x.com', sharing: 'private' }] });
    const p = registry.getProfile('p_bbbbbbbbbbbb');
    assert.deepEqual([p.dir, p.email, p.sharing], ['', 't@x.com', 'private']);
    await engine.stop();
  });

  test('sin conexión acumula, reintenta y sube todo al volver', async () => {
    const remote = new FakeRemote();
    remote.down = true;
    const { store, engine } = mkEngine(tmpDir(), remote);
    store.put(n('a'));
    await engine.start();
    assert.equal(engine.getStatus().state, 'offline');
    assert.match(engine.getStatus().lastError, /sin conexión/);
    store.put(n('b'));
    assert.equal(engine.getStatus().pending, 2);
    remote.down = false;
    await sleep(150);
    assert.equal(engine.getStatus().state, 'online');
    assert.equal(remote.cloud.notes.size, 2);
    await engine.stop();
  });

  test('si se corta la escucha pasa a offline y se recupera', async () => {
    const remote = new FakeRemote();
    const { store, engine } = mkEngine(tmpDir(), remote);
    await engine.start();
    remote.cut();
    assert.equal(engine.getStatus().state, 'offline');
    store.put(n('z'));
    remote.down = false;
    await sleep(120);
    assert.equal(engine.getStatus().state, 'online');
    assert.ok(remote.cloud.notes.has('z'));
    await engine.stop();
  });

  test('los pendientes sobreviven a un reinicio de la app', async () => {
    const remote = new FakeRemote();
    remote.down = true;
    const dir = tmpDir();
    const one = mkEngine(dir, remote);
    one.store.put(n('a'));
    await one.engine.start();
    await one.store.flush();
    await one.engine.stop();
    remote.down = false;
    const two = mkEngine(dir, remote);
    await two.engine.start();
    assert.ok(remote.cloud.notes.has('a'));
    remote.pushes.length = 0;
    await two.engine.stop();
    const three = mkEngine(dir, remote); // ya sincronizado: no vuelve a subir nada
    await three.engine.start();
    assert.equal(remote.pushes.length, 0);
    await three.engine.stop();
  });

  test('cambiar de proyecto de Firebase reinicia el estado y sube todo al nuevo', async () => {
    const dir = tmpDir();
    const r1 = new FakeRemote();
    const one = mkEngine(dir, r1);
    one.store.put(n('a'));
    await one.engine.start();
    await one.store.flush();
    await one.engine.stop();
    const r2 = new FakeRemote();
    r2.projectId = 'proj-2';
    const two = mkEngine(dir, r2);
    await two.engine.start();
    assert.ok(r2.cloud.notes.has('a'));
    await two.engine.stop();
  });

  test('syncNow fuerza el reintento inmediato', async () => {
    const remote = new FakeRemote();
    remote.down = true;
    const { store, engine } = mkEngine(tmpDir(), remote, { retryMs: [100000] });
    store.put(n('a'));
    await engine.start();
    remote.down = false;
    const status = await engine.syncNow();
    assert.equal(status.state, 'online');
    assert.ok(remote.cloud.notes.has('a'));
    await engine.stop();
  });
});

describe('clave de cuenta de servicio', () => {
  const good = { type: 'service_account', project_id: 'p', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', client_email: 'a@p.iam.gserviceaccount.com' };
  test('valida los campos obligatorios', () => {
    assert.equal(validateServiceAccount(good), null);
    assert.ok(validateServiceAccount({ ...good, type: 'authorized_user' }));
    assert.ok(validateServiceAccount({ ...good, private_key: 'x' }));
    assert.ok(validateServiceAccount({ ...good, project_id: undefined }));
    assert.ok(validateServiceAccount(null));
    assert.throws(() => createFirestoreRemote({ serviceAccount: { type: 'x' } }));
  });

  test('el núcleo guarda la clave solo si es válida, la usa y se puede quitar', async () => {
    const remote = new FakeRemote();
    const ctx = await startCore({ core: { remoteFactory: () => remote } });
    try {
      assert.equal(ctx.core.sync.getStatus().state, 'disabled');
      assert.equal((await ctx.core.enableSync('no json')).ok, false);
      assert.equal((await ctx.core.enableSync(JSON.stringify({ type: 'service_account' }))).ok, false);
      assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'firebase-key.json')));

      ctx.core.store.put(n('a'));
      const res = await ctx.core.enableSync(JSON.stringify(good));
      assert.equal(res.ok, true);
      assert.equal(res.status.state, 'online');
      assert.ok(remote.cloud.notes.has('a'));
      assert.equal((await ctx.core.state()).sync.state, 'online');

      await ctx.core.disableSync();
      assert.ok(!fs.existsSync(path.join(ctx.dataDir, 'firebase-key.json')));
      assert.equal(ctx.core.sync.getStatus().state, 'disabled');
    } finally {
      await ctx.close();
    }
  });
});

describe('adaptador de Firestore (SDK simulado)', () => {
  const good = { type: 'service_account', project_id: 'p', private_key: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n', client_email: 'a@p.iam.gserviceaccount.com' };
  function fakeAdmin() {
    const log = { sets: [], commits: 0, deleted: false };
    const doc = (colName, id) => ({ colName, id, get: async () => ({ exists: false }), onSnapshot: () => () => {} });
    const db = {
      settings() {},
      collection: (name) => ({ doc: (id) => doc(name, id), get: async () => ({ docs: [] }), onSnapshot: () => () => {} }),
      batch: () => {
        const ops = [];
        return { set: (ref, data) => ops.push([ref, data]), commit: async () => { log.commits++; log.sets.push(...ops); } };
      },
    };
    return {
      log,
      modules: {
        app: { initializeApp: () => ({ delete: async () => { log.deleted = true; } }), cert: (x) => x },
        firestore: { getFirestore: () => db },
      },
    };
  }

  test('sube por lotes, sin seq, y cierra la app', async () => {
    const { log, modules } = fakeAdmin();
    const remote = createFirestoreRemote({ serviceAccount: good, adminModules: modules });
    await remote.connect();
    const notes = Array.from({ length: 450 }, (_, i) => ({ id: 'n' + i, seq: i, title: 't', updatedAt: 1 }));
    await remote.push({ notes, profiles: [{ id: 'p_aaaaaaaaaaaa' }], palette: { list: [], updatedAt: 3, seq: 9 } });
    assert.equal(log.commits, 2); // 452 operaciones en lotes de 400
    assert.equal(log.sets.length, 452);
    assert.ok(log.sets.every(([, data]) => !('seq' in data)));
    assert.deepEqual(log.sets.at(-1)[0], { colName: 'meta', id: 'palette', get: log.sets.at(-1)[0].get, onSnapshot: log.sets.at(-1)[0].onSnapshot });
    await remote.close();
    assert.equal(log.deleted, true);
  });
});
