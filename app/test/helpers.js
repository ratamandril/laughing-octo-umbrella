'use strict';

const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { createCore } = require('../src/core');

const ORIGIN_A = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const ORIGIN_B = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba';

const DETECTED = [
  { browser: 'chrome', dir: 'Default', name: 'Personal', email: 'a@example.com', gaiaName: '' },
  { browser: 'edge', dir: 'Profile 1', name: 'Trabajo', email: 'b@example.com', gaiaName: '' },
  { browser: 'edge', dir: 'Profile 2', name: 'Estudio', email: 'c@example.com', gaiaName: '' },
];

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'notas-test-'));

function fakeProfiles(list = DETECTED) {
  return {
    detect: async () => list,
    findExecutable: (browser) => (browser === 'chrome' ? 'C:\\chrome.exe' : 'C:\\msedge.exe'),
  };
}

// Arranca un núcleo real en un puerto libre, con perfiles y lanzador simulados
async function startCore({ dataDir = tmpDir(), profiles = fakeProfiles(), launcher, core: extra = {} } = {}) {
  const launched = [];
  const core = createCore({
    dataDir,
    port: 0,
    profiles,
    launcher: launcher || {
      open: async (target) => {
        launched.push(target);
        return {};
      },
    },
    storeOptions: { saveDelayMs: 5 },
    ...extra,
  });
  await core.start();
  return { core, dataDir, launched, port: core.server.port, close: () => core.stop() };
}

function request(port, { method = 'GET', path: urlPath = '/', headers = {}, body, raw = false, origin, token, host } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (origin) h.Origin = origin;
    if (token) h.Authorization = `Bearer ${token}`;
    if (host) h.Host = host;
    let payload = null;
    if (body !== undefined) {
      payload = raw ? body : JSON.stringify(body);
      if (!h['Content-Type']) h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try {
          json = text ? JSON.parse(text) : null;
        } catch {
          /* no es JSON */
        }
        resolve({ status: res.statusCode, headers: res.headers, json, text });
      });
    });
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

// Genera un código en la app y empareja una "extensión". Devuelve { token, instanceId }.
async function pair(ctx, { origin = ORIGIN_A, browser = 'chrome', label = 'prueba' } = {}) {
  const { code } = ctx.core.newPairingCode();
  const res = await request(ctx.port, { method: 'POST', path: '/pair', origin, body: { code, browser, label } });
  if (res.status !== 201) throw new Error(`pair falló: ${res.status} ${res.text}`);
  return { token: res.json.token, instanceId: res.json.instanceId, origin };
}

// Cliente WebSocket que acumula mensajes y permite esperar a uno concreto
function connectWs(port, { origin = ORIGIN_A } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { origin });
  const messages = [];
  const waiters = [];
  const closed = new Promise((resolve) => ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() })));
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString('utf8'));
    messages.push(msg);
    for (const w of [...waiters]) {
      if (w.predicate(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }
  });
  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
  });
  return {
    ws,
    messages,
    opened,
    closed,
    send: (obj) => ws.send(JSON.stringify(obj)),
    waitFor: (type, timeoutMs = 2000) =>
      new Promise((resolve, reject) => {
        const existing = messages.find((m) => m.type === type);
        if (existing) return resolve(existing);
        const w = { predicate: (m) => m.type === type, resolve };
        w.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(w), 1);
          reject(new Error(`no llegó el mensaje "${type}"`));
        }, timeoutMs);
        waiters.push(w);
        return undefined;
      }),
    // Comprueba que NO llega un mensaje de ese tipo en un rato
    expectNone: async (type, ms = 250) => {
      await new Promise((r) => setTimeout(r, ms));
      if (messages.some((m) => m.type === type)) throw new Error(`llegó un "${type}" inesperado`);
    },
    close: () => ws.close(),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { ORIGIN_A, ORIGIN_B, DETECTED, tmpDir, fakeProfiles, startCore, request, pair, connectWs, sleep };
