// Sincronización con la app local. Corre en el service worker.
//  - Arranque: valida el token, trae los cambios desde el último "seq", envía la cola de salida y abre el WebSocket.
//  - En vivo: la app empuja los cambios de las demás extensiones por WebSocket (sin polling).
//  - Ping cada 20 s: mantiene vivo el service worker y detecta cortes.
//  - Sin la app: se reintenta (2 s … 60 s y una alarma por minuto). Los cambios se acumulan en la cola.
const Sync = (() => {
  const local = chrome.storage.local;
  const { PREFIX, withLock } = NotesStore.internal;
  const RETRY_MS = [2000, 5000, 15000, 30000, 60000];
  const PING_MS = 20000;
  const BULK_MIN = 6; // desde este número de notas pendientes se envía en un solo lote

  let generation = 0; // cada reinicio invalida a los anteriores
  let running = false;
  let connected = false;
  let ws = null;
  let pingTimer = null;
  let retryTimer = null;
  let flushTimer = null;
  const RECONCILE_V = 1;
  let failures = 0;
  let lastPong = 0;
  let flushing = false;
  let flushAgain = false;

  async function setConn(state, extra = {}) {
    try {
      await chrome.storage.session.set({ conn: { state, t: Date.now(), ...extra } });
    } catch { /* storage.session no disponible */ }
  }

  async function setCloud(cloud) {
    if (!cloud || typeof cloud !== 'object') return;
    try {
      await chrome.storage.session.set({ cloud: { state: cloud.state, pending: cloud.pending || 0, syncedSeq: cloud.syncedSeq || 0 } });
    } catch { /* storage.session no disponible */ }
  }

  const clean = (note) => ({ ...note }); // la nota del servidor ya viene saneada

  // ---------- aplicar lo que llega de la app ----------
  async function applyNotes(notes, { full = false } = {}) {
    await withLock(async () => {
      const { outbox } = await local.get('outbox');
      const pending = (outbox && outbox.notes) || {};
      const toSet = {};
      const toRemove = [];
      for (const n of notes) {
        if (!n || typeof n.id !== 'string' || pending[n.id]) continue; // un cambio local pendiente manda
        if (n.deleted) toRemove.push(PREFIX + n.id);
        else toSet[PREFIX + n.id] = clean(n);
      }
      if (full) {
        // Sincronización completa: lo que la app no tiene (y no está pendiente) se borra de la caché
        const keep = new Set(notes.map((n) => n.id));
        const all = await local.get(null);
        for (const k of Object.keys(all)) {
          if (k.startsWith(PREFIX) && !keep.has(k.slice(PREFIX.length)) && !pending[k.slice(PREFIX.length)]) toRemove.push(k);
        }
      }
      if (Object.keys(toSet).length) await local.set(toSet);
      if (toRemove.length) await local.remove(toRemove);
    });
  }

  // La app dijo que estas notas no pueden estar en este perfil (son de otro): se quitan de la caché y de la cola.
  // Solo si no se han vuelto a tocar desde que se encolaron (ids → marca de la cola).
  async function rejectNotes(marks) {
    const ids = Object.keys(marks);
    if (!ids.length) return;
    await withLock(async () => {
      const { outbox } = await local.get('outbox');
      if (!outbox) return;
      const toRemove = [];
      for (const id of ids) {
        const entry = outbox.notes[id];
        if (entry && entry.t === marks[id]) {
          delete outbox.notes[id];
          toRemove.push(PREFIX + id);
        }
      }
      if (toRemove.length) await local.remove(toRemove);
      await local.set({ outbox });
    });
  }

  // Notas locales sin perfil (p. ej. importadas antes de elegirlo): pasan a este perfil y se envían
  async function adoptOrphans(profileId) {
    await withLock(async () => {
      const all = await local.get(null);
      const outbox = { notes: { ...((all.outbox && all.outbox.notes) || {}) }, palette: (all.outbox && all.outbox.palette) || null };
      const toSet = {};
      for (const [k, v] of Object.entries(all)) {
        if (!k.startsWith(PREFIX) || !v || v.profileId) continue;
        const id = k.slice(PREFIX.length);
        toSet[k] = { ...v, profileId };
        outbox.notes[id] = { op: 'put', t: Math.max(Date.now(), ((outbox.notes[id] && outbox.notes[id].t) || 0) + 1) };
      }
      if (Object.keys(toSet).length) await local.set({ ...toSet, outbox });
    });
  }

  async function applyPalette(palette) {
    if (!palette || !Array.isArray(palette.list)) return;
    await withLock(async () => {
      const { outbox } = await local.get('outbox');
      if (outbox && outbox.palette) return; // hay cambios de categorías sin enviar
      await local.set({ palette: palette.list });
    });
  }

  async function storeProfiles(list) {
    if (Array.isArray(list)) await local.set({ profiles: list });
  }

  async function bumpSeq(seq) {
    if (!Number.isInteger(seq)) return;
    const { syncSeq = 0 } = await local.get('syncSeq');
    if (seq > syncSeq) await local.set({ syncSeq: seq });
  }

  // ---------- arranque ----------
  async function start() {
    if (running || connected) return;
    running = true;
    const gen = ++generation;
    try {
      const link = await Link.get();
      if (!link) {
        await setConn('unpaired');
        running = false;
        return;
      }
      await setConn('connecting');

      const me = await Link.request('/me');
      if (gen !== generation) return;
      await Link.save({ ...link, profileId: me.profile ? me.profile.id : null });
      if (!me.profile) {
        // Sin perfil la app no entrega notas: se espera a que se elija en Ajustes
        running = false;
        await setConn('noprofile');
        return;
      }

      await adoptOrphans(me.profile.id);
      // Una vez por versión de limpieza se hace una sincronización completa: quita las copias que la app no reconoce
      const { syncSeq = 0, reconcileV = 0 } = await local.get(['syncSeq', 'reconcileV']);
      const full = syncSeq === 0 || reconcileV < RECONCILE_V;
      const changes = await Link.request('/notes?since=' + (full ? 0 : syncSeq));
      await applyNotes(changes.notes, { full });
      await local.set({ syncSeq: changes.seq, reconcileV: RECONCILE_V });

      const [pal, prof] = await Promise.all([Link.request('/palette'), Link.request('/profiles')]);
      if (pal.palette) {
        await applyPalette(pal.palette);
      } else {
        // La app aún no tiene categorías: se le envían las de este perfil (o las de ejemplo)
        const legacy = await NotesStore.getLegacy();
        const list = legacy.palette && legacy.palette.length ? legacy.palette : NotesStore.DEFAULT_PALETTE;
        await NotesStore.internal.writeNotes({ palette: list });
      }
      await storeProfiles(prof.registered);
      if (gen !== generation) return;

      await openSocket(gen, changes.seq);
    } catch (err) {
      fail(gen, err);
    }
  }

  function fail(gen, err) {
    if (gen !== generation) return;
    running = false;
    connected = false;
    closeSocket();
    if (err && (err.status === 401 || err.status === 403)) {
      setConn('revoked', { error: err.message });
      return; // sin reintentos: hay que volver a emparejar
    }
    setConn('offline', { error: err && err.message });
    clearTimeout(retryTimer);
    retryTimer = setTimeout(start, RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
    failures++;
  }

  function closeSocket() {
    clearInterval(pingTimer);
    pingTimer = null;
    if (ws) {
      const old = ws;
      ws = null;
      old.onclose = old.onmessage = old.onerror = old.onopen = null;
      try {
        old.close();
      } catch { /* ya cerrado */ }
    }
  }

  function openSocket(gen, since) {
    return new Promise((resolve) => {
      closeSocket();
      const socket = new WebSocket(Link.WS_URL);
      ws = socket;
      let ready = false;

      socket.onopen = async () => {
        const current = await Link.get();
        if (!current || gen !== generation) return socket.close();
        socket.send(JSON.stringify({ type: 'hello', token: current.token, since }));
      };
      socket.onmessage = async (event) => {
        if (gen !== generation) return;
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        try {
          if (msg.type === 'ready') {
            ready = true;
            connected = true;
            running = false;
            failures = 0;
            lastPong = Date.now();
            await storeProfiles(msg.profiles);
            if (msg.profile) {
              const link2 = await Link.get();
              if (link2 && link2.profileId !== msg.profile.id) await Link.save({ ...link2, profileId: msg.profile.id });
            }
            await setCloud(msg.cloud);
            await setConn('online');
            pingTimer = setInterval(ping, PING_MS);
            flush();
            resolve();
          } else if (msg.type === 'catchup' || msg.type === 'notes') {
            await applyNotes(msg.notes || []);
            if (msg.palette) await applyPalette(msg.palette);
            await bumpSeq(msg.seq);
          } else if (msg.type === 'palette') {
            await applyPalette(msg.palette);
          } else if (msg.type === 'profiles') {
            await storeProfiles(msg.profiles);
          } else if (msg.type === 'status') {
            await setCloud(msg.cloud);
          } else if (msg.type === 'access') {
            // Cambió lo que esta extensión puede ver: se vuelve a sincronizar desde cero
            await local.set({ syncSeq: 0 });
            restart();
          } else if (msg.type === 'pong') {
            lastPong = Date.now();
          }
        } catch (err) {
          console.warn('[notas] error al procesar un mensaje de la app', err);
        }
      };
      socket.onclose = (event) => {
        if (gen !== generation || ws !== socket) return;
        connected = false;
        clearInterval(pingTimer);
        ws = null;
        if (event.code === 4401 || event.code === 4403) {
          running = false;
          setConn('revoked');
        } else {
          fail(gen, new Error(ready ? 'Se cortó la conexión con la app.' : 'La app no aceptó la conexión.'));
        }
        resolve();
      };
      socket.onerror = () => {}; // siempre va seguido de onclose
    });
  }

  function ping() {
    if (!ws || ws.readyState !== 1) return;
    if (Date.now() - lastPong > 3 * PING_MS) {
      ws.close(); // la app no responde: se reconecta
      return;
    }
    ws.send(JSON.stringify({ type: 'ping' }));
  }

  // ---------- cola de salida ----------
  function scheduleFlush() {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 150);
  }

  async function flush() {
    if (!connected) return;
    if (flushing) {
      flushAgain = true;
      return;
    }
    flushing = true;
    const gen = generation;
    try {
      do {
        flushAgain = false;
        await flushOnce();
      } while (flushAgain && connected);
    } catch (err) {
      fail(gen, err);
    } finally {
      flushing = false;
    }
  }

  // Quita de la cola lo enviado, salvo que se haya vuelto a modificar mientras tanto
  async function settle({ notes = {}, palette = null, serverNotes = [] }) {
    await withLock(async () => {
      const { outbox } = await local.get('outbox');
      if (!outbox) return;
      const toSet = {};
      for (const [id, t] of Object.entries(notes)) {
        const entry = outbox.notes[id];
        if (entry && entry.t === t) {
          delete outbox.notes[id];
          const fresh = serverNotes.find((n) => n.id === id);
          if (fresh) toSet[PREFIX + id] = clean(fresh); // la app pudo completar el perfil, etc.
        }
      }
      if (palette !== null && outbox.palette === palette) outbox.palette = null;
      toSet.outbox = outbox;
      await local.set(toSet);
    });
  }

  async function flushOnce() {
    const { outbox } = await local.get('outbox');
    if (!outbox) return;
    const entries = Object.entries(outbox.notes || {});
    const putIds = entries.filter(([, e]) => e.op === 'put').map(([id]) => id);
    const cache = putIds.length ? await local.get(putIds.map((id) => PREFIX + id)) : {};

    // Notas a enviar (las que ya no están en la caché se descartan de la cola)
    const puts = [];
    const orphans = {};
    for (const id of putIds) {
      const note = cache[PREFIX + id];
      if (note) puts.push({ id, t: outbox.notes[id].t, note });
      else orphans[id] = outbox.notes[id].t;
    }
    if (Object.keys(orphans).length) await settle({ notes: orphans });

    if (puts.length >= BULK_MIN) {
      for (let i = 0; i < puts.length; i += 500) {
        const chunk = puts.slice(i, i + 500);
        const res = await Link.request('/notes/bulk', { method: 'POST', body: { notes: chunk.map((p) => p.note) }, timeoutMs: 30000 });
        const refused = new Set((res && res.rejected) || []);
        await rejectNotes(Object.fromEntries(chunk.filter((p) => refused.has(p.id)).map((p) => [p.id, p.t])));
        await settle({ notes: Object.fromEntries(chunk.map((p) => [p.id, p.t])) });
      }
    } else {
      for (const p of puts) {
        try {
          const res = await Link.request('/notes/' + p.id, { method: 'PUT', body: p.note });
          await settle({ notes: { [p.id]: p.t }, serverNotes: [res.note] });
        } catch (err) {
          if (err.status === 400) {
            console.warn('[notas] la app rechazó una nota; se descarta de la cola', p.id, err.code);
            await settle({ notes: { [p.id]: p.t } });
          } else if (err.code === 'not_found' || err.code === 'profile_not_allowed') {
            // La nota es de otro perfil (o de uno que no puede ver): no se queda como copia propia
            console.warn('[notas] esa nota pertenece a otro perfil; se quita de este', p.id);
            await rejectNotes({ [p.id]: p.t });
          } else {
            throw err;
          }
        }
      }
    }

    for (const [id, e] of entries.filter(([, x]) => x.op === 'del')) {
      try {
        await Link.request('/notes/' + id, { method: 'DELETE' });
      } catch (err) {
        if (err.status !== 404) throw err;
      }
      await settle({ notes: { [id]: e.t } });
    }

    if (outbox.palette) {
      const { palette } = await local.get('palette');
      if (Array.isArray(palette)) {
        try {
          await Link.request('/palette', { method: 'PUT', body: { list: palette } });
        } catch (err) {
          if (err.status !== 400) throw err;
        }
      }
      await settle({ palette: outbox.palette });
    }

    // ¿Se añadió algo mientras enviábamos?
    const { outbox: after } = await local.get('outbox');
    if (after && (Object.keys(after.notes || {}).length || after.palette)) flushAgain = true;
  }

  // ---------- control ----------
  function restart() {
    generation++;
    running = false;
    connected = false;
    failures = 0;
    clearTimeout(retryTimer);
    closeSocket();
    return start();
  }

  // La alarma de cada minuto despierta al service worker y reintenta si no hay conexión
  function ensure() {
    if (!connected && !running) {
      clearTimeout(retryTimer);
      start();
    }
  }

  return { start, restart, flush: scheduleFlush, ensure, isConnected: () => connected };
})();
