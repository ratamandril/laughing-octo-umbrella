// Notas de otros perfiles. Se piden a la app cuando hacen falta y NO se guardan en la extensión:
// sin la app abierta solo se ven las notas propias. Lo usan el popup y la página completa.
//
// host = {
//   box:       elemento donde se dibujan las filas
//   scroller:  (opcional) elemento con barra de desplazamiento, para no perder la posición al redibujar
//   getUrl():  URL de la pestaña actual (o null): permite contar y separar "notas de esta página"
//   makeCard(note, profile): tarjeta de una nota ajena
//   onState({ profiles, state }): avisa de si hay otros perfiles (para mostrar el interruptor de búsqueda global)
// }
const Others = (() => {
  const PAGE = 20;
  const PAGE_NOTES_MAX = 50;

  function mount(host) {
    let summary = [];        // resumen de los demás perfiles (/others)
    let state = 'idle';      // idle | ok | offline | error
    let errorText = '';
    let knownOthers = 0;     // perfiles ajenos conocidos por la caché (para avisar si la app no está)
    let query = '';          // búsqueda global activa (vacío = sin búsqueda)
    let groups = null;       // resultados de la búsqueda global
    const open = new Set();  // perfiles desplegados
    const bodies = new Map(); // id -> { page, list, total, offset, loading, error }
    let stale = false;       // el service worker es de una versión anterior (falta recargar la extensión)
    let generation = 0;      // descarta respuestas de consultas ya superadas

    const titleOf = (p) => profileLabel(p);

    async function refresh() {
      const gen = ++generation;
      const link = await Link.get();
      if (!link || !link.profileId) {
        summary = []; groups = null; state = 'idle';
        draw();
        notify();
        return;
      }
      knownOthers = (await Link.profiles()).filter((p) => p.id !== link.profileId).length;
      try {
        if (query) {
          const res = await Link.search(query);
          if (gen !== generation) return;
          groups = res.groups;
          bodies.clear();
          for (const g of groups) bodies.set(g.profile.id, { page: null, list: g.notes, total: g.total, offset: g.notes.length });
        } else {
          const res = await Link.others(host.getUrl());
          if (gen !== generation) return;
          groups = null;
          summary = res.profiles;
          for (const id of [...open]) if (!summary.some((p) => p.id === id && p.sharing !== 'private')) { open.delete(id); bodies.delete(id); }
        }
        state = 'ok';
        errorText = '';
        try { const ss = await chrome.storage.session.get(['swProto', 'conn']); stale = !ss.swProto && !!ss.conn && ss.conn.state === 'online'; } catch { stale = false; }
      } catch (err) {
        if (gen !== generation) return;
        state = err.offline ? 'offline' : 'error';
        errorText = err.message;
      }
      draw();
      notify();
      if (state === 'ok' && !query) for (const id of open) loadBody(id);
    }

    // Texto de la búsqueda global ('' = sin búsqueda)
    function setQuery(q) {
      const next = (q || '').trim();
      if (next === query) return;
      query = next;
      refresh();
    }

    function notify() {
      if (host.onState) host.onState({ profiles: summary.length || (state === 'offline' ? knownOthers : 0), state });
    }

    async function loadBody(id, { more = false } = {}) {
      let b = bodies.get(id);
      const keep = b ? Math.min(Math.max(PAGE, b.offset), PAGE_NOTES_MAX) : PAGE; // al refrescar se conserva lo ya desplegado (hasta 50)
      if (!b || !more) b = { page: b ? b.page : null, list: b ? b.list : [], total: b ? b.total : 0, offset: b ? b.offset : 0, loading: true, error: '' };
      else b.loading = true;
      bodies.set(id, b);
      draw();
      const gen = generation;
      try {
        if (query) {
          const res = await Link.profileNotes(id, { q: query, offset: more ? b.offset : 0, limit: more ? PAGE : keep });
          if (gen !== generation) return;
          b.list = more ? b.list.concat(res.notes) : res.notes;
          b.offset = (more ? b.offset : 0) + res.notes.length;
          b.total = res.total;
        } else {
          const url = host.getUrl();
          const p = summary.find((x) => x.id === id);
          const page = !more && url && p && p.forUrl ? (await Link.profileNotes(id, { url, limit: PAGE_NOTES_MAX })).notes : (more ? b.page : []);
          const res = await Link.profileNotes(id, { offset: more ? b.offset : 0, limit: more ? PAGE : keep });
          if (gen !== generation) return;
          const onPage = new Set((page || []).map((n) => n.id));
          const fresh = res.notes.filter((n) => !onPage.has(n.id));
          b.page = page;
          b.list = more ? b.list.concat(fresh) : fresh;
          b.offset = (more ? b.offset : 0) + res.notes.length;
          b.total = res.total;
        }
        b.error = '';
      } catch (err) {
        if (gen !== generation) return;
        b.error = err.message;
      }
      b.loading = false;
      draw();
    }

    function toggle(id) {
      if (open.has(id)) open.delete(id);
      else {
        open.add(id);
        loadBody(id);
      }
      draw();
    }

    // ---------- dibujo ----------
    function countText(p) {
      const parts = [];
      if (p.forUrl) parts.push(p.forUrl + ' de esta página');
      parts.push(p.total + (p.total === 1 ? ' nota' : ' notas'));
      return parts.join(' · ');
    }

    function head(p, expanded, interactive) {
      const label = [el('span', { class: 'chev', 'aria-hidden': 'true' }, '▾'), el('span', { class: 'op-name' }, titleOf(p))];
      if (p.email) label.push(el('span', { class: 'op-email muted' }, p.email));
      if (p.unlinked) label.push(el('span', { class: 'op-email muted' }, '(de otro equipo)'));
      if (p.sharing === 'edit') label.push(el('span', { class: 'op-email muted' }, '· permite editar'));
      label.push(el('span', { class: 'op-count muted' }, p.total !== undefined ? countText(p) : ''));
      return interactive
        ? el('button', { type: 'button', class: 'sec-head op-head', 'aria-expanded': String(expanded), onclick: () => toggle(p.id) }, ...label)
        : el('div', { class: 'sec-head op-head static' }, ...label);
    }

    function cards(notes, profile) {
      const box = el('div', { class: 'op-cards' });
      for (const n of notes) box.append(host.makeCard(n, profile));
      return box;
    }

    function body(p) {
      const b = bodies.get(p.id);
      const wrap = el('div', { class: 'sec-body op-body' });
      if (!b) return wrap;
      if (b.error) wrap.append(el('p', { class: 'error op-state' }, b.error));
      if (b.page && b.page.length) {
        wrap.append(el('h4', { class: 'op-sub' }, 'Notas de esta página (' + b.page.length + ')'), cards(b.page, p));
      }
      if (b.list.length) {
        if (!query) wrap.append(el('h4', { class: 'op-sub' }, b.page && b.page.length ? 'Otras notas' : 'Todas las notas'));
        wrap.append(cards(b.list, p));
      }
      if (b.loading && !b.list.length && !(b.page && b.page.length)) wrap.append(el('p', { class: 'muted op-state' }, 'Cargando…'));
      else if (!b.error && !b.list.length && !(b.page && b.page.length)) wrap.append(el('p', { class: 'muted op-state' }, 'Este perfil no tiene notas.'));
      if (!b.loading && b.offset < b.total) {
        wrap.append(el('button', { type: 'button', class: 'ghost op-more', onclick: () => loadBody(p.id, { more: true }) },
          'Mostrar más (' + (b.total - b.offset) + ' restantes)'));
      }
      return wrap;
    }

    function row(p, { expanded, interactive }) {
      if (p.sharing === 'private') {
        return el('div', { class: 'op locked', title: 'Este perfil no comparte sus notas' }, '🔒 ' + titleOf(p), el('span', { class: 'op-email muted' }, 'privado'));
      }
      const wrap = el('section', { class: 'op' });
      wrap.append(head(p, expanded, interactive));
      if (expanded) wrap.append(body(p));
      return wrap;
    }

    function draw() {
      const top = host.scroller ? host.scroller.scrollTop : 0;
      host.box.replaceChildren();
      if (state === 'idle') { host.box.hidden = true; return; }
      host.box.hidden = false;

      if (state !== 'ok') {
        // Sin la app abierta no hay notas ajenas; solo se avisa si se sabe que existen otros perfiles
        if (knownOthers || query) {
          host.box.append(el('p', { class: 'muted op-offline' }, state === 'offline'
            ? 'Las notas de otros perfiles necesitan la app abierta.'
            : 'No se pudieron consultar las notas de otros perfiles: ' + errorText));
        } else host.box.hidden = true;
        return;
      }

      if (query) {
        host.box.append(el('h3', { class: 'others-title' }, 'En otros perfiles'));
        if (!groups.length) host.box.append(el('p', { class: 'muted op-state' }, 'Ningún otro perfil tiene coincidencias.'));
        for (const g of groups) host.box.append(row({ ...g.profile, total: g.total }, { expanded: true, interactive: false }));
      } else {
        if (!summary.length) { host.box.hidden = true; return; }
        if (stale) host.box.append(el('p', { class: 'error op-state' }, 'La extensión se actualizó pero falta recargarla (botón ⟳ en la página de extensiones del navegador). Hasta entonces los cambios de otros perfiles tardan en verse.'));
        host.box.append(el('h3', { class: 'others-title' }, 'Otros perfiles'));
        const ordered = [...summary].sort((a, b) => (b.forUrl || 0) - (a.forUrl || 0) || (b.total || 0) - (a.total || 0) || a.name.localeCompare(b.name));
        for (const p of ordered) host.box.append(row(p, { expanded: open.has(p.id), interactive: true }));
      }
      if (host.scroller) host.scroller.scrollTop = top;
    }

    // Red de seguridad por si se pierde un aviso (p. ej. el service worker estaba dormido): al volver a la ventana
    // y cada 20 s mientras la página se ve, se vuelve a preguntar a la app. Es una consulta barata y sin parpadeo.
    const again = () => { if (document.visibilityState === 'visible' && state !== 'idle' && !(typeof menuIsOpen === 'function' && menuIsOpen())) refresh(); };
    document.addEventListener('visibilitychange', again);
    window.addEventListener('focus', again);
    setInterval(again, 20000);

    // Se redibuja con lo que ya hay (p. ej. al cambiar la vista de una nota)
    return { refresh, setQuery, redraw: draw, loadBody };
  }

  return { mount };
})();
