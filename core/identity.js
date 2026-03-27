/**
 * JBC · identity.js
 * Formal identity registry.
 *
 * Identity structure:
 * {
 *   did:     string  (did:key:z<pubHex slice>)
 *   pubkey:  string  (hex-encoded SPKI public key)
 *   created: string  (ISO timestamp)
 *   proof:   string  (self-signature: sign(privKey, "JBC", "0.1", sha256({did,pubkey,created})))
 *   revoked: bool
 * }
 *
 * Signing rule: always sign domain + version + payload_hash (via JBCCrypto.sign)
 */

'use strict';

const ID_DOMAIN  = 'JBC:identity';
const ID_VERSION = '0.1';

class Identity {
  constructor({ did, pubkey, created, proof, revoked = false }) {
    if (!did)    throw new TypeError('Identity.did required');
    if (!pubkey) throw new TypeError('Identity.pubkey required');
    this.did     = did;
    this.pubkey  = pubkey;
    this.created = created ?? new Date().toISOString();
    this.proof   = proof   ?? null;
    this.revoked = revoked;
    Object.freeze(this);
  }

  toJSON() {
    return { did: this.did, pubkey: this.pubkey, created: this.created, proof: this.proof, revoked: this.revoked };
  }

  static fromJSON(obj) {
    return new Identity(obj);
  }
}

class IdentityRegistry {
  constructor() {
    this._store = new Map(); // did → Identity
  }

  // ── API ───────────────────────────────────────────────────────────────────

  /**
   * createIdentity() → Promise<{ identity: Identity, keyPair }>
   * Generates a new ECDSA P-256 keypair and self-signed identity.
   */
  async createIdentity() {
    const crypto  = _requireCrypto();
    const keyPair = await crypto.generateKeyPair();

    const did     = keyPair.did;
    const pubkey  = keyPair.pubHex;
    const created = new Date().toISOString();

    // Self-proof: sign hash of { did, pubkey, created }
    const payloadHash = await crypto.sha256({ created, did, pubkey });
    const proof       = await crypto.sign(keyPair.privateKey, ID_DOMAIN, ID_VERSION, payloadHash);

    const identity = new Identity({ did, pubkey, created, proof, revoked: false });
    this._store.set(did, identity);
    return { identity, keyPair };
  }

  /**
   * registerIdentity(identity) → Promise<Identity>
   * Registers an externally-provided identity after verifying its proof.
   */
  async registerIdentity(identity) {
    const id = identity instanceof Identity ? identity : Identity.fromJSON(identity);
    const v  = await this.verifyIdentity(id);
    if (!v.ok) throw new Error(`Invalid identity proof: ${v.reason}`);
    this._store.set(id.did, id);
    return id;
  }

  /**
   * verifyIdentity(identity) → Promise<{ ok, reason? }>
   * Verifies the self-signature proof.
   */
  async verifyIdentity(identity) {
    const crypto = _requireCrypto();
    const id     = identity instanceof Identity ? identity : Identity.fromJSON(identity);

    if (id.revoked) return { ok: false, reason: 'identity revoked' };
    if (!id.proof)  return { ok: false, reason: 'no proof present' };

    const payloadHash = await crypto.sha256({ created: id.created, did: id.did, pubkey: id.pubkey });
    const valid       = await crypto.verify(id.pubkey, ID_DOMAIN, ID_VERSION, payloadHash, id.proof);
    return valid ? { ok: true } : { ok: false, reason: 'proof signature invalid' };
  }

  /**
   * revokeIdentity(did, privateKey) → Promise<Identity>
   * Marks identity as revoked. Requires the private key to produce a revocation proof.
   */
  async revokeIdentity(did, privateKey) {
    const crypto = _requireCrypto();
    const id     = this._store.get(did);
    if (!id) throw new Error(`Unknown identity: ${did}`);

    const revokedAt   = new Date().toISOString();
    const payloadHash = await crypto.sha256({ action: 'revoke', did, revokedAt });
    const revProof    = await crypto.sign(privateKey, `${ID_DOMAIN}:revoke`, ID_VERSION, payloadHash);

    const revoked = new Identity({ ...id, revoked: true, proof: revProof });
    this._store.set(did, revoked);
    return revoked;
  }

  /**
   * sign(privateKey, payload) → Promise<{ payloadHash, sig }>
   * Sign arbitrary payload on behalf of an identity.
   * Always: domain + version + sha256(payload)
   */
  async sign(privateKey, payload, domain = 'JBC:event') {
    const crypto      = _requireCrypto();
    const payloadHash = await crypto.sha256(payload);
    const sig         = await crypto.sign(privateKey, domain, ID_VERSION, payloadHash);
    return { payloadHash, sig };
  }

  /**
   * verify(did, payload, sig, domain?) → Promise<{ ok, reason? }>
   * Verify a payload signature against a registered DID.
   */
  async verify(did, payload, sig, domain = 'JBC:event') {
    const crypto   = _requireCrypto();
    const identity = this._store.get(did);
    if (!identity)         return { ok: false, reason: `unknown DID: ${did}` };
    if (identity.revoked)  return { ok: false, reason: 'identity revoked' };

    const payloadHash = await crypto.sha256(payload);
    const valid       = await crypto.verify(identity.pubkey, domain, ID_VERSION, payloadHash, sig);
    return valid ? { ok: true } : { ok: false, reason: 'signature invalid' };
  }

  // ── Registry access ───────────────────────────────────────────────────────

  get(did)      { return this._store.get(did) ?? null; }
  has(did)      { return this._store.has(did); }
  all()         { return [...this._store.values()]; }
  size()        { return this._store.size; }

  toJSON()      { return { identities: [...this._store.values()].map(i => i.toJSON()) }; }

  static fromJSON(obj) {
    const reg = new IdentityRegistry();
    for (const raw of (obj.identities ?? [])) {
      const id = Identity.fromJSON(raw);
      reg._store.set(id.did, id);
    }
    return reg;
  }
}

function _requireCrypto() {
  const c = (typeof window !== 'undefined' && window.JBC?.crypto) ||
            (typeof module !== 'undefined' && (() => { try { return require('./crypto'); } catch { return null; } })());
  if (!c) throw new Error('JBC.crypto must be loaded before JBC.IdentityRegistry');
  return c;
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.Identity         = Identity;
  window.JBC.IdentityRegistry = IdentityRegistry;
}
if (typeof module !== 'undefined') module.exports = { Identity, IdentityRegistry };
