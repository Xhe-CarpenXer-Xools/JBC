/**
 * JBC · ledger.js
 * Append-only canonical ledger.
 *
 * Guarantees:
 *   - No direct state mutation. All state derives from ledger only.
 *   - Every event hash-chained to previous.
 *   - Deterministic replay: same events → same state every time.
 *
 * Event structure:
 * {
 *   id:      string  (sha256 of content)
 *   type:    string
 *   clock:   { counter, node }
 *   actor:   string  (did)
 *   payload: object
 *   prev:    string  (id of previous event, or "GENESIS")
 *   hash:    string  (sha256 of full event minus hash field)
 *   sig:     string  (ECDSA over domain+version+hash)
 *   version: "0.1"
 * }
 */

'use strict';

const PROTOCOL_VERSION = '0.1';
const PROTOCOL_DOMAIN  = 'JBC';
const GENESIS_PREV     = '0'.repeat(64);

class Ledger {
  constructor() {
    this._entries = [];  // ordered, append-only
    this._index   = new Map(); // id → entry
  }

  // ── Append ────────────────────────────────────────────────────────────────

  /**
   * append(rawEvent) → Promise<entry>
   * Validates hash chain before appending. Rejects tampered events.
   */
  async append(rawEvent) {
    const entry = rawEvent.version ? rawEvent : null;
    if (!entry) throw new TypeError('Event must have version field');

    const valid = await this._verifyChain(entry);
    if (!valid.ok) throw new Error(`Ledger chain violation: ${valid.reason}`);

    this._entries.push(entry);
    this._index.set(entry.id, entry);
    return entry;
  }

  /**
   * build(params) → Promise<entry>
   * Construct, hash, sign, and return a new entry ready for append().
   *
   * params: { type, clock, actor, payload, privateKey, pubHex }
   */
  static async build({ type, clock, actor, payload, privateKey, pubHex }) {
    const crypto = _requireCrypto();
    const prev   = '@@LEDGER_PREV@@'; // caller injects via Ledger.buildNext()
    throw new Error('Use Ledger.buildNext(ledger, params) instead');
  }

  /**
   * buildNext(ledger, params) → Promise<entry>
   * Builds next entry using the ledger's current head for chaining.
   */
  static async buildNext(ledger, { type, clock, actor, payload, privateKey, pubHex }) {
    const crypto = _requireCrypto();
    const prev   = ledger.head()?.id ?? GENESIS_PREV;

    // Content hash (excludes sig — sig covers hash, not content directly)
    const content = { actor, clock, payload, prev, type, version: PROTOCOL_VERSION };
    const hash    = await crypto.sha256(content);
    const id      = await crypto.sha256({ hash, prev });

    // Sign: domain + version + hash (never raw payload)
    const sig = privateKey
      ? await crypto.sign(privateKey, PROTOCOL_DOMAIN, PROTOCOL_VERSION, hash)
      : null;

    return { id, type, clock, actor, payload, prev, hash, sig, version: PROTOCOL_VERSION };
  }

  // ── Read ──────────────────────────────────────────────────────────────────

  /**
   * read(from?, to?) → entry[]
   * Returns slice of ledger. Omit args for full log.
   */
  read(from = 0, to = undefined) {
    return this._entries.slice(from, to);
  }

  /**
   * head() → entry | null
   */
  head() {
    return this._entries[this._entries.length - 1] ?? null;
  }

  /**
   * get(id) → entry | undefined
   */
  get(id) {
    return this._index.get(id);
  }

  /**
   * size() → number
   */
  size() {
    return this._entries.length;
  }

  // ── Verify ────────────────────────────────────────────────────────────────

  /**
   * verify(entry) → Promise<{ ok, reason? }>
   * Verifies hash integrity and (if pubHex present) signature.
   */
  async verify(entry, pubHex) {
    const crypto = _requireCrypto();

    // Recompute content hash
    const content  = { actor: entry.actor, clock: entry.clock, payload: entry.payload, prev: entry.prev, type: entry.type, version: entry.version };
    const expected = await crypto.sha256(content);
    if (expected !== entry.hash) {
      return { ok: false, reason: `hash mismatch: expected ${expected.slice(0,8)} got ${entry.hash?.slice(0,8)}` };
    }

    // Signature check (optional — skip if no pubHex)
    if (pubHex && entry.sig) {
      const valid = await crypto.verify(pubHex, PROTOCOL_DOMAIN, PROTOCOL_VERSION, entry.hash, entry.sig);
      if (!valid) return { ok: false, reason: 'signature invalid' };
    }

    return { ok: true };
  }

  // ── Replay ────────────────────────────────────────────────────────────────

  /**
   * replay(reducer, initialState?) → Promise<state>
   * Deterministic reducer engine.
   * reducer(state, event) → state
   *
   * Guarantees:
   *   - Identical output every run
   *   - Same ordering as original append sequence
   *   - Safe to call after crash recovery from persisted entries
   */
  async replay(reducer, initialState = null) {
    let state = initialState;
    for (const entry of this._entries) {
      state = await reducer(state, entry);
    }
    return state;
  }

  // ── Snapshot ──────────────────────────────────────────────────────────────

  /**
   * snapshot() → { size, head, headHash }
   */
  snapshot() {
    const h = this.head();
    return {
      size:     this._entries.length,
      head:     h?.id ?? null,
      headHash: h?.hash ?? GENESIS_PREV,
    };
  }

  // ── Serialization ─────────────────────────────────────────────────────────

  toJSON() {
    return { version: PROTOCOL_VERSION, entries: this._entries };
  }

  /**
   * Ledger.fromJSON(obj) → Ledger
   * Re-hydrate from stored JSON. Does NOT re-verify — caller should call
   * verifyAll() if loading from untrusted storage.
   */
  static fromJSON(obj) {
    const l = new Ledger();
    for (const e of (obj.entries ?? [])) {
      l._entries.push(e);
      l._index.set(e.id, e);
    }
    return l;
  }

  /**
   * verifyAll() → Promise<{ ok, failures: [] }>
   * Full integrity check of every entry's hash chain linkage.
   */
  async verifyAll() {
    const failures = [];
    let prevId = GENESIS_PREV;
    for (const entry of this._entries) {
      if (entry.prev !== prevId) {
        failures.push({ id: entry.id, reason: `broken chain: expected prev ${prevId.slice(0,8)} got ${entry.prev?.slice(0,8)}` });
      }
      const v = await this.verify(entry);
      if (!v.ok) failures.push({ id: entry.id, reason: v.reason });
      prevId = entry.id;
    }
    return { ok: failures.length === 0, failures };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _verifyChain(entry) {
    const crypto  = _requireCrypto();
    const prevId  = this.head()?.id ?? GENESIS_PREV;

    if (entry.prev !== prevId) {
      return { ok: false, reason: `prev mismatch: expected ${prevId.slice(0,8)} got ${entry.prev?.slice(0,8)}` };
    }

    // Verify hash integrity
    const content  = { actor: entry.actor, clock: entry.clock, payload: entry.payload, prev: entry.prev, type: entry.type, version: entry.version };
    const expected = await crypto.sha256(content);
    if (expected !== entry.hash) {
      return { ok: false, reason: `hash mismatch` };
    }

    return { ok: true };
  }
}

function _requireCrypto() {
  const c = (typeof window !== 'undefined' && window.JBC?.crypto) ||
            (typeof module !== 'undefined' && (() => { try { return require('./crypto'); } catch { return null; } })());
  if (!c) throw new Error('JBC.crypto must be loaded before JBC.Ledger');
  return c;
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.Ledger        = Ledger;
  window.JBC.GENESIS_PREV  = GENESIS_PREV;
}
if (typeof module !== 'undefined') module.exports = { Ledger, GENESIS_PREV };
