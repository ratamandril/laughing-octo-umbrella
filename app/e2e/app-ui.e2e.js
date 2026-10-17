'use strict';

// Prueba de la interfaz de la app (renderer) contra un núcleo real, sin Electron: la ventana se carga en Chromium y
// `window.notasApp` se conecta con el núcleo igual que lo hace main.js.
// Uso:  node e2e/app-ui.e2e.js   (SHOTS=<carpeta> para guardar capturas)
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { startCore, request, ORIGIN_A, ORIGIN_B } = require('../test/helpers');

const { chromium } = require(process.env.PLAYWRIGHT_PATH || '/opt/npm-tools/node_modules/playwright');
const CHROMIUM = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const SHOTS = process.env.SHOTS || os.tmpdir();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(fn, label, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* reintenta */ }
    await sleep(100);
  }
  throw new Error('Tiempo agotado: ' + label);
}

(async () => {
  const ctx = await startCore();
  const { core } = ctx;
  const browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 980, height: 1100 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());

  // Puente igual al de main.js
  const api = {
    getState: () => core.state(),
    newPairingCode: (o) => core.newPairingCode(o || {}),
    cancelPairing: () => core.auth.cancelPairing(),
    revokeInstance: (id) => core.revokeInstance(id),
    listNotes: () => core.notesView(),
    openNote: (id) => core.openNote(id),
    copyNoteUrl: () => true,
    deleteNote: (id) => core.deleteNote(id),
    assignNoteProfile: (id, p) => core.assignNoteProfile(id, p),
    listTrash: () => core.trash(),
    restoreNote: (id) => core.restoreNote(id),
    purgeNote: (id) => core.purgeNote(id),
    emptyTrash: () => core.emptyTrash(),
    updateProfile: (id, patch) => core.updateProfile(id, patch),
    bindProfile: (id, b, d) => core.setBinding(id, b, d),
    assignInstance: (i, p) => core.assignInstance(i, p),
    mergeProfiles: (f, t) => core.mergeProfiles(f, t),
    setSharing: (id, m) => core.setSharing(id, m),
    chooseSyncKey: () => ({ canceled: true }),
    syncNow: () => ({}),
    disableSync: () => ({}),
    openDataFolder: () => true,
  };
  await page.exposeFunction('__call', async (name, args) => JSON.parse(JSON.stringify((await api[name](...args)) ?? null)));
  await page.addInitScript((names) => {
    window.notasApp = Object.fromEntries(names.map((n) => [n, (...args) => window.__call(n, args)]));
    window.notasApp.onState = () => () => {};
  }, Object.keys(api));
  await page.goto('file://' + path.resolve(__dirname, '..', 'src', 'renderer', 'index.html'));

  async function pairWith(origin) {
    const { code } = core.auth.pairingState();
    const res = await request(ctx.port, { method: 'POST', path: '/pair', origin, body: { code, browser: 'chrome' } });
    assert.equal(res.status, 201);
    return res.json;
  }
  const refresh = async () => { await page.evaluate(() => refresh()); };

  console.log('1. Sin cuentas: se crea una al generar el código');
  await page.waitForSelector('#pairAccount');
  assert.equal(await page.inputValue('#pairAccount'), '__new');
  assert.equal(await page.isVisible('#newName'), true);
  await page.click('#newCode');
  assert.equal(core.auth.pairingState(), null, 'sin nombre no se genera código');
  await page.fill('#newName', 'Personal');
  await page.fill('#newEmail', 'correox@gmail.com');
  await page.click('#newCode');
  await until(async () => (await page.textContent('#codeFor')).includes('Personal'), 'el código dice para qué cuenta es');
  await pairWith(ORIGIN_A);
  await refresh();
  await until(async () => (await page.textContent('#profiles')).includes('correox@gmail.com'), 'la cuenta aparece en la lista');
  assert.match(await page.textContent('#instances'), /Chrome · Personal/);
  assert.match(await page.textContent('#profiles'), /0 notas · 1 extensión/);
  const personal = core.registry.listProfiles()[0];
  assert.deepEqual([personal.name, personal.email], ['Personal', 'correox@gmail.com']);

  console.log('2. Enlace local: se elige con qué perfil de navegador se abren sus links');
  const row = page.locator('#profiles .access', { hasText: 'Se abre con' }).first();
  await row.locator('select').first().selectOption('chrome|Default');
  await until(() => core.registry.bindingOf(personal.id), 'enlace guardado');
  assert.deepEqual(core.registry.bindingOf(personal.id), { browser: 'chrome', dir: 'Default' });
  await row.locator('select').first().selectOption('');
  await until(() => !core.registry.bindingOf(personal.id), 'enlace quitado');
  await row.locator('select').first().selectOption('chrome|Default');

  console.log('3. Cuenta existente para una segunda extensión y cambio de cuenta');
  await page.selectOption('#pairAccount', '__new');
  await page.fill('#newName', 'Trabajo');
  await page.click('#newCode');
  await until(async () => (await page.textContent('#codeFor')).includes('Trabajo'), 'código para Trabajo');
  await pairWith(ORIGIN_B);
  await refresh();
  await until(() => core.registry.listProfiles().length === 2, 'segunda cuenta');
  const trabajo = core.registry.listProfiles().find((p) => p.name === 'Trabajo');
  await page.click('#cancelCode').catch(() => {});
  await page.screenshot({ path: path.join(SHOTS, 'app-cuentas.png'), fullPage: true });
  const instB = core.registry.listInstances().find((i) => i.profileId === trabajo.id);
  await page.locator('#instances .access select').nth(1).selectOption(personal.id);
  await until(() => core.registry.getInstance(instB.id).profileId === personal.id, 'la extensión pasa de cuenta');

  console.log('4. Unir cuentas desde la app');
  core.store.put({ id: 'nt', url: 'https://example.com/t', title: 'de trabajo', profileId: trabajo.id });
  await refresh();
  const joinRow = page.locator('#profiles .access', { has: page.locator('option', { hasText: 'Unir con otra cuenta' }) });
  const rowOf = (name) => page.locator('#profiles .row', { hasText: name });
  assert.ok(await rowOf('Trabajo').count());
  assert.equal(trabajo.email, '', 'los campos de cuenta nueva se vacían tras generar el código');
  await joinRow.nth(1).locator('select').selectOption(personal.id); // Trabajo → Personal
  await until(() => core.store.get('nt').profileId === personal.id, 'las notas pasan a la cuenta resultante');
  await until(async () => !(await page.locator('#profiles .row .strong').allTextContents()).includes('Trabajo'), 'la cuenta unida desaparece de la lista');
  assert.equal(core.registry.listProfiles().length, 1);

  assert.deepEqual(errors, [], 'errores en la ventana: ' + errors.join(' | '));
  console.log('\nTODO BIEN');
  await browser.close();
  await ctx.close();
})().catch((e) => { console.error('\nFALLÓ:', e.stack || e); process.exit(1); });
