'use strict';

const { test, describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startCore, request, pair, connectWs, ORIGIN_A, ORIGIN_B, sleep } = require('./helpers');

const note = (id, extra = {}) => ({ id, url: 'https://example.com/' + id, title: 'T ' + id, ...extra });

describe('API HTTP', () => {
  let ctx, a, b;
  before(async () => {
    ctx = await startCore();
    a = await pair(ctx, { origin: ORIGIN_A, browser: 'chrome', label: 'A' });
    b = await pair(ctx, { origin: ORIGIN_B, browser: 'edge', label: 'B' });
  });
  after(() => ctx.close());

  const call = (who, opts) => request(ctx.port, { origin: who.origin, token: who.token, ...opts });

  test('health es público y no pide origen en GET', async () => {
    const r = await request(ctx.port, { path: '/health' });
    assert.equal(r.status, 200);
    assert.equal(r.json.app, 'notas-por-url');
  });

  test('rechaza Host ajeno (DNS rebinding)', async () => {
    const r = await request(ctx.port, { path: '/health', host: 'evil.com' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'bad_host');
  });

  test('rechaza orígenes web, también en GET', async () => {
    for (const origin of ['https://evil.com', 'http://localhost:3000', 'null']) {
      const r = await request(ctx.port, { path: '/health', origin });
      assert.equal(r.status, 403, origin);
    }
  });

  test('POST sin Origin se rechaza; preflight solo para extensiones', async () => {
    const r = await request(ctx.port, { method: 'POST', path: '/pair', body: { code: 'x' } });
    assert.equal(r.status, 403);
    const pre = await request(ctx.port, { method: 'OPTIONS', path: '/notes', origin: ORIGIN_A });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], ORIGIN_A);
    const bad = await request(ctx.port, { method: 'OPTIONS', path: '/notes' });
    assert.equal(bad.status, 403);
  });

  test('rutas protegidas piden token válido', async () => {
    assert.equal((await request(ctx.port, { path: '/notes', origin: ORIGIN_A })).status, 401);
    assert.equal((await request(ctx.port, { path: '/notes', origin: ORIGIN_A, token: 'falso' })).status, 401);
  });

  test('el token está atado al origen con el que se emparejó', async () => {
    const r = await request(ctx.port, { path: '/notes', origin: ORIGIN_B, token: a.token });
    assert.equal(r.status, 403);
    assert.equal(r.json.error, 'origin_mismatch');
  });

  test('404 y 405', async () => {
    assert.equal((await call(a, { path: '/nada' })).status, 404);
    assert.equal((await call(a, { method: 'DELETE', path: '/palette' })).status, 405);
  });

  test('exige content-type JSON y JSON objeto', async () => {
    const t = await call(a, { method: 'PUT', path: '/notes/x1', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(note('x1')), raw: true });
    assert.equal(t.status, 415);
    const bad = await call(a, { method: 'PUT', path: '/notes/x1', body: '{no', raw: true });
    assert.equal(bad.status, 400);
    const arr = await call(a, { method: 'PUT', path: '/notes/x1', body: [1] });
    assert.equal(arr.status, 400);
  });

  test('cuerpo gigante → 413', async () => {
    const r = await call(a, { method: 'PUT', path: '/notes/big', body: { id: 'big', url: 'https://a.com', description: 'x'.repeat(2 * 1024 * 1024) } }).catch((e) => ({ status: 'reset', e }));
    assert.ok(r.status === 413 || r.status === 'reset');
  });

  test('PUT crea (201), actualiza (200) y GET lista', async () => {
    const c = await call(a, { method: 'PUT', path: '/notes/n1', body: note('n1', { tags: 'a,b' }) });
    assert.equal(c.status, 201);
    assert.ok(c.json.note.seq > 0);
    const u = await call(a, { method: 'PUT', path: '/notes/n1', body: note('n1', { title: 'otra' }) });
    assert.equal(u.status, 200);
    const list = await call(b, { path: '/notes' }); // otra extensión ve la nota
    assert.equal(list.json.notes.find((n) => n.id === 'n1').title, 'otra');
    assert.equal((await call(a, { method: 'PUT', path: '/notes/n1', body: note('otro') })).status, 400);
    assert.equal((await call(a, { method: 'PUT', path: '/notes/n2', body: { id: 'n2', url: 'javascript:1' } })).status, 400);
  });

  test('since devuelve solo lo nuevo y los borrados', async () => {
    const before = (await call(a, { path: '/notes' })).json.seq;
    await call(a, { method: 'PUT', path: '/notes/n3', body: note('n3') });
    await call(a, { method: 'DELETE', path: '/notes/n3' });
    const r = await call(b, { path: `/notes?since=${before}` });
    const n3 = r.json.notes.find((n) => n.id === 'n3');
    assert.equal(n3.deleted, true);
    assert.equal((await call(a, { path: '/notes?since=-1' })).status, 400);
    assert.equal((await call(a, { path: '/notes?since=abc' })).status, 400);
    assert.equal((await call(a, { method: 'DELETE', path: '/notes/inexistente' })).status, 404);
  });

  test('bulk importa, no pisa lo más reciente y cuenta inválidas', async () => {
    await call(a, { method: 'PUT', path: '/notes/bk1', body: note('bk1', { title: 'servidor' }) });
    const r = await call(a, {
      method: 'POST',
      path: '/notes/bulk',
      body: { notes: [note('bk1', { title: 'viejo', updatedAt: 1 }), note('bk2', { createdAt: 5, updatedAt: 5 }), { id: 'bad', url: 'ftp://x' }] },
    });
    assert.deepEqual([r.json.imported, r.json.skipped, r.json.invalid], [1, 1, 1]);
    const list = (await call(a, { path: '/notes' })).json.notes;
    assert.equal(list.find((n) => n.id === 'bk1').title, 'servidor');
    assert.equal(list.find((n) => n.id === 'bk2').updatedAt, 5);
    assert.equal((await call(a, { method: 'POST', path: '/notes/bulk', body: { notes: 'no' } })).status, 400);
  });

  test('paleta: GET/PUT y validación', async () => {
    const put = await call(a, { method: 'PUT', path: '/palette', body: { list: [{ id: 'r', hex: '#ff0000', name: 'Rojo' }] } });
    assert.equal(put.status, 200);
    const got = await call(b, { path: '/palette' });
    assert.equal(got.json.palette.list[0].hex, '#ff0000');
    assert.equal((await call(a, { method: 'PUT', path: '/palette', body: { list: 'x' } })).status, 400);
  });

  test('perfiles: asignar, notas con perfil, renombrar y validar', async () => {
    const list = await call(a, { path: '/profiles' });
    assert.equal(list.json.detected.length, 3);
    assert.equal((await call(a, { method: 'PUT', path: '/me/profile', body: { browser: 'chrome', dir: 'NoExiste' } })).status, 400);
    assert.equal((await call(a, { method: 'PUT', path: '/me/profile', body: { browser: 'firefox', dir: 'Default' } })).status, 400);
    const set = await call(a, { method: 'PUT', path: '/me/profile', body: { browser: 'chrome', dir: 'Default' } });
    assert.equal(set.status, 200);
    const pid = set.json.profile.id;
    const me = await call(a, { path: '/me' });
    assert.equal(me.json.profile.id, pid);

    const n = await call(a, { method: 'PUT', path: '/notes/pn', body: note('pn') });
    assert.equal(n.json.note.profileId, pid); // hereda el perfil de la instancia
    assert.equal((await call(a, { method: 'PUT', path: '/notes/pn2', body: note('pn2', { profileId: 'p_inexistente' }) })).status, 400);

    const ren = await call(a, { method: 'PATCH', path: `/profiles/${pid}`, body: { name: 'Casa' } });
    assert.equal(ren.json.profile.name, 'Casa');
    assert.equal((await call(a, { method: 'PATCH', path: '/profiles/p_nada', body: { name: 'x' } })).status, 404);
    assert.equal((await call(a, { method: 'PATCH', path: `/profiles/${pid}`, body: { name: '  ' } })).status, 400);
  });

  test('/open lanza en el navegador y perfil de la nota', async () => {
    ctx.launched.length = 0;
    const pid = (await call(a, { path: '/me' })).json.profile.id;
    const r = await call(b, { method: 'POST', path: '/open', body: { noteId: 'pn' } });
    assert.equal(r.status, 200);
    assert.deepEqual(ctx.launched[0], { browser: 'chrome', dir: 'Default', url: 'https://example.com/pn' });
    assert.equal((await call(b, { method: 'POST', path: '/open', body: { noteId: 'zzz' } })).status, 404);
    assert.equal((await call(b, { method: 'POST', path: '/open', body: { url: 'https://a.com' } })).status, 400); // sin perfil
    assert.equal((await call(b, { method: 'POST', path: '/open', body: { url: 'https://a.com', profileId: 'p_nada' } })).status, 404);
    const direct = await call(b, { method: 'POST', path: '/open', body: { url: 'https://a.com/x', profileId: pid } });
    assert.equal(direct.status, 200);
  });

  test('/open limita la frecuencia', async () => {
    const pid = (await call(a, { path: '/me' })).json.profile.id;
    let limited = false;
    for (let i = 0; i < 30; i++) {
      const r = await call(a, { method: 'POST', path: '/open', body: { url: 'https://a.com', profileId: pid } });
      if (r.status === 429) limited = true;
    }
    assert.ok(limited);
  });
});

describe('/open con errores del lanzador', () => {
  test('traduce errores y detecta perfil desaparecido', async () => {
    const err = Object.assign(new Error('x'), { code: 'browser_not_found' });
    const ctx = await startCore({ launcher: { open: async () => { throw err; } } });
    try {
      const a = await pair(ctx);
      const set = await request(ctx.port, { method: 'PUT', path: '/me/profile', origin: a.origin, token: a.token, body: { browser: 'edge', dir: 'Profile 1' } });
      const pid = set.json.profile.id;
      const r = await request(ctx.port, { method: 'POST', path: '/open', origin: a.origin, token: a.token, body: { url: 'https://a.com', profileId: pid } });
      assert.equal(r.status, 409);
      assert.equal(r.json.error, 'browser_not_found');
    } finally {
      await ctx.close();
    }
  });
});

describe('emparejamiento por HTTP', () => {
  test('sin código activo 410, código malo 401, bloqueo 429, y solo desde extensión', async () => {
    const ctx = await startCore();
    try {
      const go = (code, origin = ORIGIN_A) => request(ctx.port, { method: 'POST', path: '/pair', origin, body: { code } });
      assert.equal((await go('AAAA-AAAA')).status, 410);
      const { code } = ctx.core.newPairingCode();
      assert.equal((await go('AAAA-AAAA', undefined)).status, 401);
      assert.equal((await request(ctx.port, { method: 'POST', path: '/pair', body: { code } })).status, 403);
      for (let i = 0; i < 3; i++) await go('AAAA-AAAA');
      assert.equal((await go('AAAA-AAAA')).status, 429);
      assert.equal((await go(code)).status, 410);
    } finally {
      await ctx.close();
    }
  });
});

describe('WebSocket', () => {
  let ctx, a, b;
  before(async () => {
    ctx = await startCore();
    a = await pair(ctx, { origin: ORIGIN_A });
    b = await pair(ctx, { origin: ORIGIN_B });
  });
  after(() => ctx.close());
  const put = (who, id, extra) => request(ctx.port, { method: 'PUT', path: '/notes/' + id, origin: who.origin, token: who.token, body: note(id, extra) });

  test('rechaza orígenes web y falta de origen en el upgrade', async () => {
    await assert.rejects(connectWs(ctx.port, { origin: 'https://evil.com' }).opened);
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${ctx.port}/ws`);
    await new Promise((resolve) => { ws.on('error', resolve); ws.on('close', resolve); });
  });

  test('hello con token malo cierra 4401; sin hello también', async () => {
    const c = connectWs(ctx.port);
    await c.opened;
    c.send({ type: 'hello', token: 'falso' });
    assert.equal((await c.closed).code, 4401);
    const d = connectWs(ctx.port);
    await d.opened;
    d.send({ type: 'ping' });
    assert.equal((await d.closed).code, 4401);
  });

  test('token de otro origen cierra 4403', async () => {
    const c = connectWs(ctx.port, { origin: ORIGIN_B });
    await c.opened;
    c.send({ type: 'hello', token: a.token });
    assert.equal((await c.closed).code, 4403);
  });

  test('ready, ping/pong y catch-up por seq', async () => {
    await put(a, 'w1');
    await put(a, 'w2');
    const c = connectWs(ctx.port, { origin: ORIGIN_B });
    await c.opened;
    c.send({ type: 'hello', token: b.token, since: 0 });
    const ready = await c.waitFor('ready');
    assert.equal(ready.instanceId, b.instanceId);
    const catchup = await c.waitFor('catchup');
    assert.ok(catchup.notes.length >= 2);
    c.send({ type: 'ping' });
    await c.waitFor('pong');
    c.close();
  });

  test('un cambio se empuja a las demás extensiones pero no a quien lo hizo', async () => {
    const ca = connectWs(ctx.port, { origin: ORIGIN_A });
    const cb = connectWs(ctx.port, { origin: ORIGIN_B });
    await Promise.all([ca.opened, cb.opened]);
    ca.send({ type: 'hello', token: a.token });
    cb.send({ type: 'hello', token: b.token });
    await Promise.all([ca.waitFor('ready'), cb.waitFor('ready')]);

    await put(a, 'push1', { title: 'hola' });
    const msg = await cb.waitFor('notes');
    assert.equal(msg.notes[0].id, 'push1');
    await ca.expectNone('notes');

    await request(ctx.port, { method: 'DELETE', path: '/notes/push1', origin: b.origin, token: b.token });
    await sleep(50);
    assert.ok(ca.messages.some((m) => m.type === 'notes' && m.notes[0].deleted));
    ca.close();
    cb.close();
  });

  test('revocar cierra el socket con 4403 y el token deja de valer', async () => {
    const c3 = await pair(ctx, { origin: 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz' });
    const c = connectWs(ctx.port, { origin: c3.origin });
    await c.opened;
    c.send({ type: 'hello', token: c3.token });
    await c.waitFor('ready');
    ctx.core.revokeInstance(c3.instanceId);
    assert.equal((await c.closed).code, 4403);
    assert.equal((await request(ctx.port, { path: '/me', origin: c3.origin, token: c3.token })).status, 401);
  });

  test('mensajes binarios o JSON roto cierran con 4400', async () => {
    const c = connectWs(ctx.port);
    await c.opened;
    c.ws.send('{roto');
    assert.equal((await c.closed).code, 4400);
  });
});

describe('bulk con tombstones', () => {
  test('un borrado importado borra de verdad, no deja una nota vacía viva', async () => {
    const ctx = await startCore();
    try {
      const a = await pair(ctx);
      const h = { origin: a.origin, token: a.token };
      await request(ctx.port, { ...h, method: 'PUT', path: '/notes/t1', body: note('t1', { title: 'real' }) });
      const r = await request(ctx.port, { ...h, method: 'POST', path: '/notes/bulk', body: { notes: [{ id: 't1', url: 'https://example.com/t1', deleted: true, updatedAt: Date.now() + 1000 }] } });
      assert.equal(r.json.imported, 1);
      const list = (await request(ctx.port, { ...h, path: '/notes' })).json.notes;
      assert.equal(list.find((n) => n.id === 't1'), undefined);
    } finally {
      await ctx.close();
    }
  });
  test('/pair rechaza cuerpos grandes', async () => {
    const ctx = await startCore();
    try {
      const r = await request(ctx.port, { method: 'POST', path: '/pair', origin: ORIGIN_A, body: { code: 'x'.repeat(5000) } }).catch(() => ({ status: 413 }));
      assert.equal(r.status, 413);
    } finally {
      await ctx.close();
    }
  });
});

describe('DELETE /me', () => {
  test('la extensión puede desvincularse y su token deja de valer', async () => {
    const ctx = await startCore();
    try {
      const a = await pair(ctx);
      const r = await request(ctx.port, { method: 'DELETE', path: '/me', origin: a.origin, token: a.token });
      assert.equal(r.status, 200);
      assert.equal((await request(ctx.port, { path: '/me', origin: a.origin, token: a.token })).status, 401);
      assert.equal(ctx.core.registry.listInstances().length, 0);
    } finally {
      await ctx.close();
    }
  });
});


describe('papelera', () => {
  test('las extensiones no reciben el contenido de lo borrado; la app puede restaurarlo', async () => {
    const ctx = await startCore();
    try {
      const a = await pair(ctx, { origin: ORIGIN_A });
      const b = await pair(ctx, { origin: ORIGIN_B });
      const h = (who) => ({ origin: who.origin, token: who.token });
      await request(ctx.port, { ...h(a), method: 'PUT', path: '/notes/t1', body: note('t1', { title: 'privada', description: 'texto' }) });

      const c = connectWs(ctx.port, { origin: ORIGIN_B });
      await c.opened;
      c.send({ type: 'hello', token: b.token });
      await c.waitFor('ready');

      const del = await request(ctx.port, { ...h(a), method: 'DELETE', path: '/notes/t1' });
      assert.equal(del.json.note.title, '');
      assert.equal(del.json.note.description, '');
      const pushed = await c.waitFor('notes');
      assert.equal(pushed.notes[0].deleted, true);
      assert.equal(pushed.notes[0].description, '');
      const list = await request(ctx.port, { ...h(b), path: '/notes?since=0' });
      assert.ok(!JSON.stringify(list.json).includes('texto'));

      // en la app sigue completa
      assert.equal(ctx.core.trash()[0].description, 'texto');
      const restored = ctx.core.restoreNote('t1');
      assert.equal(restored.deleted, false);
      const after = await request(ctx.port, { ...h(b), path: '/notes' });
      assert.equal(after.json.notes.find((n) => n.id === 't1').description, 'texto');
      c.close();
    } finally {
      await ctx.close();
    }
  });
});

describe('aislamiento entre perfiles', () => {
  const setup = async () => {
    const ctx = await startCore();
    const a = await pair(ctx, { origin: ORIGIN_A, profile: { browser: 'chrome', dir: 'Default' } }); // Personal
    const b = await pair(ctx, { origin: ORIGIN_B, profile: { browser: 'edge', dir: 'Profile 1' } }); // Trabajo
    const call = (who, opts) => request(ctx.port, { origin: who.origin, token: who.token, ...opts });
    return { ctx, a, b, call };
  };

  test('sin perfil asignado no se sincronizan notas (409)', async () => {
    const ctx = await startCore();
    try {
      const x = await pair(ctx, { profile: null });
      for (const [method, path, body] of [['GET', '/notes'], ['PUT', '/notes/n1', note('n1')], ['POST', '/notes/bulk', { notes: [] }], ['DELETE', '/notes/n1']]) {
        const r = await request(ctx.port, { origin: x.origin, token: x.token, method, path, body });
        assert.equal(r.status, 409, `${method} ${path}`);
        assert.equal(r.json.error, 'profile_required');
      }
    } finally {
      await ctx.close();
    }
  });

  test('cada extensión solo ve, edita, borra y abre lo de su perfil', async () => {
    const { ctx, a, b, call } = await setup();
    try {
      await call(a, { method: 'PUT', path: '/notes/na', body: note('na', { title: 'personal' }) });
      await call(b, { method: 'PUT', path: '/notes/nb', body: note('nb', { title: 'trabajo' }) });

      assert.deepEqual((await call(a, { path: '/notes' })).json.notes.map((n) => n.id), ['na']);
      assert.deepEqual((await call(b, { path: '/notes' })).json.notes.map((n) => n.id), ['nb']);

      // no se revela que existe: 404, igual que si no existiera
      assert.equal((await call(b, { method: 'PUT', path: '/notes/na', body: note('na', { title: 'robada' }) })).status, 404);
      assert.equal((await call(b, { method: 'DELETE', path: '/notes/na' })).status, 404);
      assert.equal(ctx.core.store.get('na').title, 'personal');
      assert.equal((await call(b, { method: 'POST', path: '/open', body: { noteId: 'na' } })).status, 404);

      // tampoco puede crear notas en otro perfil
      const r = await call(b, { method: 'PUT', path: '/notes/x', body: note('x', { profileId: a.profileId }) });
      assert.equal(r.status, 403);
      const bulk = await call(b, { method: 'POST', path: '/notes/bulk', body: { notes: [note('na', { updatedAt: Date.now() + 1000 }), note('y', { profileId: a.profileId })] } });
      assert.deepEqual([bulk.json.imported, bulk.json.invalid], [0, 2]);
      assert.equal((await call(b, { method: 'POST', path: '/open', body: { url: 'https://a.com', profileId: a.profileId } })).status, 404);

      // la lista de perfiles solo trae los visibles
      assert.deepEqual((await call(b, { path: '/profiles' })).json.registered.map((p) => p.id), [b.profileId]);
    } finally {
      await ctx.close();
    }
  });

  test('un perfil vacío (null o "") se completa con el de la extensión, en PUT y en bulk', async () => {
    const { ctx, a, call } = await setup();
    try {
      const put = await call(a, { method: 'PUT', path: '/notes/p1', body: note('p1', { profileId: null }) });
      assert.equal(put.status, 201);
      assert.equal(put.json.note.profileId, a.profileId);
      const bulk = await call(a, { method: 'POST', path: '/notes/bulk', body: { notes: [note('p2', { profileId: null }), note('p3', { profileId: '' })] } });
      assert.deepEqual([bulk.json.imported, bulk.json.invalid, bulk.json.rejected], [2, 0, []]);
      assert.equal(ctx.core.store.get('p2').profileId, a.profileId);
      assert.equal(ctx.core.store.get('p3').profileId, a.profileId);
    } finally {
      await ctx.close();
    }
  });

  test('bulk avisa qué ids rechazó por ser de otro perfil', async () => {
    const { ctx, a, b, call } = await setup();
    try {
      await call(a, { method: 'PUT', path: '/notes/na', body: note('na') });
      const bulk = await call(b, { method: 'POST', path: '/notes/bulk', body: { notes: [note('na', { updatedAt: Date.now() + 1000 }), note('nb')] } });
      assert.equal(bulk.json.imported, 1);
      assert.deepEqual(bulk.json.rejected, ['na']);
      assert.equal(ctx.core.store.get('na').profileId, a.profileId); // la nota de A no cambió
    } finally {
      await ctx.close();
    }
  });

  test('desde la app se asigna perfil a una nota sin perfil, y solo a esas', async () => {
    const { ctx, a, b, call } = await setup();
    try {
      ctx.core.store.put({ ...note('huerfana'), profileId: null });
      assert.equal(ctx.core.store.get('huerfana').profileId, null);
      assert.equal((await call(a, { path: '/notes' })).json.notes.length, 0); // ninguna extensión la ve
      const cb = connectWs(ctx.port, { origin: ORIGIN_B });
      await cb.opened;
      cb.send({ type: 'hello', token: b.token });
      await cb.waitFor('ready');

      assert.equal(ctx.core.assignNoteProfile('huerfana', 'p_no_existe'), null);
      assert.ok(ctx.core.assignNoteProfile('huerfana', b.profileId));
      assert.equal(ctx.core.store.get('huerfana').profileId, b.profileId);
      assert.deepEqual((await call(b, { path: '/notes' })).json.notes.map((n) => n.id), ['huerfana']);
      assert.equal((await call(a, { path: '/notes' })).json.notes.length, 0);
      const live = await cb.waitFor('notes');
      assert.equal(live.notes[0].id, 'huerfana');
      // ya tiene perfil: no se reasigna (las extensiones del dueño anterior quedarían con una copia)
      assert.equal(ctx.core.assignNoteProfile('huerfana', a.profileId), null);
      cb.close();
    } finally {
      await ctx.close();
    }
  });

  test('los cambios en vivo solo llegan a quien puede verlos', async () => {
    const { ctx, a, b, call } = await setup();
    try {
      const cb = connectWs(ctx.port, { origin: ORIGIN_B });
      await cb.opened;
      cb.send({ type: 'hello', token: b.token });
      await cb.waitFor('ready');
      await call(a, { method: 'PUT', path: '/notes/na', body: note('na') });
      await cb.expectNone('notes');
      ctx.core.deleteNote('na'); // desde la app
      await cb.expectNone('notes');
      cb.close();
    } finally {
      await ctx.close();
    }
  });

  test('dar y quitar permiso: ve las notas del otro perfil y se le avisa para resincronizar', async () => {
    const { ctx, a, b, call } = await setup();
    try {
      await call(a, { method: 'PUT', path: '/notes/na', body: note('na', { title: 'personal' }) });
      const cb = connectWs(ctx.port, { origin: ORIGIN_B });
      await cb.opened;
      cb.send({ type: 'hello', token: b.token });
      await cb.waitFor('ready');

      assert.equal(ctx.core.setCanSee(b.instanceId, [a.profileId, 'p_inexistente']), true);
      await cb.waitFor('access');
      const seen = (await call(b, { path: '/notes' })).json.notes.map((n) => n.id);
      assert.deepEqual(seen.sort(), ['na']);
      assert.deepEqual((await call(b, { path: '/profiles' })).json.registered.map((p) => p.id).sort(), [a.profileId, b.profileId].sort());
      assert.equal((await call(b, { method: 'POST', path: '/open', body: { noteId: 'na' } })).status, 200);

      // ahora los cambios de A sí le llegan
      await call(a, { method: 'PUT', path: '/notes/na2', body: note('na2') });
      await cb.waitFor('notes');

      ctx.core.setCanSee(b.instanceId, []);
      assert.deepEqual((await call(b, { path: '/notes' })).json.notes, []);
      assert.equal((await call(b, { method: 'POST', path: '/open', body: { noteId: 'na' } })).status, 404);
      cb.close();
    } finally {
      await ctx.close();
    }
  });
});

describe('estado de la nube hacia las extensiones', () => {
  test('ready trae el estado y los cambios se avisan por WebSocket', async () => {
    const ctx = await startCore();
    try {
      const a = await pair(ctx);
      const c = connectWs(ctx.port);
      await c.opened;
      c.send({ type: 'hello', token: a.token });
      const ready = await c.waitFor('ready');
      assert.equal(ready.cloud.state, 'disabled');
      ctx.core.server.setCloud({ state: 'online', pending: 3, syncedSeq: 7 });
      const status = await c.waitFor('status');
      assert.deepEqual(status.cloud, { state: 'online', pending: 3, syncedSeq: 7 });
      c.close();
    } finally {
      await ctx.close();
    }
  });
});
