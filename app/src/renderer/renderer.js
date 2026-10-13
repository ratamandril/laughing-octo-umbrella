'use strict';

// Interfaz de la app. Todo el texto se inserta con textContent: nunca se interpreta como HTML.
const $ = (selector) => document.querySelector(selector);

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const BROWSER_NAMES = { chrome: 'Chrome', edge: 'Edge', firefox: 'Firefox', other: 'Navegador' };
let current = null;
let tick = null;

function ago(timestamp) {
  if (!timestamp) return 'sin actividad desde que se abrió la app';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'hace unos segundos';
  if (seconds < 3600) return `hace ${Math.round(seconds / 60)} min`;
  return `hace ${Math.round(seconds / 3600)} h`;
}

function renderPairing(pairing) {
  const box = $('#codeBox');
  $('#cancelCode').hidden = !pairing;
  $('#newCode').textContent = pairing ? 'Generar otro código' : 'Generar código';
  box.hidden = !pairing;
  if (!pairing) return;
  $('#code').textContent = pairing.code;
  const left = Math.max(0, Math.round((pairing.expiresAt - Date.now()) / 1000));
  $('#countdown').textContent = `Caduca en ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

function renderInstances(instances) {
  const list = $('#instances');
  list.replaceChildren();
  $('#noInstances').hidden = instances.length > 0;
  for (const instance of instances) {
    const row = el('div', 'row');
    const dot = el('span', 'dot' + (instance.online ? ' on' : ''));
    dot.title = instance.online ? 'Conectada ahora' : 'Desconectada';

    const info = el('div', 'grow');
    const profile = instance.profile;
    const title = profile
      ? `${BROWSER_NAMES[profile.browser] || 'Navegador'} · ${profile.name}`
      : `${BROWSER_NAMES[instance.browser] || 'Navegador'} · sin perfil asignado`;
    info.append(el('div', 'strong', title));
    const detail = [profile && profile.email, instance.online ? 'conectada' : `última vez ${ago(instance.lastSeen)}`]
      .filter(Boolean)
      .join(' · ');
    info.append(el('div', 'muted', detail));

    const revoke = el('button', 'danger', 'Revocar');
    revoke.addEventListener('click', async () => {
      if (window.confirm(`¿Revocar el acceso de "${title}"? Tendrá que emparejarse de nuevo.`)) {
        await window.notasApp.revokeInstance(instance.id);
        refresh();
      }
    });
    row.append(dot, info, revoke);
    list.append(row);
  }
}

function renderProfiles(detected, registered) {
  const list = $('#profiles');
  list.replaceChildren();
  $('#noProfiles').hidden = detected.length > 0;
  for (const profile of detected) {
    const assigned = registered.some((r) => r.browser === profile.browser && r.dir === profile.dir);
    const row = el('div', 'row');
    const info = el('div', 'grow');
    info.append(el('div', 'strong', `${BROWSER_NAMES[profile.browser] || profile.browser} · ${profile.name}`));
    info.append(el('div', 'muted', [profile.dir, profile.email].filter(Boolean).join(' · ')));
    row.append(info, el('span', 'tag' + (assigned ? ' ok' : ''), assigned ? 'asignado' : 'libre'));
    list.append(row);
  }
}

function render(state) {
  current = state;
  const status = $('#status');
  status.textContent = state.running ? `En ejecución · 127.0.0.1:${state.port}` : 'Detenido';
  status.className = 'pill' + (state.running ? ' on' : '');
  renderPairing(state.pairing);
  renderInstances(state.instances);
  renderProfiles(state.detectedProfiles, state.registeredProfiles);
  const warnings = state.loadWarnings.length ? ` · ${state.loadWarnings.length} nota(s) descartadas al cargar` : '';
  $('#summary').textContent = `${state.notes} nota(s) · cambio nº ${state.seq}${warnings}`;
}

async function refresh() {
  render(await window.notasApp.getState());
}

$('#newCode').addEventListener('click', async () => {
  await window.notasApp.newPairingCode();
  refresh();
});
$('#cancelCode').addEventListener('click', async () => {
  await window.notasApp.cancelPairing();
  refresh();
});
$('#openData').addEventListener('click', () => window.notasApp.openDataFolder());

window.notasApp.onState(render);
refresh();

// Cuenta atrás del código y "hace X min" de las instancias
tick = setInterval(() => {
  if (!current) return;
  if (current.pairing && Date.now() > current.pairing.expiresAt) refresh();
  else if (current.pairing) renderPairing(current.pairing);
}, 1000);
window.addEventListener('beforeunload', () => clearInterval(tick));
