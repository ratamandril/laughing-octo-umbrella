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
  return { name, context, sw, id, url: (file) => `chrome-extension://${id}/${file}` };
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
  console.log('4. La nota de A aparece en B sin hacer nada (WebSocket)');
  await until(async () => (await cacheOf(pb)).n_legacy1, 'nota de A en B');

  console.log('5. Crear una nota en B y verla en A');
  await pb.evaluate(() => NotesStore.save(NotesStore.create({ title: 'Nota de B', description: 'hecha en Trabajo', url: 'https://example.com/b', scope: 'page', tags: ['trabajo'] })));
  const inA = await until(async () => Object.values(await cacheOf(pa)).find((v) => v && v.title === 'Nota de B'), 'nota de B en A');
  assert.equal(inA.profileId, core.registry.listProfiles().find((p) => p.dir === 'Profile 1').id);
  await until(async () => !(await cacheOf(pb)).outbox || Object.keys((await cacheOf(pb)).outbox.notes).length === 0, 'cola de B vacía');

  console.log('6. "Abrir en su perfil" desde B para la nota de A');
  await pb.goto(B.url('notes.html'));
  await pb.waitForSelector('text=Nota vieja de A');
  await pb.screenshot({ path: path.join(SHOTS, 'notes-B.png'), fullPage: true });
  await pb.click('article:has-text("Nota vieja de A") >> text=Abrir en su perfil');
  await until(() => launched.length === 1, 'la app lanza el navegador');
  assert.deepEqual(launched[0], { browser: 'chrome', dir: 'Default', url: 'https://example.com/a' });
  assert.equal(await pb.locator('article:has-text("Nota de B") >> text=Abrir en su perfil').count(), 0, 'sus propias notas no ofrecen abrir');

  console.log('7. Filtro por perfil');
  await pb.selectOption('#fProfile', { label: 'Chrome · Personal' });
  assert.equal(await pb.locator('article').count(), 1);
  await pb.selectOption('#fProfile', '');

  console.log('8. Sin la app: A guarda cambios y B no se entera; al volver, todo llega');
  await core.stop();
  await until(async () => (await A.sw.evaluate(() => chrome.storage.session.get('conn'))).conn.state === 'offline', 'A detecta que la app cayó');
  const pp = await A.context.newPage();
  await pp.goto(A.url('popup.html'));
  await pp.waitForSelector('#conn:not([hidden])');
  assert.match(await pp.textContent('#conn'), /Sin conexión con la app/);
  await pp.close();
  await pa.evaluate(() => NotesStore.save(NotesStore.create({ title: 'Escrita sin la app', description: '', url: 'https://example.com/off', scope: 'domain', tags: [] })));
  assert.equal(Object.keys((await cacheOf(pa)).outbox.notes).length, 1);
  core = make();
  await core.start();
  await pa.evaluate(() => chrome.runtime.sendMessage({ type: 'link:retry' }));
  await until(async () => Object.values(await cacheOf(pb)).find((v) => v && v.title === 'Escrita sin la app'), 'la nota escrita sin la app llega a B', 40000);
  assert.ok([...core.store.since(0)].some((n) => n.title === 'Escrita sin la app'));

  console.log('9. Borrar en B se propaga a A');
  await pb.evaluate(() => NotesStore.remove('legacy1'));
  await until(async () => !(await cacheOf(pa)).n_legacy1, 'borrado llega a A');

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

  assert.deepEqual(errors, [], 'errores en las páginas: ' + errors.join(' | '));
  console.log('\nTODO BIEN');
  await A.context.close();
  await B.context.close();
  await core.stop();
})().catch((err) => {
  console.error('\nFALLÓ:', err.stack || err);
  process.exit(1);
});
