/**
 * JBC · access.js
 * Capability-based access control.
 *
 * Token format:
 * {
 *   subject:    string  (did of grantee)
 *   capability: string  ('read' | 'write' | 'schema' | 'sync' | 'admin')
 *   issuer:     string  (did of granting authority)
 *   issuedAt:   string  (ISO timestamp)
 *   sig:        string  (ECDSA over token content, via JBCCrypto)
 * }
 *
 * Rules:
 *   - Access rights signed — no trust by UI flag
 *   - Admin cap required to grant/revoke caps
 */

'use strict';

const ACCESS_DOMAIN  = 'JBC:access';
const ACCESS_VERSION = '0.1';

const ALL_CAPS = ['read', 'write', 'schema', 'sync', 'admin'];

const CAP_HIERARCHY = {
  read:   0,
  write:  1,
  schema: 2,
  sync:   2,
  admin:  3,
};

class CapabilityToken {
  constructor({ subject, capability, issuer, issuedAt, sig }) {
    if (!subject)    throw new TypeError('CapabilityToken.subject required');
    if (!capability) throw new TypeError('CapabilityToken.capability required');
    if (!issuer)     throw new TypeError('CapabilityToken.issuer required');
    if (!ALL_CAPS.includes(capability))
      throw new TypeError(`Unknown capability: '${capability}'. Valid: ${ALL_CAPS.join(', ')}`);

    this.subject    = subject;
    this.capability = capability;
    this.issuer     = issuer;
    this.issuedAt   = issuedAt ?? new Date().toISOString();
    this.sig        = sig ?? null;
    Object.freeze(this);
  }

  toJSON() {
    return { subject: this.subject, capability: this.capability, issuer: this.issuer, issuedAt: this.issuedAt, sig: this.sig };
  }

  static fromJSON(obj) { return new CapabilityToken(obj); }
}

class AccessLayer {
  constructor() {
    // Map of subject (did) → Set<capability>
    this._grants = new Map();
    // Map of "${subject}:${capability}" → CapabilityToken (for audit)
    this._tokens = new Map();
  }

  // ── API ───────────────────────────────────────────────────────────────────

  /**
   * grant(issuerDid, issuerPrivateKey, subjectDid, capability, registry?)
   *   → Promise<CapabilityToken>
   *
   * Issuer must hold 'admin' capability (unless registry is null — bootstrap mode).
   * registry: IdentityRegistry (optional, for issuer verification)
   */
  async grant(issuerDid, issuerPrivateKey, subjectDid, capability, registry = null) {
    const crypto = _requireCrypto();

    if (!ALL_CAPS.includes(capability))
      throw new TypeError(`Unknown capability: '${capability}'`);

    // Enforce: issuer must hold admin (unless bootstrapping empty registry)
    if (this._grants.size > 0) {
      if (!this.hasCap(issuerDid, 'admin'))
        throw new Error(`Issuer ${issuerDid.slice(0,16)}... lacks 'admin' capability`);
    }

    const token = new CapabilityToken({
      subject:    subjectDid,
      capability,
      issuer:     issuerDid,
      issuedAt:   new Date().toISOString(),
    });

    const payloadHash = await crypto.sha256(token.toJSON());
    const sig         = await crypto.sign(issuerPrivateKey, ACCESS_DOMAIN, ACCESS_VERSION, payloadHash);
    const signed      = new CapabilityToken({ ...token, sig });

    this._setGrant(subjectDid, capability);
    this._tokens.set(`${subjectDid}:${capability}`, signed);

    return signed;
  }

  /**
   * revoke(issuerDid, subjectDid, capability) → bool
   * Revokes a capability. Issuer must hold 'admin'.
   */
  revoke(issuerDid, subjectDid, capability) {
    if (!this.hasCap(issuerDid, 'admin'))
      throw new Error(`Issuer ${issuerDid.slice(0,16)}... lacks 'admin' capability`);

    const key = `${subjectDid}:${capability}`;
    if (!this._tokens.has(key)) return false;

    this._grants.get(subjectDid)?.delete(capability);
    this._tokens.delete(key);
    return true;
  }

  /**
   * verifyCapability(token, issuerPubHex?) → Promise<{ ok, reason? }>
   * Verifies a CapabilityToken's signature.
   */
  async verifyCapability(token, issuerPubHex) {
    const crypto = _requireCrypto();
    const t      = token instanceof CapabilityToken ? token : CapabilityToken.fromJSON(token);

    if (!t.sig) return { ok: false, reason: 'token has no signature' };
    if (!issuerPubHex) return { ok: false, reason: 'issuerPubHex required for verification' };

    const payloadHash = await crypto.sha256({ subject: t.subject, capability: t.capability, issuer: t.issuer, issuedAt: t.issuedAt, sig: null });
    const valid       = await crypto.verify(issuerPubHex, ACCESS_DOMAIN, ACCESS_VERSION, payloadHash, t.sig);
    return valid ? { ok: true } : { ok: false, reason: 'token signature invalid' };
  }

  // ── Query ─────────────────────────────────────────────────────────────────

  hasCap(did, capability) {
    return this._grants.get(did)?.has(capability) ?? false;
  }

  caps(did) {
    return [...(this._grants.get(did) ?? new Set())];
  }

  token(did, capability) {
    return this._tokens.get(`${did}:${capability}`) ?? null;
  }

  allTokens() {
    return [...this._tokens.values()];
  }

  // ── Event-level capability check ──────────────────────────────────────────

  static get CAP_REQUIRED() {
    return Object.freeze({
      'state.set':         ['write'],
      'state.delete':      ['write'],
      'counter.increment': ['write'],
      'access.grant':      ['admin'],
      'access.revoke':     ['admin'],
    });
  }

  /**
   * canSubmit(did, eventType) → { ok, reason? }
   */
  canSubmit(did, eventType) {
    const required = AccessLayer.CAP_REQUIRED[eventType] ?? [];
    for (const cap of required) {
      if (!this.hasCap(did, cap))
        return { ok: false, reason: `DID ${did.slice(0,16)}... lacks capability '${cap}' for '${eventType}'` };
    }
    return { ok: true };
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON() {
    return { tokens: [...this._tokens.values()].map(t => t.toJSON()) };
  }

  static fromJSON(obj) {
    const al = new AccessLayer();
    for (const raw of (obj.tokens ?? [])) {
      const t = CapabilityToken.fromJSON(raw);
      al._setGrant(t.subject, t.capability);
      al._tokens.set(`${t.subject}:${t.capability}`, t);
    }
    return al;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _setGrant(did, capability) {
    if (!this._grants.has(did)) this._grants.set(did, new Set());
    this._grants.get(did).add(capability);
  }
}

function _requireCrypto() {
  const c = (typeof window !== 'undefined' && window.JBC?.crypto) ||
            (typeof module !== 'undefined' && (() => { try { return require('./crypto'); } catch { return null; } })());
  if (!c) throw new Error('JBC.crypto must be loaded before JBC.AccessLayer');
  return c;
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.CapabilityToken = CapabilityToken;
  window.JBC.AccessLayer     = AccessLayer;
  window.JBC.ALL_CAPS        = ALL_CAPS;
}
if (typeof module !== 'undefined') module.exports = { CapabilityToken, AccessLayer, ALL_CAPS };
