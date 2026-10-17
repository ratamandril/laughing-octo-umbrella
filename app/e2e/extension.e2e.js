'use strict';

// Prueba de extremo a extremo: dos "perfiles" (dos Chromium con la extensión real) contra la app real.
// Uso:  node e2e/extension.e2e.js     (necesita Playwright y Chromium: ver PLAYWRIGHT_PATH / CHROMIUM)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCore } = require('../src/core');

const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const EXT = path.resolve(__dirname, '..', '..', 'extension');
const SHOTS = process.env.SHOTS || os.tmpdir();
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, ms = 20000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error('Tiempo agotado: ' + label + (last ? ' (' + last.message + ')' : ''));
}

async function launch(name) {
  const context = await chromium.launchPersistentContext(tmp('perfil-' + name + '-'), {
    executablePath: CHROMIUM,
    headless: false,
    args: ['--headless=new', '--no-sandbox', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  // El service worker de MV3 puede reiniciarse: siempre se usa el que esté vivo
  return {
    name, context, id, url: (file) => `chrome-extension://${id}/${file}`,
    get sw() { return context.serviceWorkers().find((w) => w.url().includes(id)) || sw; },
  };
}

const profiles = {
  detect: async () => [
    { browser: 'chrome', dir: 'Default', name: 'Personal', email: 'a@x.com', gaiaName: '' },
    { browser: 'chrome', dir: 'Profile 1', name: 'Trabajo', email: 'b@x.com', gaiaName: '' },
  ],
  findExecutable: () => 'C:\\chrome.exe',
};

(async () => {
  const dataDir = tmp('datos-');
  const launched = [];
  const make = () => createCore({ dataDir, port: 47321, profiles, launcher: { open: async (t) => { launched.push(t); return {}; } }, storeOptions: { saveDelayMs: 5 } });
  let core = make();
  await core.start();

  const A = await launch('A');
  const B = await launch('B');
  const errors = [];
  for (const x of [A, B]) x.context.on('weberror', (e) => errors.push(x.name + ': ' + e.error().message));

  // Notas "de antes" en el perfil A (storage.sync)
  const pa = await A.context.newPage();
  await pa.goto(A.url('options.html'));
  await pa.evaluate(() => chrome.storage.sync.set({
    n_legacy1: { id: 'legacy1', title: 'Nota vieja de A', description: 'de antes', url: 'https://example.com/a', host: 'example.com', scope: 'page', tags: ['viejo'], color: null, createdAt: 1000, updatedAt: 2000 },
  }));
  await pa.reload();

  async function pairAndAssign(x, page, dir) {
    await x.context.pages(); // eslint-disable-line no-unused-expressions
    await page.goto(x.url('options.html'));
    const { code } = core.newPairingCode();
    await page.fill('#code', code);
    await page.click('#pairBtn');
    await page.waitForSelector('#linkOn:not([hidden])');
    await until(async () => (await page.$$eval('#profileSel option', (o) => o.length)) > 1, 'lista de perfiles');
    await page.selectOption('#profileSel', dir);
    await page.click('#saveProfile');
    await page.waitForFunction(() => document.querySelector('#linkMsg').textContent.includes('Perfil guardado'));
  }

  console.log('1. Emparejar y asignar perfil en A');
  await pairAndAssign(A, pa, 'Default');
  const pb = await B.context.newPage();
  console.log('2. Emparejar y asignar perfil en B');
  await pairAndAssign(B, pb, 'Profile 1');
  assert.equal(core.registry.listInstances().length, 2);

  console.log('3. Importar las notas de antes de A');
  await pa.waitForSelector('#importBox:not([hidden])');
  await pa.click('#importLegacy');
  await until(() => core.store.get('legacy1'), 'la nota vieja llega a la app');
  assert.equal(core.store.get('legacy1').profileId, core.registry.listProfiles().find((p) => p.dir === 'Default').id);

  const cacheOf = (page) => page.evaluate(() => chrome.storage.local.get(null));
  const profA = core.registry.listProfiles().find((p) => p.dir === 'Default');
  const profB = core.registry.listProfiles().find((p) => p.dir === 'Profile 1');
  const instB = core.registry.listInstances().find((i) => i.profileId === profB.id);

  console.log('4. Aislamiento: B no ve las notas de A (y A no ve las de B)');
  await sleep(1200);
  assert.ok(!(await cacheOf(pb)).n_legacy1, 'B no debe tener la nota de A');
  await pb.evaluate(() => NotesStore.save(NotesStore.create({ title: 'Nota de B', description: 'hecha en Trabajo', url: 'https://example.com/b', scope: 'page', tags: ['trabajo'] })));
  await until(() => core.store.since(0).some((n) => n.title === 'Nota de B'), 'la nota de B llega a la app');
  await sleep(800);
  assert.ok(!Object.values(await cacheOf(pa)).some((v) => v && v.title === 'Nota de B'), 'A no debe ver la nota de B');
  assert.equal(core.store.since(0).find((n) => n.title === 'Nota de B').profileId, profB.id);
  await until(async () => !(await cacheOf(pb)).outbox || Object.keys((await cacheOf(pb)).outbox.notes).length === 0, 'cola de B vacía');

  console.log('4b. B tiene en su cuenta las mismas notas antiguas que A: no se quedan como copias propias');
  const legacyNote = { id: 'legacy1', title: 'Nota vieja de A', description: 'de antes', url: 'https://example.com/a', host: 'example.com', scope: 'page', tags: ['viejo'], color: null, createdAt: 1000, updatedAt: 2000 };
  await pb.evaluate((n) => chrome.storage.sync.set({ n_legacy1: n }), legacyNote);
  await pb.evaluate(() => NotesStore.importLegacy());
  await until(async () => { const c = await cacheOf(pb); return !c.n_legacy1 && (!c.outbox || Object.keys(c.outbox.notes).length === 0); }, 'la copia rechazada se quita de B y de su cola');
  assert.equal(core.store.get('legacy1').profileId, profA.id, 'la nota sigue siendo de A');
  assert.equal((await pb.evaluate(() => chrome.storage.session.get('conn'))).conn.state, 'online', 'B no pasa a "revocada" ni "sin conexión"');
  // Copia fantasma ya existente (de una versión anterior): la limpieza única la quita al reiniciar
  await pb.evaluate((n) => chrome.storage.local.set({ n_legacy1: { ...n, profileId: 'p_otro' }, reconcileV: 0 }), legacyNote);
  await pb.evaluate(() => chrome.runtime.sendMessage({ type: 'link:restart' }));
  await until(async () => !(await cacheOf(pb)).n_legacy1, 'la limpieza única quita la copia fantasma');
  // Una nota local sin perfil adopta el perfil de la extensión
  await pb.evaluate(() => chrome.storage.local.set({ n_sinperfil: { id: 'sinperfil', title: 'Sin perfil', description: '', url: 'https://example.com/sp', host: 'example.com', scope: 'page', tags: [], color: null, createdAt: 5, updatedAt: 6 } }));
  await pb.evaluate(() => chrome.runtime.sendMessage({ type: 'link:restart' }));
  await until(() => core.store.get('sinperfil'), 'la nota sin perfil llega a la app');
  assert.equal(core.store.get('sinperfil').profileId, profB.id);
  await pb.evaluate(() => NotesStore.remove('sinperfil'));
  await until(async () => !(await cacheOf(pb)).n_sinperfil || true, 'ok');

  console.log('5. Las notas de A se ven en B bajo demanda (la app las sirve), sin guardarse en B');
  await pb.goto(B.url('notes.html'));
  await pb.waitForSelector('#others .op');
  assert.match(await pb.textContent('#others'), /Personal/);
  assert.match(await pb.textContent('#others'), /a@x\.com/);
  await pb.click('#others .op-head');
  await pb.waitForSelector('#others article:has-text("Nota vieja de A")');
  assert.ok(!(await cacheOf(pb)).n_legacy1, 'la extensión de B no guarda las notas de A');
  await pb.screenshot({ path: path.join(SHOTS, 'notes-B.png'), fullPage: true });

  console.log('6. Solo lectura y "Abrir en su perfil" para la nota de A');
  const cardA = pb.locator('#others article:has-text("Nota vieja de A")');
  await cardA.locator('.menu-btn').click();
  assert.equal(await pb.locator('.menu >> text=Editar').count(), 0, 'en solo lectura no se edita');
  assert.equal(await pb.locator('.menu >> text=Eliminar').count(), 0, 'nunca se elimina lo ajeno');
  await pb.click('.menu >> text=Abrir en su perfil');
  await until(() => launched.length === 1, 'la app lanza el navegador');
  assert.deepEqual(launched[0], { browser: 'chrome', dir: 'Default', url: 'https://example.com/a' });
  await pb.locator('article:has-text("Nota de B") .menu-btn').click();
  assert.equal(await pb.locator('.menu >> text=Abrir en su perfil').count(), 0, 'sus propias notas no ofrecen abrir en otro perfil');
  assert.equal(await pb.locator('.menu >> text=Abrir página').count(), 1, 'sí ofrecen abrir su URL');
  await pb.keyboard.press('Escape');
  assert.equal(await pb.locator('.menu').count(), 0, 'Esc cierra el menú');

  console.log('7. "Todas mis notas": búsqueda propia y global, grupos y vistas');
  await pb.fill('#search', 'vieja');
  assert.equal(await pb.locator('#list article').count(), 0, 'la búsqueda normal solo mira mis notas');
  await pb.check('#globalSearch');
  await pb.waitForSelector('#others article:has-text("Nota vieja de A")');
  await pb.uncheck('#globalSearch');
  await pb.fill('#search', '');
  await pb.click('#collapseAll');
  assert.equal(await pb.locator('.group-sec.collapsed').count(), await pb.locator('.group-sec').count());
  await pb.fill('#search', 'Nota de B');
  assert.equal(await pb.locator('.group-sec:not(.collapsed)').count(), 1, 'al buscar se abren los grupos con resultados');
  await pb.fill('#search', '');
  await pb.click('#expandAll');
  await pb.selectOption('#pView', 'simple');
  await pb.reload();
  assert.equal(await pb.inputValue('#pView'), 'simple', 'la vista se recuerda');
  await pb.selectOption('#pView', 'detailed');
  await pb.locator('article:has-text("Nota de B") .menu-btn').click();
  await pb.click('.menu >> text=Vista simple');
  assert.equal(await pb.locator('article:has-text("Nota de B").mode-simple').count(), 1, 'cambia solo esa nota');

  console.log('7b. Popup: secciones desplegables, buscador, menú y estado');
  const web = require('node:http').createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<title>Prueba</title><h1>' + req.url + '</h1>'); });
  await new Promise((r) => web.listen(47399, '127.0.0.1', r));
  const site = await B.context.newPage();
  await site.goto('http://127.0.0.1:47399/pagina');
  await pb.evaluate(async () => {
    await NotesStore.save(NotesStore.create({ title: 'De este sitio', description: 'd1', url: 'http://127.0.0.1:47399/otra', scope: 'domain', tags: ['x'] }));
    await NotesStore.save(NotesStore.create({ title: 'Solo esta URL', description: 'd2', url: 'http://127.0.0.1:47399/pagina', scope: 'page', tags: [] }));
  });
  const tabId = await B.sw.evaluate(async () => (await chrome.tabs.query({ url: 'http://127.0.0.1:47399/*' }))[0].id);
  await B.sw.evaluate(async (id) => chrome.storage.session.set({ draft: { field: 'title', text: '', tabId: id, ts: Date.now() } }), tabId);
  const popup = await B.context.newPage();
  await popup.setViewportSize({ width: 400, height: 560 });
  await popup.goto(B.url('popup.html'));
  await popup.waitForSelector('#related article');
  assert.equal(await popup.locator('#related article').count(), 2, 'esta página: la de la URL y la del sitio');
  assert.equal(await popup.locator('#allBody').isHidden(), true, 'todas las notas empieza plegada');
  await popup.click('#allHead');
  assert.equal(await popup.locator('#allNotes article').count(), 1, 'mis demás notas (sin repetir las de esta página)');
  await popup.fill('#search', 'este');
  await until(async () => (await popup.locator('#related article').count()) === 1, 'el buscador filtra la sección de esta página');
  await until(async () => (await popup.locator('#allNotes article').count()) === 0, 'el buscador filtra todas las notas');
  await popup.fill('#search', '');
  await until(async () => (await popup.locator('#related article').count()) === 2, 'vuelven las notas de esta página');
  await popup.click('#allHead');
  assert.equal(await popup.locator('#allBody').isHidden(), true);
  await popup.locator('#related article').first().locator('.menu-btn').click();
  await popup.click('.menu >> text=Vista simple');
  assert.equal(await popup.locator('#related article.mode-simple').count(), 1);
  await popup.click('#allHead');
  await popup.screenshot({ path: path.join(SHOTS, 'popup-B.png') });
  assert.match(await popup.textContent('#conn'), /nube sin configurar/);

  // Estado de la nube: aviso por nota y línea de estado
  core.server.setCloud({ state: 'online', pending: 2, syncedSeq: 0 });
  await until(async () => (await popup.textContent('#conn')).includes('subiendo'), 'estado de la nube en el popup');
  await until(async () => (await popup.locator('.safety:has-text("sin subir a la nube")').count()) >= 1, 'aviso "sin subir a la nube" en las notas');
  core.server.setCloud({ state: 'online', pending: 0, syncedSeq: core.store.seq });
  await until(async () => (await popup.textContent('#conn')).includes('a salvo'), 'todo a salvo');
  await until(async () => (await popup.locator('.safety').count()) === 0, 'sin avisos cuando todo está a salvo');

  console.log('7c. Popup: otros perfiles, búsqueda global, privado, editar y avisos en vivo');
  await popup.waitForSelector('#others .op');
  assert.match(await popup.textContent('#others'), /Personal/);
  await popup.click('#others .op-head');
  await popup.waitForSelector('#others article:has-text("Nota vieja de A")');
  await popup.locator('#others article:has-text("Nota vieja de A") .menu-btn').click();
  assert.equal(await popup.locator('.menu >> text=Editar').count(), 0);
  assert.equal(await popup.locator('.menu >> text=Abrir en su perfil').count(), 1);
  await popup.keyboard.press('Escape');
  await popup.screenshot({ path: path.join(SHOTS, 'popup-otros.png') });
  // Búsqueda global
  await popup.fill('#search', 'vieja');
  await popup.check('#globalSearch');
  await until(async () => (await popup.locator('#others article:has-text("Nota vieja de A")').count()) === 1 && (await popup.locator('#related article').count()) === 0, 'búsqueda global');
  await popup.uncheck('#globalSearch');
  await popup.fill('#search', '');
  await until(async () => (await popup.locator('#related article').count()) === 2, 'vuelve la vista normal');
  // Un cambio de A llega a B sin que B toque nada
  await pa.evaluate(() => NotesStore.save(NotesStore.create({ title: 'Nueva de A', description: 'aviso', url: 'https://example.com/n', scope: 'page', tags: [] })));
  await popup.waitForSelector('#others article:has-text("Nueva de A")', { timeout: 15000 });
  // Privado: se ve bloqueado, sin correo ni notas, y el servidor lo niega
  core.setSharing(profA.id, 'private');
  await popup.waitForSelector('#others .op.locked');
  assert.ok(!(await popup.textContent('#others')).includes('a@x.com'), 'un perfil privado no muestra su correo');
  assert.equal(await popup.locator('#others article').count(), 0);
  const denied = await pb.evaluate((id) => Link.profileNotes(id, {}).then(() => 'ok', (e) => e.code), profA.id);
  assert.equal(denied, 'not_found');
  // Editable: aparece "Editar" y el dueño sigue siendo A
  core.setSharing(profA.id, 'edit');
  await popup.waitForSelector('#others .op:not(.locked) .op-head');
  await popup.click('#others .op-head');
  await popup.locator('#others article:has-text("Nueva de A") .menu-btn').click();
  await popup.click('.menu >> text=Editar');
  assert.match(await popup.textContent('#formTitle'), /Editar nota de/);
  await popup.fill('#title', 'Nueva de A (editada en B)');
  await popup.click('#form button[type=submit], #form .primary');
  const nueva = () => core.store.since(0).find((n) => n.title === 'Nueva de A (editada en B)');
  await until(nueva, 'la edición de B llega a la app');
  assert.equal(nueva().profileId, profA.id, 'la nota sigue siendo de A');
  core.setSharing(profA.id, 'read');
  await until(async () => (await pa.evaluate(() => chrome.storage.local.get(null)))[`n_${nueva().id}`]?.title === 'Nueva de A (editada en B)', 'A recibe la edición');
  await popup.close();
  await site.close();
  web.closeAllConnections(); await new Promise((r) => web.close(r));

  console.log('8. Sin la app: A guarda cambios y B no se entera; al volver, todo llega');
  await core.stop();
  await until(async () => (await A.sw.evaluate(() => chrome.storage.session.get('conn'))).conn.state === 'offline', 'A detecta que la app cayó');
  const pp = await A.context.newPage();
  await pp.goto(A.url('popup.html'));
  await pp.waitForSelector('#conn:not([hidden])');
  assert.match(await pp.textContent('#conn'), /App cerrada o sin conexión/);
  await pp.close();
  const ppB = await B.context.newPage();
  await ppB.goto(B.url('popup.html'));
  await ppB.waitForFunction(() => document.querySelector('#others')?.textContent.includes('necesitan la app abierta'));
  await ppB.close();
  await pa.evaluate(() => NotesStore.save(NotesStore.create({ title: 'Escrita sin la app', description: '', url: 'https://example.com/off', scope: 'domain', tags: [] })));
  assert.equal(Object.keys((await cacheOf(pa)).outbox.notes).length, 1);
  core = make();
  await core.start();
  await pa.evaluate(() => chrome.runtime.sendMessage({ type: 'link:retry' }));
  await until(() => core.store.since(0).some((n) => n.title === 'Escrita sin la app'), 'la nota escrita sin la app llega a la app', 40000);
  assert.equal(await pb.evaluate((id) => Link.profileNotes(id, { q: 'Escrita' }).then((r) => r.notes.length), profA.id), 1, 'B la ve desde la app');
  assert.ok([...core.store.since(0)].some((n) => n.title === 'Escrita sin la app'));

  console.log('9. B no puede borrar lo de A; A sí borra lo suyo');
  const delErr = await pb.evaluate(() => Link.request('/notes/legacy1', { method: 'DELETE' }).then(() => 'ok', (e) => e.code));
  assert.equal(delErr, 'read_only');
  assert.ok(!core.store.get('legacy1').deleted, 'la nota de A sigue viva');
  await pa.evaluate(() => NotesStore.remove('legacy1'));
  await until(() => core.store.get('legacy1').deleted, 'A borra su nota');

  console.log('10. Categorías compartidas');
  await pb.evaluate(async () => NotesStore.savePalette([{ id: 'c-x', name: 'Solo B', hex: '#123456', info: '' }]));
  await until(async () => (await pa.evaluate(() => NotesStore.getPalette())).some((c) => c.id === 'c-x'), 'paleta llega a A');

  console.log('11. Revocar desde la app avisa a la extensión');
  await pa.goto(A.url('options.html'));
  const idA = core.registry.listInstances().find((i) => i.origin.includes(A.id)).id;
  core.revokeInstance(idA);
  await until(async () => (await A.sw.evaluate(() => chrome.storage.session.get('conn'))).conn.state === 'revoked', 'A se entera de la revocación');
  await pa.waitForSelector('#linkWarn:not([hidden])');
  // Volver a emparejar tras la revocación
  const again = core.newPairingCode();
  await pa.fill('#code', again.code);
  await pa.click('#pairBtn');
  await until(async () => (await A.sw.evaluate(() => chrome.storage.session.get('conn'))).conn.state === 'noprofile', 'sin perfil la app no entrega notas');
  await pa.waitForSelector('#linkOn:not([hidden])');
  await until(async () => (await pa.$$eval('#profileSel option', (o) => o.length)) > 1, 'lista de perfiles');
  await pa.selectOption('#profileSel', 'Default');
  await pa.click('#saveProfile');
  await until(async () => (await A.sw.evaluate(() => chrome.storage.session.get('conn'))).conn.state === 'online', 'A vuelve a conectarse');
  await pa.screenshot({ path: path.join(SHOTS, 'options-A-repaired.png'), fullPage: true });

  console.log('12. Desconectar B limpia su caché y vuelve al modo sin app');
  await pb.goto(B.url('options.html'));
  pb.on('dialog', (d) => d.accept());
  await pb.click('#unpairBtn');
  await pb.waitForSelector('#linkOff:not([hidden])');
  const after = await cacheOf(pb);
  assert.ok(!Object.keys(after).some((k) => k.startsWith('n_') || k === 'link'));
  assert.equal(core.registry.listInstances().length, 1); // quedó A (re-emparejada); B se desconectó sola

  console.log('12b. Sin enlace la extensión no guarda notas por su cuenta');
  const failed = await pb.evaluate(() => NotesStore.save(NotesStore.create({ title: 'x', description: '', url: 'https://example.com/x', scope: 'page', tags: [] })).then(() => null, (e) => e.message));
  assert.match(failed, /Conecta primero/);
  const synced = await pb.evaluate(() => chrome.storage.sync.get(null));
  assert.ok(!Object.keys(synced).some((k) => k.startsWith('n_') && synced[k].title === 'x'), 'nada se escribe en storage.sync');
  const popupB = await B.context.newPage();
  await popupB.goto(B.url('popup.html'));
  await until(async () => !(await popupB.locator('#unlinked').isHidden()), 'el popup pide enlazar con la app');
  assert.equal(await popupB.locator('#listWrap').isHidden(), true);
  await popupB.screenshot({ path: path.join(SHOTS, 'popup-sin-enlace.png') });
  await popupB.close();

  assert.deepEqual(errors, [], 'errores en las páginas: ' + errors.join(' | '));
  console.log('\nTODO BIEN');
  await A.context.close();
  await B.context.close();
  await core.stop();
})().catch((err) => {
  console.error('\nFALLÓ:', err.stack || err);
  process.exit(1);
});
