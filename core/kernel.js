/**
 * JBC · kernel.js
 * Deterministic reducer engine.
 *
 * State never primary. Log primary.
 * reduce(state, event) → state
 * replay(events) → state
 *
 * KernelState is immutable. Every state change produces a new state.
 */

'use strict';

// ── KernelState ───────────────────────────────────────────────────────────────

class KernelState {
  constructor({
    tick        = 0,
    entries     = new Map(),
    accepted    = new Set(),
    authorTicks = new Map(),
  } = {}) {
    this.tick        = tick;
    this.entries     = entries;
    this.accepted    = accepted;
    this.authorTicks = authorTicks;
    Object.freeze(this);
  }

  get(key)          { return this.entries.get(key)?.value ?? null; }
  has(key)          { return this.entries.has(key); }
  hasAccepted(id)   { return this.accepted.has(id); }
  authorTick(actor) { return this.authorTicks.get(actor) ?? -1; }
  size()            { return this.entries.size; }

  async hash() {
    const crypto = _requireCrypto();
    if (!this.entries.size) return '0'.repeat(64);
    const sorted = [...this.entries.entries()]
      .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => [k, { actor: v.actor, tick: v.tick, value: v.value }]);
    return crypto.sha256({ entries: sorted, tick: this.tick });
  }

  derive(delta, eventTick, eventActor, submissionId) {
    const entries     = new Map(this.entries);
    const accepted    = new Set(this.accepted);
    const authorTicks = new Map(this.authorTicks);
    for (const [key, record] of delta) {
      if (record === null) entries.delete(key);
      else entries.set(key, { value: structuredClone(record.value), tick: record.tick, actor: record.actor });
    }
    if (submissionId) accepted.add(submissionId);
    if (eventActor) authorTicks.set(eventActor, Math.max(this.authorTick(eventActor), eventTick));
    return new KernelState({
      tick:        Math.max(this.tick, eventTick),
      entries,
      accepted,
      authorTicks,
    });
  }

  static genesis() { return new KernelState(); }

  toJSON() {
    return {
      tick:    this.tick,
      entries: Object.fromEntries([...this.entries.entries()].map(([k,v]) => [k, v.value])),
      size:    this.entries.size,
    };
  }
}

// ── SovereignEvent (internal representation, produced from ledger entries) ────

class SovereignEvent {
  constructor({ type, actor, payload, tick, nonce }) {
    if (!type)                  throw new TypeError('Event.type required');
    if (!actor)                 throw new TypeError('Event.actor required');
    if (typeof tick !== 'number') throw new TypeError('Event.tick must be a number');
    if (!nonce)                 throw new TypeError('Event.nonce required');
    this.type    = type;
    this.actor   = actor;
    this.payload = Object.freeze(structuredClone(payload ?? {}));
    this.tick    = tick;
    this.nonce   = nonce;
    Object.freeze(this);
  }

  async id() {
    const crypto = _requireCrypto();
    return crypto.sha256({ actor: this.actor, nonce: this.nonce, payload: this.payload, tick: this.tick, type: this.type });
  }

  toJSON() {
    return { type: this.type, actor: this.actor, payload: this.payload, tick: this.tick, nonce: this.nonce };
  }

  static fromJSON(obj) { return new SovereignEvent(obj); }

  /** Build from a ledger entry */
  static fromLedgerEntry(entry) {
    return new SovereignEvent({
      type:    entry.type,
      actor:   entry.actor,
      payload: entry.payload,
      tick:    entry.clock?.counter ?? 0,
      nonce:   entry.id,
    });
  }
}

// ── Submission ────────────────────────────────────────────────────────────────

class Submission {
  constructor({ event, proof = null }) {
    this.event = event instanceof SovereignEvent ? event : SovereignEvent.fromJSON(event);
    this.proof = proof;
    Object.freeze(this);
  }

  async id() {
    const crypto = _requireCrypto();
    return crypto.sha256({ event_id: await this.event.id(), proof: this.proof });
  }

  toJSON() { return { event: this.event.toJSON(), proof: this.proof }; }
  static fromJSON(obj) { return new Submission({ event: SovereignEvent.fromJSON(obj.event), proof: obj.proof }); }
}

// ── Core predicates ───────────────────────────────────────────────────────────

const CORE_PREDICATES = [
  function tick_advances(event, state) {
    return event.tick > state.authorTick(event.actor);
  },
  function no_replay(event, state, _proof, subId) {
    return !state.hasAccepted(subId);
  },
];

// ── SovereignKernel ───────────────────────────────────────────────────────────

class SovereignKernel {
  constructor() {
    this._predicates = new Map();
    this._transforms = new Map();
    this._registerBuiltins();
  }

  predicate(type, fn) {
    const e = this._predicates.get(type) ?? [];
    this._predicates.set(type, [...e, fn]);
    return this;
  }

  transform(type, fn) {
    this._transforms.set(type, fn);
    return this;
  }

  // ── reduce(state, event) → Promise<{ state, accepted, reason? }> ───────────
  // This IS the reducer. Single event application.

  async reduce(state, event) {
    const ev  = event instanceof SovereignEvent ? event : SovereignEvent.fromJSON(event);
    const sub = new Submission({ event: ev });
    const sid = await sub.id();
    const res = await this._applyOne(state, sub, sid);
    return res;
  }

  // ── replay(ledgerEntries, initialState?) → Promise<state> ─────────────────
  // Deterministic rebuild from ledger. State never stored — always derived.

  async replay(ledgerEntries, initialState = null) {
    let state = initialState ?? KernelState.genesis();
    for (const entry of ledgerEntries) {
      const ev  = SovereignEvent.fromLedgerEntry(entry);
      const res = await this.reduce(state, ev);
      if (res.accepted) state = res.state;
    }
    return state;
  }

  // ── apply(state, submissions[]) → Promise<ApplyResult> ────────────────────
  // Batch apply with deduplication and stable ordering.

  async apply(state, submissions) {
    const seenIds = new Map();
    for (const s of submissions) {
      const id = await s.id();
      seenIds.set(id, s);
    }

    const unique = [...seenIds.entries()];
    unique.sort(([idA, sA], [idB, sB]) => {
      const dt = sA.event.tick - sB.event.tick;
      return dt !== 0 ? dt : (idA < idB ? -1 : 1);
    });

    let current = state;
    const log   = [];
    for (const [subId, sub] of unique) {
      const result = await this._applyOne(current, sub, subId);
      log.push({
        submission_id: subId,
        event_type:    sub.event.type,
        actor:         sub.event.actor,
        tick:          sub.event.tick,
        accepted:      result.accepted,
        reason:        result.reason ?? null,
      });
      if (result.accepted) current = result.state;
    }

    const crypto = _requireCrypto();
    return {
      state:     current,
      log,
      accepted:  log.filter(e => e.accepted).length,
      rejected:  log.filter(e => !e.accepted).length,
      baseHash:  await state.hash(),
      finalHash: await current.hash(),
    };
  }

  // ── buildEvent static helper ───────────────────────────────────────────────

  static async buildEvent(type, actor, payload, tick) {
    const crypto = _requireCrypto();
    const nonce  = crypto.randomBytes(16);
    return new SovereignEvent({ type, actor, payload, tick, nonce });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _applyOne(state, sub, subId) {
    const { event } = sub;

    for (const pred of CORE_PREDICATES) {
      let r;
      try { r = pred(event, state, sub.proof, subId); }
      catch (e) { return { accepted: false, reason: `predicate '${pred.name}' threw: ${e.message}` }; }
      if (!r) return { accepted: false, reason: `predicate '${pred.name}' failed` };
    }

    const extras = this._predicates.get(event.type) ?? [];
    for (const pred of extras) {
      let r;
      try { r = pred(event, state, sub.proof, subId); }
      catch (e) { return { accepted: false, reason: `extra predicate threw: ${e.message}` }; }
      if (!r) return { accepted: false, reason: `extra predicate failed for ${event.type}` };
    }

    const transform = this._transforms.get(event.type);
    if (!transform) return { accepted: false, reason: `no transform for event type: '${event.type}'` };

    let delta;
    try { delta = transform(state, event); }
    catch (e) { return { accepted: false, reason: `transform threw: ${e.message}` }; }

    return { accepted: true, state: state.derive(delta, event.tick, event.actor, subId) };
  }

  _registerBuiltins() {
    // state.set — LWW: higher tick wins; same tick → higher actor string
    this._transforms.set('state.set', (_s, ev) => new Map([
      [ev.payload.key, { value: ev.payload.value ?? null, tick: ev.tick, actor: ev.actor }],
    ]));
    this.predicate('state.set', (ev, state) => {
      const ex = state.entries.get(ev.payload.key);
      if (!ex) return true;
      if (ev.tick > ex.tick) return true;
      if (ev.tick === ex.tick && ev.actor > ex.actor) return true;
      return false;
    });

    // state.delete
    this._transforms.set('state.delete', (_s, ev) => new Map([[ev.payload.key, null]]));
    this.predicate('state.delete', (ev, state) => state.has(ev.payload.key));

    // counter.increment (deterministic LWW, not CRDT-sum)
    this._transforms.set('counter.increment', (state, ev) => {
      const prev = state.get(ev.payload.key) ?? 0;
      return new Map([[ev.payload.key, { value: prev + (ev.payload.amount ?? 1), tick: ev.tick, actor: ev.actor }]]);
    });
    this.predicate('counter.increment', () => true);

    // access.grant / access.revoke
    this._transforms.set('access.grant', (_s, ev) => new Map([
      [`_access:${ev.payload.did}:${ev.payload.cap}`, { value: true, tick: ev.tick, actor: ev.actor }],
    ]));
    this.predicate('access.grant', () => true);

    this._transforms.set('access.revoke', (_s, ev) => new Map([
      [`_access:${ev.payload.did}:${ev.payload.cap}`, { value: false, tick: ev.tick, actor: ev.actor }],
    ]));
    this.predicate('access.revoke', () => true);
  }
}

// ── Bundle (for sync) ─────────────────────────────────────────────────────────

class Bundle {
  constructor(submissions = []) {
    this._submissions = submissions.map(s => s instanceof Submission ? s : Submission.fromJSON(s));
    this.size = submissions.length;
    Object.freeze(this);
  }

  async finalize() {
    const seen = new Map();
    for (const sub of this._submissions) {
      const id = await sub.id();
      seen.set(id, sub);
    }
    const entries = [...seen.entries()];
    entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    return entries.map(([, sub]) => sub);
  }

  merge(other) { return new Bundle([...this._submissions, ...other._submissions]); }
  add(sub)     { return new Bundle([...this._submissions, sub]); }

  toJSON()           { return { submissions: this._submissions.map(s => s.toJSON()) }; }
  static fromJSON(o) { return new Bundle(o.submissions.map(s => Submission.fromJSON(s))); }
}

function _requireCrypto() {
  const c = (typeof window !== 'undefined' && window.JBC?.crypto) ||
            (typeof module !== 'undefined' && (() => { try { return require('./crypto'); } catch { return null; } })());
  if (!c) throw new Error('JBC.crypto must be loaded before JBC.SovereignKernel');
  return c;
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  Object.assign(window.JBC, { KernelState, SovereignEvent, Submission, Bundle, SovereignKernel });
}
if (typeof module !== 'undefined') module.exports = { KernelState, SovereignEvent, Submission, Bundle, SovereignKernel };
