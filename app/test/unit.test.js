'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { sanitizeNote, sanitizePalette, parseTags, normalizeUrl } = require('../src/core/sanitize');
const { Store } = require('../src/core/store');
const { Registry } = require('../src/core/registry');
const { Auth } = require('../src/core/auth');
const { parseLocalState, createProfilesProvider } = require('../src/core/profiles');
const { createLauncher } = require('../src/core/launcher');
const { EventEmitter } = require('node:events');
const { tmpDir } = require('./helpers');

describe('sanitize', () => {
  test('normaliza una nota válida', () => {
    const { note } = sanitizeNote({ id: 'n1', url: 'https://x.com/a/#frag', title: '  Hola ', tags: 'Mates, #examen, mates', scope: 'domain' }, { now: 1000 });
    assert.equal(note.url, 'https://x.com/a');
    assert.equal(note.host, 'x.com');
    assert.equal(note.title, 'Hola');
    assert.deepEqual(note.tags, ['mates', 'examen']);
    assert.equal(note.scope, 'domain');
    assert.equal(note.deleted, false);
  });

  test('rechaza ids, URLs y perfiles peligrosos', () => {
    for (const bad of [
      { id: '../x', url: 'https://a.com' },
      { id: 'a b', url: 'https://a.com' },
      { id: 'ok', url: 'javascript:alert(1)' },
      { id: 'ok', url: 'file:///etc/passwd' },
      { id: 'ok', url: 'https://a.com', profileId: '../p' },
      { id: 'ok', url: 'https://' + 'a'.repeat(3000) + '.com' },
    ]) {
      assert.ok(sanitizeNote(bad).error, JSON.stringify(bad).slice(0, 60));
    }
    assert.ok(sanitizeNote(null).error);
    assert.ok(sanitizeNote([]).error);
  });

  test('recorta longitudes y limita etiquetas a 10', () => {
    const { note } = sanitizeNote({ id: 'n', url: 'https://a.com', title: 'x'.repeat(500), description: 'y'.repeat(5000), tags: Array.from({ length: 30 }, (_, i) => 't' + i) });
    assert.equal(note.title.length, 150);
    assert.equal(note.description.length, 2000);
    assert.equal(note.tags.length, 10);
  });

  test('"__proto__" como id no contamina objetos', () => {
    const { note } = sanitizeNote({ id: '__proto__', url: 'https://a.com' });
    assert.equal(note.id, '__proto__');
    assert.equal(({}).polluted, undefined);
  });

  test('createdAt no puede estar en el futuro', () => {
    const { note } = sanitizeNote({ id: 'n', url: 'https://a.com', createdAt: 9e12 }, { now: 5000 });
    assert.equal(note.createdAt, 5000);
  });

  test('paleta: descarta inválidas y repetidas, máximo 12', () => {
    const list = [{ id: 'a', hex: '#AABBCC', name: 'A' }, { id: 'a', hex: '#000000' }, { id: 'b', hex: 'rojo' }, { id: '../c', hex: '#111111' }];
    for (let i = 0; i < 20; i++) list.push({ id: 'x' + i, hex: '#123456' });
    const { list: out } = sanitizePalette(list);
    assert.equal(out[0].hex, '#aabbcc');
    assert.equal(out.length, 12);
    assert.ok(sanitizePalette('no').error);
  });

  test('parseTags y normalizeUrl', () => {
    assert.deepEqual(parseTags(' A, a ,#b,,'), ['a', 'b']);
    assert.equal(normalizeUrl('http://x.com/'), 'http://x.com');
    assert.equal(normalizeUrl('http://x.com/p?q=1#z'), 'http://x.com/p?q=1');
  });
});

describe('store', () => {
  const mk = (dir, now) => new Store({ dir, saveDelayMs: 5, now }).load();
  const input = (id, extra = {}) => ({ id, url: 'https://x.com/' + id, title: id, ...extra });

  test('asigna seq creciente y updatedAt monótono', () => {
    let t = 1000;
    const store = mk(tmpDir(), () => t);
    const a = store.put(input('a')).note;
    const b = store.put(input('b')).note;
    assert.ok(b.seq > a.seq);
    const a2 = store.put(input('a', { title: 'nuevo' })).note; // mismo milisegundo
    assert.ok(a2.updatedAt > a.updatedAt);
    assert.equal(a2.createdAt, a.createdAt);
  });

  test('remove manda a la papelera conservando el contenido; since lo reporta solo a quien ya tiene datos', () => {
    const store = mk(tmpDir(), () => 5000);
    store.put(input('a', { description: 'secreto', tags: ['t'] }));
    const afterPut = store.seq;
    const gone = store.remove('a');
    assert.equal(gone.deleted, true);
    assert.equal(gone.purged, false);
    assert.equal(gone.description, 'secreto');
    assert.deepEqual(gone.tags, ['t']);
    assert.equal(gone.deletedAt, 5000);
    assert.equal(store.count(), 0);
    assert.equal(store.since(0).length, 0);
    assert.equal(store.since(afterPut).length, 1);
    assert.equal(store.listTrash().length, 1);
    assert.equal(store.remove('a'), null);
    assert.equal(store.remove('zzz'), null);
  });

  test('papelera: restaurar, purgar, vaciar y caducar', () => {
    let t = 1000;
    const store = mk(tmpDir(), () => t);
    for (const id of ['a', 'b', 'c', 'd']) store.put(input(id, { description: 'd-' + id }));
    for (const id of ['a', 'b', 'c']) store.remove(id);
    const back = store.restore('a');
    assert.equal(back.deleted, false);
    assert.equal(back.deletedAt, null);
    assert.equal(back.description, 'd-a');
    assert.equal(store.count(), 2);
    assert.equal(store.restore('d'), null); // no está en la papelera

    const purged = store.purge('b');
    assert.equal(purged.purged, true);
    assert.equal(purged.title, '');
    assert.equal(purged.description, '');
    assert.equal(store.restore('b'), null); // ya no se puede recuperar
    assert.equal(store.listTrash().length, 1);

    t += 40 * 24 * 3600 * 1000;
    assert.equal(store.purgeExpired(30 * 24 * 3600 * 1000).length, 1);
    assert.equal(store.listTrash().length, 0);
    store.remove('d');
    assert.equal(store.emptyTrash().length, 1);
  });

  test('un marcador antiguo en blanco se lee como purgado y la papelera sobrevive a recargar', async () => {
    const dir = tmpDir();
    const s1 = mk(dir, () => 5000);
    s1.put(input('keep', { description: 'x' }));
    s1.remove('keep');
    await s1.flush();
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')), notes: { ...JSON.parse(fs.readFileSync(path.join(dir, 'notes.json'), 'utf8')).notes, old: { id: 'old', url: 'https://a.com', title: '', description: '', deleted: true, seq: 1, updatedAt: 10 } } }));
    const s2 = mk(dir, () => 5000);
    assert.equal(s2.get('old').purged, true);
    assert.equal(s2.listTrash().length, 1);
    assert.equal(s2.listTrash()[0].description, 'x');
  });

  test('PUT revive una nota borrada, pero no permite deleted:true', () => {
    const store = mk(tmpDir(), () => 5000);
    store.put(input('a'));
    store.remove('a');
    const r = store.put(input('a', { deleted: true }));
    assert.equal(r.note.deleted, false);
    assert.equal(r.created, true);
  });

  test('persiste y recarga, incluidos seq y paleta', async () => {
    const dir = tmpDir();
    const s1 = mk(dir);
    s1.put(input('a'));
    s1.put(input('b'));
    s1.setPalette([{ id: 'c1', hex: '#112233', name: 'Uno' }]);
    const seq = s1.seq;
    await s1.flush();
    const s2 = mk(dir);
    assert.equal(s2.count(), 2);
    assert.equal(s2.seq, seq);
    assert.equal(s2.getPalette().list[0].hex, '#112233');
    assert.equal(s2.put(input('c')).note.seq, seq + 1);
  });

  test('guarda con copia .bak y se recupera si el principal se corrompe', async () => {
    const dir = tmpDir();
    const s1 = mk(dir);
    s1.put(input('a'));
    await s1.flush();
    s1.put(input('b'));
    await s1.flush();
    assert.ok(fs.existsSync(path.join(dir, 'notes.json.bak')));
    fs.writeFileSync(path.join(dir, 'notes.json'), '{basura');
    const s2 = mk(dir); // lee la copia
    assert.equal(s2.count(), 1);
  });

  test('si no hay nada legible lanza CORRUPT en vez de arrancar en blanco', () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'notes.json'), 'no es json');
    assert.throws(() => mk(dir), (err) => err.code === 'CORRUPT');
  });

  test('descarta notas inválidas al cargar y lo avisa', async () => {
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ seq: 3, notes: { ok: { id: 'ok', url: 'https://a.com', seq: 3, updatedAt: 10 }, mala: { id: 'mala', url: 'javascript:1' } } }));
    const store = mk(dir);
    assert.equal(store.count(), 1);
    assert.equal(store.loadWarnings.length, 1);
  });
});

describe('auth', () => {
  const setup = (opts) => {
    const dir = tmpDir();
    const clock = { t: 1_000_000 };
    const registry = new Registry({ dir }).load();
    const auth = new Auth(registry, { now: () => clock.t, ...opts });
    return { dir, clock, registry, auth };
  };

  test('el código tiene formato XXXX-XXXX sin caracteres ambiguos', () => {
    const { auth } = setup();
    for (let i = 0; i < 50; i++) assert.match(auth.createPairingCode().code, /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  test('sirve una vez, acepta minúsculas y sin guion', async () => {
    const { auth } = setup();
    const { code } = auth.createPairingCode();
    const r = await auth.pair({ code: code.toLowerCase().replace('-', ' '), origin: 'chrome-extension://x' });
    assert.equal(r.ok, true);
    assert.equal((await auth.pair({ code, origin: 'chrome-extension://x' })).reason, 'no_code');
  });

  test('caduca a los 5 minutos', async () => {
    const { auth, clock } = setup();
    const { code } = auth.createPairingCode();
    clock.t += 5 * 60 * 1000 + 1;
    assert.equal((await auth.pair({ code })).reason, 'no_code');
    assert.equal(auth.pairingState(), null);
  });

  test('5 intentos fallidos invalidan el código aunque luego se acierte', async () => {
    const { auth } = setup();
    const { code } = auth.createPairingCode();
    for (let i = 0; i < 4; i++) assert.equal((await auth.pair({ code: 'AAAA-AAAA' })).reason, 'invalid_code');
    assert.equal((await auth.pair({ code: 'AAAA-AAAA' })).reason, 'locked');
    assert.equal((await auth.pair({ code })).reason, 'no_code');
  });

  test('el token no se guarda en claro y se puede revocar', async () => {
    const { auth, registry, dir } = setup();
    const { code } = auth.createPairingCode();
    const { token, instance } = await auth.pair({ code, origin: 'chrome-extension://x' });
    assert.ok(!fs.readFileSync(path.join(dir, 'config.json'), 'utf8').includes(token));
    assert.equal(auth.authenticate(token).id, instance.id);
    assert.equal(auth.authenticate(token + 'x'), null);
    assert.equal(auth.authenticate(''), null);
    assert.equal(auth.authenticate(undefined), null);
    assert.equal(auth.revoke(instance.id), true);
    assert.equal(auth.authenticate(token), null);
    assert.equal(registry.listInstances().length, 0);
  });

  test('las instancias y su token sobreviven a un reinicio', async () => {
    const { auth, dir } = setup();
    const { code } = auth.createPairingCode();
    const { token } = await auth.pair({ code, origin: 'chrome-extension://x' });
    const registry2 = new Registry({ dir }).load();
    assert.ok(new Auth(registry2).authenticate(token));
  });
});

describe('perfiles y lanzador', () => {
  const LOCAL_STATE = JSON.stringify({
    profile: {
      info_cache: {
        'Profile 10': { name: 'Diez', user_name: 'd@x.com' },
        'Profile 2': { name: 'Dos', user_name: 'b@x.com', gaia_name: 'Bea' },
        Default: { name: 'Persona 1', user_name: '' },
        '../evil': { name: 'malo' },
        'a/b': { name: 'malo' },
      },
    },
  });

  test('parseLocalState ordena (Default primero, orden natural) y descarta carpetas sospechosas', () => {
    const list = parseLocalState(LOCAL_STATE);
    assert.deepEqual(list.map((p) => p.dir), ['Default', 'Profile 2', 'Profile 10']);
    assert.equal(list[1].email, 'b@x.com');
    assert.equal(list[1].gaiaName, 'Bea');
    assert.deepEqual(parseLocalState('basura'), []);
    assert.deepEqual(parseLocalState('{}'), []);
  });

  test('detect lee Chrome y Edge y tolera que uno no exista', async () => {
    const root = tmpDir();
    const chromeDir = path.join(root, 'chrome');
    fs.mkdirSync(chromeDir);
    fs.writeFileSync(path.join(chromeDir, 'Local State'), LOCAL_STATE);
    const provider = createProfilesProvider({ userDataDirs: { chrome: chromeDir, edge: path.join(root, 'no-existe') }, cacheMs: 0 });
    const list = await provider.detect();
    assert.equal(list.length, 3);
    assert.ok(list.every((p) => p.browser === 'chrome'));
  });

  test('findExecutable busca en las rutas habituales de Windows', () => {
    const env = { ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' };
    const existing = new Set(['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe']);
    const provider = createProfilesProvider({ env, platform: 'win32', exists: (f) => existing.has(f) });
    assert.equal(provider.findExecutable('edge'), 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe');
    assert.equal(provider.findExecutable('chrome'), null);
    const manual = createProfilesProvider({ env, platform: 'win32', exists: () => true, browserPaths: { chrome: 'D:\\chrome.exe' } });
    assert.equal(manual.findExecutable('chrome'), 'D:\\chrome.exe');
  });

  const fakeSpawn = (calls, { fail = false } = {}) => (exe, args, options) => {
    calls.push({ exe, args, options });
    const child = new EventEmitter();
    child.unref = () => {};
    process.nextTick(() => (fail ? child.emit('error', new Error('ENOENT')) : child.emit('spawn')));
    return child;
  };

  test('el lanzador pasa los argumentos como lista, sin shell', async () => {
    const calls = [];
    const launcher = createLauncher({ profiles: { findExecutable: () => 'C:\\msedge.exe' }, spawn: fakeSpawn(calls) });
    await launcher.open({ browser: 'edge', dir: 'Profile 2', url: 'https://x.com/a?b=1&c=2' });
    assert.deepEqual(calls[0].args, ['--profile-directory=Profile 2', 'https://x.com/a?b=1&c=2']);
    assert.equal(calls[0].options.detached, true);
    assert.equal(calls[0].options.shell, undefined);
  });

  test('el lanzador rechaza entradas peligrosas', async () => {
    const launcher = createLauncher({ profiles: { findExecutable: () => 'x' }, spawn: fakeSpawn([]) });
    const code = async (arg) => launcher.open(arg).catch((e) => e.code);
    assert.equal(await code({ browser: 'firefox', dir: 'Default', url: 'https://a.com' }), 'invalid_browser');
    assert.equal(await code({ browser: 'edge', dir: '../x', url: 'https://a.com' }), 'invalid_profile');
    assert.equal(await code({ browser: 'edge', dir: 'Default" --evil', url: 'https://a.com' }), 'invalid_profile');
    assert.equal(await code({ browser: 'edge', dir: 'Default', url: 'file:///c:/x' }), 'invalid_url');
    assert.equal(await code({ browser: 'edge', dir: 'Default', url: '--flag' }), 'invalid_url');
    const none = createLauncher({ profiles: { findExecutable: () => null }, spawn: fakeSpawn([]) });
    assert.equal(await none.open({ browser: 'edge', dir: 'Default', url: 'https://a.com' }).catch((e) => e.code), 'browser_not_found');
    const failing = createLauncher({ profiles: { findExecutable: () => 'x' }, spawn: fakeSpawn([], { fail: true }) });
    assert.equal(await failing.open({ browser: 'edge', dir: 'Default', url: 'https://a.com' }).catch((e) => e.code), 'spawn_failed');
  });
});

describe('revisión de seguridad (regresiones)', () => {
  test('DIR_RE rechaza "..", "." y bordes con espacio o punto', () => {
    const { DIR_RE } = require('../src/core/profiles');
    for (const bad of ['..', '.', ' Default', 'Default ', 'Default.', '.x']) assert.ok(!DIR_RE.test(bad), bad);
    for (const good of ['Default', 'Profile 1', 'Guest Profile', 'Profile (2)']) assert.ok(DIR_RE.test(good), good);
  });
});
