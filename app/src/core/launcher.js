'use strict';

// Abre una URL en un navegador y un perfil concretos:
//   chrome.exe --profile-directory="Profile 2" https://...
// Sin shell: los argumentos van como lista, nunca concatenados en un comando.

const childProcess = require('node:child_process');
const { BROWSERS, DIR_RE } = require('./profiles');
const { isHttpUrl, LIMITS } = require('./sanitize');

function coded(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function createLauncher({ profiles, spawn = childProcess.spawn }) {
  return {
    // Lanza invalid_browser | invalid_profile | invalid_url | browser_not_found | spawn_failed
    async open({ browser, dir, url }) {
      if (!BROWSERS.includes(browser)) throw coded('invalid_browser');
      if (typeof dir !== 'string' || !DIR_RE.test(dir)) throw coded('invalid_profile');
      if (typeof url !== 'string' || url.length > LIMITS.url || !isHttpUrl(url)) throw coded('invalid_url');

      const exe = profiles.findExecutable(browser);
      if (!exe) throw coded('browser_not_found');

      const args = [`--profile-directory=${dir}`, new URL(url).href];
      await new Promise((resolve, reject) => {
        const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
        child.once('error', (err) => reject(coded('spawn_failed', err.message)));
        child.once('spawn', () => {
          child.unref();
          resolve();
        });
      });
      return { exe, args };
    },
  };
}

module.exports = { createLauncher };
