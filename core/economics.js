/**
 * JBC · economics.js
 * Spam prevention, rate limiting, and stake-based security.
 *
 * Three-layer defence:
 *
 *   1. Rate limiter  — token-bucket per actor. No stake required.
 *      Cheap ops get tokens fast; expensive ops drain quickly.
 *
 *   2. Stake registry — actors bond tokens (conceptual units).
 *      Staked actors earn higher rate allowances.
 *      Unstaked actors are write-rate limited to 1 event / 5 s.
 *
 *   3. Slashing — proven misbehaviour (fork equivocation or invalid sig)
 *      burns a fraction of stake and can suspend the actor.
 *
 * Integration: wrap kernel.reduce() with economics.gate() before accepting.
 *
 * Misbehaviour evidence types:
 *   'equivocation' — two signed entries with same (actor, tick) but different hash
 *   'invalid_sig'  — transport or ledger signature failed
 *   'spam'         — exceeded rate limit repeatedly
 */

'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const DEFAULT_BUCKET_SIZE     = 20;    // max burst tokens
const DEFAULT_REFILL_RATE     = 4;     // tokens / second
const STAKED_BUCKET_SIZE      = 100;
const STAKED_REFILL_RATE      = 20;
const UNSTAKED_WRITE_INTERVAL = 5000;  // ms between writes for unstaked actors
const SLASH_FRACTION_EQUIVOC  = 0.25;  // 25% stake slashed for equivocation
const SLASH_FRACTION_SIG      = 0.10;  // 10% for invalid sig
const SLASH_FRACTION_SPAM     = 0.05;  // 5% for repeated spam
const SUSPEND_THRESHOLD       = 0.10;  // suspend if stake drops below 10% of initial bond
const MIN_STAKE_TO_WRITE      = 0;     // 0 = no minimum, unstaked actors just get throttled

// ── TokenBucket ───────────────────────────────────────────────────────────────

class TokenBucket {
  /**
   * @param {number} capacity   - max tokens
   * @param {number} refillRate - tokens added per second
   */
  constructor(capacity, refillRate) {
    this._capacity   = capacity;
    this._refillRate = refillRate;     // tokens / ms = refillRate / 1000
    this._tokens     = capacity;
    this._lastRefill = Date.now();
  }

  /**
   * consume(cost?) → boolean
   * Returns true if tokens available and deducts cost.
   */
  consume(cost = 1) {
    this._refill();
    if (this._tokens < cost) return false;
    this._tokens -= cost;
    return true;
  }

  /**
   * available() → number
   */
  available() {
    this._refill();
    return this._tokens;
  }

  _refill() {
    const now     = Date.now();
    const elapsed = now - this._lastRefill;
    const added   = (elapsed / 1000) * this._refillRate;
    this._tokens  = Math.min(this._capacity, this._tokens + added);
    this._lastRefill = now;
  }

  toJSON() {
    return { capacity: this._capacity, tokens: Math.floor(this._tokens), refillRate: this._refillRate };
  }
}

// ── StakeRecord ───────────────────────────────────────────────────────────────

class StakeRecord {
  constructor({ did, bond, stakedAt }) {
    this.did      = did;
    this.bond     = bond;        // initial bond amount
    this.balance  = bond;        // current balance after slashing
    this.stakedAt = stakedAt ?? new Date().toISOString();
    this.slashes  = [];          // [{ reason, amount, at }]
    this.suspended = false;
  }

  slash(fraction, reason) {
    const amount   = Math.ceil(this.balance * fraction);
    this.balance   = Math.max(0, this.balance - amount);
    this.slashes.push({ reason, amount, at: new Date().toISOString() });
    if (this.balance <= Math.ceil(this.bond * SUSPEND_THRESHOLD)) {
      this.suspended = true;
    }
    return { slashed: amount, remaining: this.balance, suspended: this.suspended };
  }

  toJSON() {
    return {
      did: this.did, bond: this.bond, balance: this.balance,
      stakedAt: this.stakedAt, slashes: this.slashes, suspended: this.suspended,
    };
  }
}

// ── EconomicsEngine ───────────────────────────────────────────────────────────

class EconomicsEngine {
  constructor() {
    this._stakes      = new Map(); // did → StakeRecord
    this._buckets     = new Map(); // did → TokenBucket
    this._lastWrite   = new Map(); // did → timestamp (for unstaked throttle)
    this._equivEvid   = new Map(); // `${actor}:${tick}` → first seen hash (equivocation detection)
    this._violations  = new Map(); // did → violation count
  }

  // ── Stake management ───────────────────────────────────────────────────────

  /**
   * bond(did, amount) → StakeRecord
   * Register stake for an actor. Increases their rate allowance.
   */
  bond(did, amount) {
    if (amount <= 0) throw new RangeError('Bond amount must be positive');
    if (this._stakes.has(did)) {
      // Add to existing bond
      const existing = this._stakes.get(did);
      existing.bond    += amount;
      existing.balance += amount;
      existing.suspended = false;
      this._buckets.delete(did); // reset bucket to staked tier
      return existing;
    }
    const record = new StakeRecord({ did, bond: amount });
    this._stakes.set(did, record);
    this._buckets.delete(did); // rebuild on next access
    return record;
  }

  /**
   * unbond(did) → { released: number } | null
   * Removes stake. Actor reverts to unstaked rate limits.
   */
  unbond(did) {
    const record = this._stakes.get(did);
    if (!record) return null;
    const released = record.balance;
    this._stakes.delete(did);
    this._buckets.delete(did);
    return { released };
  }

  /**
   * stakeOf(did) → StakeRecord | null
   */
  stakeOf(did) {
    return this._stakes.get(did) ?? null;
  }

  isStaked(did)    { return this._stakes.has(did); }
  isSuspended(did) { return this._stakes.get(did)?.suspended ?? false; }

  // ── Rate gating ────────────────────────────────────────────────────────────

  /**
   * gate(event) → { ok, reason? }
   * Check whether an actor is allowed to submit this event right now.
   * Call before passing to kernel.reduce().
   *
   * event: SovereignEvent or { actor, type, tick }
   */
  gate(event) {
    const { actor, type } = event;

    // Suspended actors are fully blocked
    if (this.isSuspended(actor)) {
      return { ok: false, reason: `actor ${actor.slice(0,16)}... is suspended (stake exhausted by slashing)` };
    }

    // Event cost by type
    const cost = EVENT_COST[type] ?? 1;

    // Unstaked actors: enforce minimum write interval
    if (!this.isStaked(actor)) {
      if (_isWriteOp(type)) {
        const last = this._lastWrite.get(actor) ?? 0;
        const now  = Date.now();
        if (now - last < UNSTAKED_WRITE_INTERVAL) {
          const wait = UNSTAKED_WRITE_INTERVAL - (now - last);
          return { ok: false, reason: `unstaked actor rate limited — retry in ${wait}ms` };
        }
        this._lastWrite.set(actor, now);
      }
    }

    // Token bucket check
    const bucket = this._getBucket(actor);
    if (!bucket.consume(cost)) {
      this._recordViolation(actor, 'spam');
      return { ok: false, reason: `rate limit exceeded (available: ${Math.floor(bucket.available())} tokens, cost: ${cost})` };
    }

    return { ok: true };
  }

  /**
   * tokens(did) → number
   * Current token balance for an actor.
   */
  tokens(did) {
    return this._getBucket(did).available();
  }

  // ── Slashing ───────────────────────────────────────────────────────────────

  /**
   * reportMisbehaviour(did, type, evidence?) → { slashed, remaining, suspended } | null
   *
   * type: 'equivocation' | 'invalid_sig' | 'spam'
   * Returns null if actor has no stake to slash.
   */
  reportMisbehaviour(did, type, evidence = null) {
    const record = this._stakes.get(did);
    if (!record) {
      // No stake — just record the violation for ban tracking
      this._recordViolation(did, type);
      return null;
    }

    const fraction = SLASH_FRACTIONS[type] ?? 0.05;
    const result   = record.slash(fraction, type);

    this._recordViolation(did, type);

    return result;
  }

  /**
   * checkEquivocation(actor, tick, hash) → { equivocation: bool, evidence? }
   * Call for every ledger entry. Detects if same (actor, tick) produced two different hashes.
   */
  checkEquivocation(actor, tick, hash) {
    const key    = `${actor}:${tick}`;
    const seen   = this._equivEvid.get(key);

    if (!seen) {
      this._equivEvid.set(key, hash);
      return { equivocation: false };
    }

    if (seen !== hash) {
      return {
        equivocation: true,
        evidence: { actor, tick, hash1: seen, hash2: hash },
      };
    }

    return { equivocation: false };
  }

  /**
   * violations(did) → number
   */
  violations(did) {
    return this._violations.get(did) ?? 0;
  }

  // ── Summary ────────────────────────────────────────────────────────────────

  summary() {
    return {
      staked:     this._stakes.size,
      suspended:  [...this._stakes.values()].filter(s => s.suspended).length,
      totalStake: [...this._stakes.values()].reduce((sum, s) => sum + s.balance, 0),
      actors:     this._buckets.size,
    };
  }

  toJSON() {
    return {
      stakes:     [...this._stakes.values()].map(s => s.toJSON()),
      violations: Object.fromEntries(this._violations),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _getBucket(did) {
    if (!this._buckets.has(did)) {
      const staked  = this.isStaked(did);
      const cap     = staked ? STAKED_BUCKET_SIZE  : DEFAULT_BUCKET_SIZE;
      const refill  = staked ? STAKED_REFILL_RATE  : DEFAULT_REFILL_RATE;
      this._buckets.set(did, new TokenBucket(cap, refill));
    }
    return this._buckets.get(did);
  }

  _recordViolation(did, type) {
    this._violations.set(did, (this._violations.get(did) ?? 0) + 1);
  }
}

// ── Constants / helpers ───────────────────────────────────────────────────────

const EVENT_COST = Object.freeze({
  'state.set':          1,
  'state.delete':       1,
  'counter.increment':  1,
  'access.grant':       3,  // permission changes cost more
  'access.revoke':      3,
  'schema.register':    5,  // schema registration is expensive
});

const SLASH_FRACTIONS = Object.freeze({
  equivocation: SLASH_FRACTION_EQUIVOC,
  invalid_sig:  SLASH_FRACTION_SIG,
  spam:         SLASH_FRACTION_SPAM,
});

function _isWriteOp(type) {
  return ['state.set', 'state.delete', 'counter.increment', 'access.grant', 'access.revoke'].includes(type);
}

// ── Export ─────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.EconomicsEngine = EconomicsEngine;
  window.JBC.TokenBucket     = TokenBucket;
  window.JBC.StakeRecord     = StakeRecord;
}
if (typeof module !== 'undefined') module.exports = { EconomicsEngine, TokenBucket, StakeRecord };
