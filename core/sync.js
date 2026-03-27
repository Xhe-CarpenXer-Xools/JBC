/**
 * JBC · sync.js
 * Explicit merge law per object type.
 *
 * Merge table:
 *   identity   → immutable
 *   message    → append-only
 *   profile    → last_writer_wins
 *   permission → signed authority precedence
 *
 * No implicit merge. No undefined conflict outcome.
 */

'use strict';

// ── Merge strategies ──────────────────────────────────────────────────────────

/**
 * IDENTITY — immutable after creation. Reject any mutation attempt.
 */
function mergeIdentity(local, remote) {
  if (!local) return { result: remote, conflict: false };
  // Identities are immutable. If they differ, local wins (reject remote mutation).
  if (local.did !== remote.did) return { result: local, conflict: true, reason: 'identity DID mismatch' };
  // Same DID — only allowed delta is revoked: true (one-way door)
  if (remote.revoked && !local.revoked) return { result: { ...local, revoked: true }, conflict: false };
  return { result: local, conflict: false };
}

/**
 * MESSAGE — append-only. Accumulate all unique messages.
 * Messages identified by id field.
 */
function mergeMessages(local = [], remote = []) {
  const seen = new Map();
  for (const m of local)  seen.set(m.id, m);
  for (const m of remote) if (!seen.has(m.id)) seen.set(m.id, m);
  const result = [...seen.values()].sort((a, b) => {
    // Sort by clock counter, then id for stability
    const dc = (a.clock?.counter ?? 0) - (b.clock?.counter ?? 0);
    return dc !== 0 ? dc : (a.id < b.id ? -1 : 1);
  });
  return { result, conflict: false };
}

/**
 * PROFILE — last_writer_wins by logical clock.
 */
function mergeProfile(local, remote) {
  if (!local) return { result: remote, conflict: false };
  if (!remote) return { result: local, conflict: false };

  const lc = local.clock?.counter  ?? 0;
  const rc = remote.clock?.counter ?? 0;

  if (rc > lc) return { result: remote, conflict: false };
  if (lc > rc) return { result: local,  conflict: false };

  // Same clock — tiebreak by actor/node string (deterministic)
  const ln = local.clock?.node  ?? '';
  const rn = remote.clock?.node ?? '';
  if (rn > ln) return { result: remote, conflict: false };
  return { result: local, conflict: false };
}

/**
 * PERMISSION — signed authority precedence.
 * Higher-authority issuer wins. Equal authority → LWW by clock.
 */
const CAP_RANK = { admin: 3, schema: 2, sync: 2, write: 1, read: 0 };

function mergePermission(local, remote) {
  if (!local) return { result: remote, conflict: false };
  if (!remote) return { result: local, conflict: false };

  const lr = CAP_RANK[local.issuerCap  ?? 'read'] ?? 0;
  const rr = CAP_RANK[remote.issuerCap ?? 'read'] ?? 0;

  if (rr > lr) return { result: remote, conflict: false };
  if (lr > rr) return { result: local,  conflict: false };

  // Same authority rank → LWW
  return mergeProfile(local, remote);
}

// ── Merge registry ────────────────────────────────────────────────────────────

const MERGE_STRATEGIES = Object.freeze({
  identity:   mergeIdentity,
  message:    (l, r) => mergeMessages(l ? (Array.isArray(l) ? l : [l]) : [], Array.isArray(r) ? r : [r]),
  profile:    mergeProfile,
  permission: mergePermission,
});

// ── SyncEngine ────────────────────────────────────────────────────────────────

class SyncEngine {
  constructor() {
    this._strategies = new Map(Object.entries(MERGE_STRATEGIES));
  }

  /**
   * registerStrategy(objectType, fn) → void
   * Register a custom merge strategy.
   * fn(local, remote) → { result, conflict: bool, reason?: string }
   */
  registerStrategy(objectType, fn) {
    this._strategies.set(objectType, fn);
  }

  /**
   * merge(objectType, local, remote) → { result, conflict, reason? }
   * Apply the explicit merge law for the given object type.
   */
  merge(objectType, local, remote) {
    const strategy = this._strategies.get(objectType);
    if (!strategy) throw new Error(`No merge strategy registered for '${objectType}'. Register one with sync.registerStrategy()`);
    return strategy(local, remote);
  }

  /**
   * resolveConflict(objectType, local, remote) → { result, resolution }
   * Explicit conflict resolution — always produces a deterministic winner.
   */
  resolveConflict(objectType, local, remote) {
    const { result, conflict, reason } = this.merge(objectType, local, remote);
    return {
      result,
      conflict,
      resolution: conflict
        ? `Conflict resolved by '${objectType}' merge law: ${reason ?? 'deterministic tiebreak'}`
        : 'No conflict',
    };
  }

  /**
   * compareClock(a, b) → -1 | 0 | 1
   * Delegate to LogicalClock.compare.
   */
  compareClock(a, b) {
    const { LogicalClock } = _requireClock();
    return LogicalClock.compare(a, b);
  }

  /**
   * mergeBundle(localBundle, remoteBundle) → Promise<Bundle>
   * Merge two submission bundles. Deduplication and stable ordering applied.
   */
  async mergeBundle(localBundle, remoteBundle) {
    return localBundle.merge(remoteBundle);
  }

  strategies() { return [...this._strategies.keys()]; }
}

function _requireClock() {
  const c = (typeof window !== 'undefined' && window.JBC) ||
            (typeof module !== 'undefined' && (() => { try { return require('./clock'); } catch { return {}; } })());
  return c;
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.SyncEngine = SyncEngine;
  window.JBC.mergeStrategies = {
    mergeIdentity, mergeMessages, mergeProfile, mergePermission,
  };
}
if (typeof module !== 'undefined') {
  module.exports = { SyncEngine, mergeIdentity, mergeMessages, mergeProfile, mergePermission };
}
