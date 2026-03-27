/**
 * JBC · transport.js
 * Real envelope transport.
 *
 * Envelope format:
 * {
 *   id:       string
 *   sender:   string  (did)
 *   clock:    { counter, node }
 *   body:     object
 *   hash:     string  (sha256 of content)
 *   sig:      string  (ECDSA over domain+version+hash)
 *   protocol: "JBC"
 *   version:  "0.1"
 * }
 *
 * Rules:
 *   - verify before accept
 *   - reject unsigned
 *   - reject stale clock
 *
 * Backends: BroadcastChannel, IndexedDB queue, WebRTC adapter
 */

'use strict';

const TRANSPORT_DOMAIN  = 'JBC:transport';
const TRANSPORT_VERSION = '0.1';
const PROTOCOL          = 'JBC';

// ── Envelope ──────────────────────────────────────────────────────────────────

class Envelope {
  constructor({ id, sender, clock, body, hash, sig, protocol, version }) {
    if (!id)     throw new TypeError('Envelope.id required');
    if (!sender) throw new TypeError('Envelope.sender required');
    if (!clock)  throw new TypeError('Envelope.clock required');
    if (!body)   throw new TypeError('Envelope.body required');

    this.id       = id;
    this.sender   = sender;
    this.clock    = clock;
    this.body     = body;
    this.hash     = hash   ?? null;
    this.sig      = sig    ?? null;
    this.protocol = protocol ?? PROTOCOL;
    this.version  = version  ?? TRANSPORT_VERSION;
    Object.freeze(this);
  }

  toJSON() {
    return { id: this.id, sender: this.sender, clock: this.clock, body: this.body, hash: this.hash, sig: this.sig, protocol: this.protocol, version: this.version };
  }

  static fromJSON(obj) { return new Envelope(obj); }
}

// ── Transport ─────────────────────────────────────────────────────────────────

class Transport {
  constructor({ nodeId, clock, storage = null }) {
    if (!nodeId) throw new TypeError('Transport requires nodeId');
    if (!clock)  throw new TypeError('Transport requires a LogicalClock');
    this._nodeId   = nodeId;
    this._clock    = clock;
    this._storage  = storage;
    this._handlers = new Map();  // type → Set<fn>
    this._channel  = null;
    this._rtc      = new Map();  // peerId → RTCDataChannel
    this._queue    = [];         // in-memory fallback queue
    this._seenIds  = new Set();  // replay prevention
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * initBroadcastChannel(name?) → Transport
   * Opens a BroadcastChannel backend. Best for same-origin tabs.
   */
  initBroadcastChannel(name = 'sovereign:v1') {
    try {
      this._channel = new BroadcastChannel(name);
      this._channel.onmessage = (e) => {
        const raw = e.data;
        if (raw?.sender !== this._nodeId) {
          this.receive(raw).catch(() => {});
        }
      };
    } catch (err) {
      console.warn('BroadcastChannel unavailable:', err.message);
    }
    return this;
  }

  /**
   * addRTCChannel(peerId, dataChannel) → Transport
   * Register a WebRTC DataChannel for a peer.
   */
  addRTCChannel(peerId, dataChannel) {
    this._rtc.set(peerId, dataChannel);
    dataChannel.onmessage = (e) => {
      try {
        const raw = JSON.parse(e.data);
        this.receive(raw).catch(() => {});
      } catch { /* ignore malformed */ }
    };
    return this;
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  /**
   * send(body, privateKey, pubHex?, peerId?) → Promise<Envelope>
   * Build, sign, and dispatch an envelope.
   * peerId: if set, sends via RTCDataChannel; else BroadcastChannel.
   */
  async send(body, privateKey, pubHex, peerId = null) {
    const crypto   = _requireCrypto();
    const clock    = this._clock.tick();
    const id       = crypto.randomBytes(16);

    const content  = { body, clock, sender: this._nodeId, protocol: PROTOCOL, version: TRANSPORT_VERSION };
    const hash     = await crypto.sha256(content);
    const sig      = privateKey
      ? await crypto.sign(privateKey, TRANSPORT_DOMAIN, TRANSPORT_VERSION, hash)
      : null;

    const envelope = new Envelope({ id, sender: this._nodeId, clock, body, hash, sig, protocol: PROTOCOL, version: TRANSPORT_VERSION });

    await this._dispatch(envelope, peerId);
    await this._enqueue(envelope);

    return envelope;
  }

  /**
   * receive(raw) → Promise<{ ok, envelope?, reason? }>
   * Validate incoming envelope. Reject unsigned, reject stale, reject replays.
   */
  async receive(raw) {
    let envelope;
    try {
      envelope = raw instanceof Envelope ? raw : Envelope.fromJSON(raw);
    } catch (e) {
      return { ok: false, reason: `malformed envelope: ${e.message}` };
    }

    // Reject unsigned envelopes
    if (!envelope.sig) {
      return { ok: false, reason: 'unsigned envelope rejected' };
    }

    // Reject replays
    if (this._seenIds.has(envelope.id)) {
      return { ok: false, reason: 'replay detected' };
    }

    // Verify hash integrity
    const verifyResult = await this.verifyEnvelope(envelope);
    if (!verifyResult.ok) return verifyResult;

    // Reject stale clock
    const remoteClock = envelope.clock;
    const localClock  = this._clock.current();
    if (remoteClock.counter !== undefined && remoteClock.counter < localClock.counter - 1000) {
      return { ok: false, reason: `stale clock: remote ${remoteClock.counter} vs local ${localClock.counter}` };
    }

    // Accept: advance local clock
    this._clock.merge(remoteClock);
    this._seenIds.add(envelope.id);
    if (this._seenIds.size > 10000) {
      // Prune oldest entries to prevent unbounded growth
      const iter = this._seenIds.values();
      for (let i = 0; i < 1000; i++) this._seenIds.delete(iter.next().value);
    }

    // Dispatch to handlers
    const type = envelope.body?.type ?? 'unknown';
    this._emit(type, envelope);
    this._emit('*', envelope);

    return { ok: true, envelope };
  }

  /**
   * verifyEnvelope(envelope, senderPubHex?) → Promise<{ ok, reason? }>
   * Verifies hash + optional signature.
   * If senderPubHex is omitted, only hash integrity is checked.
   */
  async verifyEnvelope(envelope, senderPubHex = null) {
    const crypto  = _requireCrypto();
    const content = { body: envelope.body, clock: envelope.clock, sender: envelope.sender, protocol: envelope.protocol, version: envelope.version };
    const expected = await crypto.sha256(content);

    if (expected !== envelope.hash) {
      return { ok: false, reason: `hash mismatch: expected ${expected.slice(0,8)} got ${envelope.hash?.slice(0,8)}` };
    }

    if (senderPubHex && envelope.sig) {
      const valid = await crypto.verify(senderPubHex, TRANSPORT_DOMAIN, TRANSPORT_VERSION, envelope.hash, envelope.sig);
      if (!valid) return { ok: false, reason: 'envelope signature invalid' };
    }

    return { ok: true };
  }

  /**
   * ack(envelopeId) → Promise<void>
   * Acknowledge receipt — removes from persistent queue.
   */
  async ack(envelopeId) {
    this._queue = this._queue.filter(e => e.id !== envelopeId);
    await this._storage?.dequeue(envelopeId);
  }

  /**
   * queue() → Envelope[]
   * Returns current in-memory outbound queue.
   */
  queue() {
    return [...this._queue];
  }

  // ── Event handlers ────────────────────────────────────────────────────────

  /**
   * on(type, handler) → Transport
   * type: body.type string, or '*' for all
   */
  on(type, handler) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(handler);
    return this;
  }

  off(type, handler) {
    this._handlers.get(type)?.delete(handler);
    return this;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _emit(type, envelope) {
    const handlers = this._handlers.get(type) ?? new Set();
    for (const fn of handlers) {
      try { fn(envelope); } catch { /* isolate handler errors */ }
    }
  }

  async _dispatch(envelope, peerId) {
    const json = JSON.stringify(envelope.toJSON());

    if (peerId && this._rtc.has(peerId)) {
      const ch = this._rtc.get(peerId);
      if (ch.readyState === 'open') {
        ch.send(json);
        return;
      }
    }

    // Fallback: BroadcastChannel
    try { this._channel?.postMessage(envelope.toJSON()); } catch { /* ignore */ }
  }

  async _enqueue(envelope) {
    this._queue.push(envelope);
    if (this._queue.length > 1000) this._queue.shift(); // cap in-memory queue
    await this._storage?.enqueue(envelope.toJSON());
  }
}

function _requireCrypto() {
  const c = (typeof window !== 'undefined' && window.JBC?.crypto) ||
            (typeof module !== 'undefined' && (() => { try { return require('./crypto'); } catch { return null; } })());
  if (!c) throw new Error('JBC.crypto must be loaded before JBC.Transport');
  return c;
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.Envelope  = Envelope;
  window.JBC.Transport = Transport;
}
if (typeof module !== 'undefined') module.exports = { Envelope, Transport };
