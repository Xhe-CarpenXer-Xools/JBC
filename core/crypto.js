/**
 * JBC · crypto.js
 * Single implementation. All modules consume this API. No duplicates.
 *
 * Rules:
 *   - Always sign: domain + version + payload_hash (never raw payload)
 *   - One canonical JSON encoding for all hashing
 */

'use strict';

const _enc = new TextEncoder();
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN  = { name: 'ECDSA', hash: 'SHA-256' };

// ── Encoding ──────────────────────────────────────────────────────────────────

function buf2hex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function hex2buf(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.slice(i*2, i*2+2), 16);
  return b.buffer;
}

// ── Canonical JSON (deterministic, sorted keys) ───────────────────────────────

function canonicalEncode(v) {
  if (v === null)      return 'null';
  if (v === undefined) throw new TypeError('undefined is not canonicalizable');
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new RangeError(`non-finite: ${v}`);
    return String(v);
  }
  if (typeof v === 'string') return JSON.stringify(v);
  if (v instanceof Uint8Array || ArrayBuffer.isView(v)) {
    const hex = buf2hex(v.buffer ?? v);
    return `<bytes:${hex}>`;
  }
  if (Array.isArray(v)) return `[${v.map(canonicalEncode).join(',')}]`;
  if (typeof v === 'object') {
    const pairs = Object.keys(v).sort()
      .map(k => `${JSON.stringify(k)}:${canonicalEncode(v[k])}`);
    return `{${pairs.join(',')}}`;
  }
  throw new TypeError(`not canonicalizable: ${typeof v}`);
}

// ── Core API ──────────────────────────────────────────────────────────────────

/**
 * randomBytes(n) → hex string
 */
function randomBytes(n) {
  return buf2hex(crypto.getRandomValues(new Uint8Array(n)));
}

/**
 * sha256(value) → Promise<hex string>
 * value: any canonicalizable object or string
 */
async function sha256(value) {
  const encoded = typeof value === 'string' ? value : canonicalEncode(value);
  const buf = await crypto.subtle.digest('SHA-256', _enc.encode(encoded));
  return buf2hex(buf);
}

/**
 * generateKeyPair() → Promise<{ publicKey, privateKey, pubHex, privHex, did }>
 */
async function generateKeyPair() {
  const kp     = await crypto.subtle.generateKey(ECDSA, true, ['sign', 'verify']);
  const pubRaw = await crypto.subtle.exportKey('spki',  kp.publicKey);
  const prvRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  const pubHex = buf2hex(pubRaw);
  return {
    publicKey:  kp.publicKey,
    privateKey: kp.privateKey,
    pubHex,
    privHex: buf2hex(prvRaw),
    did: `did:key:z${pubHex.slice(-64)}`,
  };
}

/**
 * exportKey({ publicKey, privateKey }) → Promise<{ pubHex, privHex }>
 */
async function exportKey(kp) {
  const pubRaw = await crypto.subtle.exportKey('spki',  kp.publicKey);
  const prvRaw = await crypto.subtle.exportKey('pkcs8', kp.privateKey);
  return { pubHex: buf2hex(pubRaw), privHex: buf2hex(prvRaw) };
}

/**
 * importKey({ pubHex?, privHex? }) → Promise<{ publicKey?, privateKey? }>
 */
async function importKey({ pubHex, privHex } = {}) {
  const result = {};
  if (pubHex) {
    result.publicKey = await crypto.subtle.importKey(
      'spki', hex2buf(pubHex), ECDSA, true, ['verify']);
  }
  if (privHex) {
    result.privateKey = await crypto.subtle.importKey(
      'pkcs8', hex2buf(privHex), ECDSA, true, ['sign']);
  }
  return result;
}

/**
 * deriveKey(domain, version, payloadHash) → canonical signing input string
 * Always sign this string, never the raw payload.
 */
function deriveKey(domain, version, payloadHash) {
  return canonicalEncode({ domain, payloadHash, version });
}

/**
 * sign(privateKey, domain, version, payloadHash) → Promise<hex sigHex>
 */
async function sign(privateKey, domain, version, payloadHash) {
  const msg = _enc.encode(deriveKey(domain, version, payloadHash));
  const buf = await crypto.subtle.sign(SIGN, privateKey, msg);
  return buf2hex(buf);
}

/**
 * verify(pubHex, domain, version, payloadHash, sigHex) → Promise<bool>
 */
async function verify(pubHex, domain, version, payloadHash, sigHex) {
  try {
    const { publicKey } = await importKey({ pubHex });
    const msg = _enc.encode(deriveKey(domain, version, payloadHash));
    return await crypto.subtle.verify(SIGN, publicKey, hex2buf(sigHex), msg);
  } catch {
    return false;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

const JBCCrypto = Object.freeze({
  randomBytes,
  sha256,
  generateKeyPair,
  exportKey,
  importKey,
  deriveKey,
  sign,
  verify,
  canonicalEncode,
  buf2hex,
  hex2buf,
});

// Browser module export
if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.crypto = JBCCrypto;
}

// Node.js / ES module export
if (typeof module !== 'undefined') module.exports = JBCCrypto;
