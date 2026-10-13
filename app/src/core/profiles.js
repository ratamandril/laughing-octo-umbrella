'use strict';

// Detección de perfiles de Chrome y Edge (Windows) y localización de sus ejecutables.
//
// Ambos son Chromium: cada uno guarda en "<User Data>\Local State" un mapa
// profile.info_cache con la carpeta de cada perfil ("Default", "Profile 1"...),
// su nombre y el correo con el que inició sesión.

const fs = require('node:fs');
const path = require('node:path');

const BROWSERS = ['chrome', 'edge'];
const DIR_RE = /^(?![ .])(?!.*[ .]$)[\w .()-]{1,64}$/; // "Default", "Profile 1", "Guest Profile"...

function defaultUserDataDirs(env, platform) {
  if (platform !== 'win32' || !env.LOCALAPPDATA) return {};
  return {
    chrome: path.win32.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data'),
    edge: path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'Edge', 'User Data'),
  };
}

function executableCandidates(browser, env) {
  const w = path.win32;
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const rel =
    browser === 'chrome'
      ? ['Google', 'Chrome', 'Application', 'chrome.exe']
      : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  return roots.map((root) => w.join(root, ...rel));
}

// Convierte el texto de "Local State" en [{ dir, name, email, gaiaName }]
function parseLocalState(text) {
  let state;
  try {
    state = JSON.parse(text);
  } catch {
    return [];
  }
  const cache = state && state.profile && state.profile.info_cache;
  if (!cache || typeof cache !== 'object') return [];

  const out = [];
  for (const [dir, info] of Object.entries(cache)) {
    if (!DIR_RE.test(dir)) continue;
    out.push({
      dir,
      name: String((info && info.name) || dir).slice(0, 60),
      email: String((info && info.user_name) || '').slice(0, 120),
      gaiaName: String((info && info.gaia_name) || '').slice(0, 60),
    });
  }
  return out.sort((a, b) => (a.dir === 'Default' ? -1 : b.dir === 'Default' ? 1 : a.dir.localeCompare(b.dir, 'en', { numeric: true })));
}

function createProfilesProvider({
  env = process.env,
  platform = process.platform,
  userDataDirs,
  browserPaths = {}, // rutas manuales de ejecutables, por si no están en los sitios habituales
  exists = fs.existsSync,
  readFile = (file) => fs.readFileSync(file, 'utf8'),
  cacheMs = 3000,
} = {}) {
  const dirs = userDataDirs || defaultUserDataDirs(env, platform);
  let cache = null;

  return {
    // [{ browser, dir, name, email, gaiaName }]
    async detect() {
      if (cache && Date.now() - cache.at < cacheMs) return cache.list;
      const list = [];
      for (const browser of BROWSERS) {
        if (!dirs[browser]) continue;
        const file = path.join(dirs[browser], 'Local State');
        try {
          for (const p of parseLocalState(readFile(file))) list.push({ browser, ...p });
        } catch {
          /* navegador no instalado o sin perfiles */
        }
      }
      cache = { at: Date.now(), list };
      return list;
    },

    findExecutable(browser) {
      if (browserPaths[browser] && exists(browserPaths[browser])) return browserPaths[browser];
      return executableCandidates(browser, env).find((candidate) => exists(candidate)) || null;
    },

    invalidate() {
      cache = null;
    },
  };
}

module.exports = { BROWSERS, DIR_RE, parseLocalState, createProfilesProvider, executableCandidates };
