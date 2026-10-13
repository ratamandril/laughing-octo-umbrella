#!/usr/bin/env node
'use strict';

// Arranca el servidor sin Electron (útil para desarrollo y para probar la extensión).
//   node src/core/cli.js [--data-dir carpeta] [--port 47321]

const path = require('node:path');
const os = require('node:os');
const { createCore, DEFAULT_PORT } = require('./index');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function defaultDataDir() {
  const base = process.env.APPDATA || path.join(os.homedir(), '.config');
  return path.join(base, 'notas-por-url-app');
}

(async () => {
  const dataDir = path.resolve(arg('data-dir', defaultDataDir()));
  const port = Number(arg('port', DEFAULT_PORT));
  const core = createCore({ dataDir, port });
  core.events.on('error-storage', (err) => console.error('[almacenamiento]', err.message));
  core.events.on('error-internal', (err) => console.error('[interno]', err));

  const keyPath = arg('firebase-key', process.env.NOTAS_FIREBASE_KEY);
  if (keyPath) {
    const result = await core.enableSync(require('node:fs').readFileSync(path.resolve(keyPath), 'utf8'));
    if (!result.ok) console.error('Clave de Firebase no válida:', result.error);
  }
  await core.start();
  const pairing = core.newPairingCode();
  console.log(`Notas por URL (servidor local) en http://127.0.0.1:${core.server.port}`);
  console.log(`Datos: ${dataDir}`);
  console.log(`Código de emparejamiento: ${pairing.code} (caduca en 5 minutos)`);

  const shutdown = async () => {
    await core.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})().catch((err) => {
  console.error(err.code === 'EADDRINUSE' ? 'El puerto ya está en uso: ¿hay otra copia en marcha?' : err);
  process.exit(1);
});
