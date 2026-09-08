import { APP_NAME } from './branding.js';
// Crypto helpers. Everything here runs on the WebCrypto API available in Workers.
const te = new TextEncoder();
const td = new TextDecoder();

export function b64encode(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function b64decode(str) {
  const bin = atob(String(str).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64url(bytes) {
  return b64encode(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(n) {
  const a = new Uint8Array(n);
  crypto.getRandomValues(a);
  return a;
}

export function randomToken(n = 32) {
  return b64url(randomBytes(n));
}

export function newId(prefix) {
  return (prefix ? prefix + '_' : '') + b64url(randomBytes(12));
}

export async function sha256hex(input) {
  const data = typeof input === 'string' ? te.encode(input) : input;
  const h = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function hmacSha256(secret, msg) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, te.encode(msg)));
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/* --------------------------------------------------------------------------
 * Password verification.
 *
 * Workers bill CPU time per request, so a 600k-iteration PBKDF2 cannot run
 * server side. The browser runs the slow KDF instead and the Worker applies a
 * fast peppered HMAC on top:
 *
 *   clientHash = base64( PBKDF2-SHA256(password, pw_salt, 600000, 32) )   [browser]
 *   pw_hash    = base64( HMAC-SHA256(PW_PEPPER, "algo:salt:clientHash") ) [worker]
 *
 * A database leak on its own is therefore useless: an attacker still has to
 * brute force 600k-iteration PBKDF2 *and* guess PW_PEPPER, which exists only
 * as a Worker secret and is never written to D1.
 * ------------------------------------------------------------------------ */
export const PW_ALGO = 'pbkdf2c-v1';
export const PW_ITER = 600000;

export async function wrapClientHash(pepper, salt, clientHash) {
  return b64encode(await hmacSha256(pepper, PW_ALGO + ':' + salt + ':' + clientHash));
}

// Stable decoy salt so /auth/prelogin cannot be used to enumerate accounts.
export async function decoySalt(pepper, email) {
  return b64url(await hmacSha256(pepper, 'decoy-salt:' + String(email).trim().toLowerCase())).slice(0, 22);
}

/* ---------------------------- AES-256-GCM box --------------------------- */
async function aesKey(masterB64) {
  const raw = b64decode(masterB64);
  if (raw.length !== 32) throw new Error('MASTER_KEY must be 32 random bytes, base64 encoded');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(masterB64, plaintext) {
  const key = await aesKey(masterB64);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, te.encode(plaintext)));
  return 'v1.' + b64encode(iv) + '.' + b64encode(ct);
}

export async function unseal(masterB64, blob) {
  if (!blob) return null;
  const parts = String(blob).split('.');
  if (parts[0] !== 'v1' || parts.length !== 3) throw new Error('malformed sealed value');
  const key = await aesKey(masterB64);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64decode(parts[1]) }, key, b64decode(parts[2]));
  return td.decode(pt);
}

/* ------------------------------ TOTP (RFC 6238) ------------------------- */
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export function newTotpSecret(bytes = 20) {
  return base32Encode(randomBytes(bytes));
}

async function hotp(secretBytes, counter) {
  const buf = new ArrayBuffer(8);
  const dv = new DataView(buf);
  dv.setUint32(0, Math.floor(counter / 4294967296));
  dv.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, buf));
  const off = sig[sig.length - 1] & 0x0f;
  const code =
    (((sig[off] & 0x7f) << 24) | ((sig[off + 1] & 0xff) << 16) | ((sig[off + 2] & 0xff) << 8) | (sig[off + 3] & 0xff)) %
    1000000;
  return String(code).padStart(6, '0');
}

// Accepts the current step plus one step of drift either way (+/- 30s).
export async function totpVerify(secretB32, code, window = 1, step = 30) {
  const digits = String(code || '').replace(/\D/g, '');
  if (digits.length !== 6) return false;
  const secret = base32Decode(secretB32);
  const counter = Math.floor(Date.now() / 1000 / step);
  for (let d = -window; d <= window; d++) {
    if (timingSafeEqual(await hotp(secret, counter + d), digits)) return true;
  }
  return false;
}

export function totpUri(secretB32, email, issuer = APP_NAME) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(email);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
  return 'otpauth://totp/' + label + '?' + q.toString();
}

/* --------------------------- recovery codes ----------------------------- */
export function newRecoveryCodes(n = 8) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < n; i++) {
    const raw = randomBytes(10);
    let s = '';
    for (const b of raw) s += alphabet[b % alphabet.length];
    codes.push(s.slice(0, 5) + '-' + s.slice(5, 10));
  }
  return codes;
}

export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function hashRecoveryCode(pepper, code) {
  return b64encode(await hmacSha256(pepper, 'recovery:' + normalizeRecoveryCode(code)));
}
