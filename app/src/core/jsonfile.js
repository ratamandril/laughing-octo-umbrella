'use strict';

// Persistencia JSON segura: escritura atómica (archivo temporal + rename), copia
// de seguridad de la versión anterior (.bak) y guardado diferido (debounce).

const fs = require('node:fs');
const path = require('node:path');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// En Windows un antivirus o el indexador pueden bloquear el archivo un instante
async function renameRetry(from, to, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      await fs.promises.rename(from, to);
      return;
    } catch (err) {
      if (i >= tries - 1 || !['EPERM', 'EBUSY', 'EACCES'].includes(err.code)) throw err;
      await sleep(25 * (i + 1));
    }
  }
}

async function writeJsonAtomic(file, data) {
  const tmp = file + '.tmp';
  const handle = await fs.promises.open(tmp, 'w');
  try {
    await handle.writeFile(JSON.stringify(data), 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (fs.existsSync(file)) await renameRetry(file, file + '.bak');
  await renameRetry(tmp, file);
}

// Devuelve { data, from } o null si no existe nada. Lanza CORRUPT si hay archivos pero ninguno es legible:
// así nunca se arranca "en blanco" encima de datos que existen.
function readJsonWithBackup(file) {
  const candidates = fs.existsSync(file) ? [file, file + '.bak'] : [file + '.tmp', file + '.bak'];
  let existed = false;
  let lastError = null;
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    existed = true;
    try {
      return { data: JSON.parse(fs.readFileSync(candidate, 'utf8')), from: candidate };
    } catch (err) {
      lastError = err;
    }
  }
  if (existed) {
    const error = new Error(`No se pudo leer ${path.basename(file)} ni sus copias: ${lastError.message}`);
    error.code = 'CORRUPT';
    throw error;
  }
  return null;
}

class JsonFile {
  constructor(file, snapshotFn, { delayMs = 150, retryMs = 2000, onError } = {}) {
    this.file = file;
    this.snapshotFn = snapshotFn;
    this.delayMs = delayMs;
    this.retryMs = retryMs;
    this.onError = onError;
    this.dirty = false;
    this.timer = null;
    this.chain = Promise.resolve();
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  read() {
    const result = readJsonWithBackup(this.file);
    return result ? result.data : null;
  }

  markDirty() {
    this.dirty = true;
    this._schedule(this.delayMs);
  }

  _schedule(ms) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch((err) => {
        if (this.onError) this.onError(err);
        this._schedule(this.retryMs); // reintenta más tarde (p. ej. disco lleno)
      });
    }, ms);
    if (this.timer.unref) this.timer.unref();
  }

  // Escribe ahora, si hay cambios pendientes. Las escrituras se encadenan para no solaparse.
  flush() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const run = this.chain.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      try {
        await writeJsonAtomic(this.file, this.snapshotFn());
      } catch (err) {
        this.dirty = true;
        throw err;
      }
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

module.exports = { JsonFile, readJsonWithBackup, writeJsonAtomic };
