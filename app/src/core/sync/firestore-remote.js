'use strict';

// Acceso a Firestore con el SDK de administración y una cuenta de servicio.
// Estructura:  notes/{id}   profiles/{id}   meta/palette
// Las reglas de seguridad del proyecto deben negar todo a los clientes: el SDK de administración las ignora.

const BATCH = 400; // Firestore admite 500 operaciones por lote

function validateServiceAccount(json) {
  if (!json || typeof json !== 'object') return 'El archivo no es un JSON de objeto.';
  if (json.type !== 'service_account') return 'No parece una clave de cuenta de servicio (falta "type": "service_account").';
  for (const field of ['project_id', 'private_key', 'client_email']) {
    if (typeof json[field] !== 'string' || !json[field]) return `Falta el campo "${field}".`;
  }
  if (!json.private_key.includes('BEGIN PRIVATE KEY')) return 'La clave privada no tiene el formato esperado.';
  return null;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: sin respuesta en ${Math.round(ms / 1000)} s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function createFirestoreRemote({ serviceAccount, timeoutMs = 30000, adminModules } = {}) {
  const problem = validateServiceAccount(serviceAccount);
  if (problem) throw new Error(problem);

  let app = null;
  let db = null;
  const unsubscribers = [];

  const col = (name) => db.collection(name);
  const strip = (note) => {
    const { seq, ...rest } = note; // eslint-disable-line no-unused-vars
    return rest; // seq es local de cada equipo
  };

  return {
    projectId: serviceAccount.project_id,

    async connect() {
      if (db) return;
      const { initializeApp, cert } = adminModules ? adminModules.app : require('firebase-admin/app');
      const { getFirestore } = adminModules ? adminModules.firestore : require('firebase-admin/firestore');
      app = initializeApp({ credential: cert(serviceAccount) }, 'notas-' + Date.now());
      db = getFirestore(app);
      db.settings({ ignoreUndefinedProperties: true });
      // Comprobación real: falla si el proyecto no tiene Firestore activado o la clave no sirve
      await withTimeout(col('meta').doc('palette').get(), timeoutMs, 'connect');
    },

    async fetchAll() {
      const [notes, profiles, palette] = await withTimeout(
        Promise.all([col('notes').get(), col('profiles').get(), col('meta').doc('palette').get()]),
        timeoutMs * 4,
        'fetchAll',
      );
      return {
        notes: notes.docs.map((d) => d.data()),
        profiles: profiles.docs.map((d) => d.data()),
        palette: palette.exists ? palette.data() : null,
      };
    },

    async push({ notes = [], profiles = [], palette = null }) {
      const ops = [
        ...notes.map((n) => ({ ref: col('notes').doc(n.id), data: strip(n) })),
        ...profiles.map((p) => ({ ref: col('profiles').doc(p.id), data: p })),
      ];
      if (palette) ops.push({ ref: col('meta').doc('palette'), data: { list: palette.list, updatedAt: palette.updatedAt } });
      for (let i = 0; i < ops.length; i += BATCH) {
        const batch = db.batch();
        for (const op of ops.slice(i, i + BATCH)) batch.set(op.ref, op.data);
        await withTimeout(batch.commit(), timeoutMs, 'push');
      }
    },

    // onBatch({notes, profiles, palette}) en cada cambio; onError(err) si se corta la escucha
    listen(onBatch, onError) {
      const stop = [
        col('notes').onSnapshot(
          (snap) => {
            const notes = snap.docChanges().filter((c) => c.type !== 'removed').map((c) => c.doc.data());
            if (notes.length) onBatch({ notes });
          },
          onError,
        ),
        col('profiles').onSnapshot(
          (snap) => {
            const profiles = snap.docChanges().filter((c) => c.type !== 'removed').map((c) => c.doc.data());
            if (profiles.length) onBatch({ profiles });
          },
          onError,
        ),
        col('meta').doc('palette').onSnapshot(
          (snap) => {
            if (snap.exists) onBatch({ palette: snap.data() });
          },
          onError,
        ),
      ];
      unsubscribers.push(...stop);
      return () => {
        for (const fn of stop) {
          try {
            fn();
          } catch {
            /* ya cerrado */
          }
        }
      };
    },

    async close() {
      for (const fn of unsubscribers.splice(0)) {
        try {
          fn();
        } catch {
          /* ya cerrado */
        }
      }
      if (app && app.delete) await app.delete().catch(() => {});
      app = null;
      db = null;
    },
  };
}

module.exports = { createFirestoreRemote, validateServiceAccount };
