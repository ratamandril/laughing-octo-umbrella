'use strict';

// Emparejamiento y autenticación.
//
// No hay cuentas ni contraseñas de usuario. La app muestra un código de un solo uso;
// quien lo escribe en una extensión recibe un token que queda ligado al origen de esa
// extensión (chrome-extension://<id>). Cada petición debe traer el token Y venir de ese origen.

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { publicInstance } = require('./registry');

// Sin 0/O, 1/I/L para que el código se lea sin dudas
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

class Auth extends EventEmitter {
  constructor(registry, { now = Date.now, codeTtlMs = 5 * 60 * 1000, maxAttempts = 5 } = {}) {
    super();
    this.registry = registry;
    this.now = now;
    this.codeTtlMs = codeTtlMs;
    this.maxAttempts = maxAttempts;
    this.pairing = null;
  }

  createPairingCode() {
    let raw = '';
    for (let i = 0; i < CODE_LENGTH; i++) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
    this.pairing = { code: raw, expiresAt: this.now() + this.codeTtlMs, attempts: 0 };
    this.emit('change');
    return this.pairingState();
  }

  _active() {
    if (this.pairing && this.now() > this.pairing.expiresAt) {
      this.pairing = null;
      this.emit('change');
    }
    return this.pairing;
  }

  // Lo que ve la interfaz: código con formato XXXX-XXXX y cuándo caduca
  pairingState() {
    const p = this._active();
    return p ? { code: `${p.code.slice(0, 4)}-${p.code.slice(4)}`, expiresAt: p.expiresAt } : null;
  }

  cancelPairing() {
    if (this.pairing) {
      this.pairing = null;
      this.emit('change');
    }
  }

  // reason: 'no_code' | 'invalid_code' | 'locked'
  async pair({ code, origin, browser = 'other', label = '' }) {
    const p = this._active();
    if (!p) return { ok: false, reason: 'no_code' };

    const given = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!safeEqual(given, p.code)) {
      p.attempts += 1;
      if (p.attempts >= this.maxAttempts) {
        this.pairing = null; // demasiados intentos: hay que generar otro código en la app
        this.emit('change');
        return { ok: false, reason: 'locked' };
      }
      return { ok: false, reason: 'invalid_code' };
    }

    this.pairing = null;
    const token = crypto.randomBytes(32).toString('base64url');
    const instance = {
      id: 'i_' + crypto.randomBytes(9).toString('base64url'),
      tokenHash: hashToken(token),
      origin,
      browser,
      label,
      profileId: null,
      pairedAt: this.now(),
    };
    this.registry.addInstance(instance);
    await this.registry.flush(); // el token debe estar guardado antes de entregarlo
    this.emit('change');
    return { ok: true, token, instance: publicInstance(instance) };
  }

  // Devuelve la instancia (con su origin) o null
  authenticate(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    return this.registry.findByTokenHash(hashToken(token));
  }

  revoke(instanceId) {
    const removed = this.registry.removeInstance(instanceId);
    if (removed) {
      this.registry.flush().catch(() => {});
      this.emit('revoked', instanceId);
      this.emit('change');
    }
    return removed;
  }
}

module.exports = { Auth, hashToken };
