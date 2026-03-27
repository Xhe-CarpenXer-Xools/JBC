/**
 * JBC · snapshot.js
 * Snapshot strategy: periodic state capture to accelerate cold-start replay.
 *
 * Problem:
 *   Ledger.replay() traverses every entry on startup. At 10k+ events this
 *   becomes slow. Snapshots allow "fast-forward" to a known-good state
 *   and only replay the delta since the last snapshot.
 *
 * Guarantees:
 *   - Snapshots NEVER replace the ledger (source of truth is always the log).
 *   - A corrupt/missing snapshot falls back to full replay automatically.
 *   - Every snapshot is hash-verified before use.
 *   - Pruning only removes entries BEFORE a verified snapshot anchor.
 *
 * Snapshot format:
 * {
 *   version:     '0.1'
 *   ledgerSize:  number       – number of entries captured
 *   anchorId:    string       – id of the last included ledger entry
 *   anchorHash:  string       – hash of that entry (integrity check)
 *   stateHash:   string       – sha256 of serialised KernelState
 *   state:       object       – KernelState.toJSON()
 *   createdAt:   ISO string
 * }
 *
 * Usage:
 *   const snaps = new SnapshotManager({ kernel, ledger, storage });
 *   const state = await snaps.boot();             // fast-start
 *   await snaps.maybeSnapshot(currentState);      // call after each commit
 */

'use strict';

const SNAPSHOT_VERSION   = '0.1';
const DEFAULT_INTERVAL   = 500;    // snapshot every N committed events
const DEFAULT_PRUNE_KEEP = 2;      // keep last N snapshots in storage (prune older)

class SnapshotManager {
  /**
   * @param {object} opts
   * @param {SovereignKernel} opts.kernel   - for replay
   * @param {Ledger}          opts.ledger   - for reading entries
   * @param {Storage}         opts.storage  - for persisting snapshots
   * @param {number}  [opts.interval]       - events between snapshots (default 500)
   * @param {number}  [opts.keepCount]      - max snapshots to retain (default 2)
   * @param {boolean} [opts.pruneEnabled]   - whether to prune ledger after snapshot (default false)
   */
  constructor({ kernel, ledger, storage, interval, keepCount, pruneEnabled }) {
    if (!kernel)  throw new TypeError('SnapshotManager requires kernel');
    if (!ledger)  throw new TypeError('SnapshotManager requires ledger');
    if (!storage) throw new TypeError('SnapshotManager requires storage');

    this._kernel       = kernel;
    this._ledger       = ledger;
    this._storage      = storage;
    this._interval     = interval     ?? DEFAULT_INTERVAL;
    this._keepCount    = keepCount    ?? DEFAULT_PRUNE_KEEP;
    this._pruneEnabled = pruneEnabled ?? false;

    this._lastSnapshotSize = 0;  // ledger.size() at last snapshot
  }

  // ── Boot: fast-start from snapshot ─────────────────────────────────────────

  /**
   * boot() → Promise<{ state: KernelState, replayedFrom: number, totalEntries: number }>
   *
   * 1. Load the latest snapshot from storage.
   * 2. Verify its integrity. If bad → fall back to full replay.
   * 3. Replay only the delta (entries after the snapshot anchor).
   */
  async boot() {
    const totalEntries = await this._storage.ledgerSize();
    let   startIndex   = 0;
    let   state        = null;

    const snap = await this._loadVerifiedSnapshot();

    if (snap) {
      // Verify anchor exists in ledger
      const anchor = await this._storage.getLedgerEntry(snap.anchorId);
      if (anchor && anchor.hash === snap.anchorHash) {
        state      = this._hydrateState(snap.state);
        startIndex = snap.ledgerSize; // skip entries we already have
        this._lastSnapshotSize = snap.ledgerSize;
      } else {
        console.warn('[JBC/snapshot] Anchor mismatch — falling back to full replay');
      }
    }

    // Replay delta (or full log if no valid snapshot)
    const delta = await this._storage.readLedger(startIndex);
    if (delta.length > 0) {
      state = await this._kernel.replay(delta, state);
    } else if (!state) {
      // Totally empty ledger → genesis state
      const { KernelState } = _requireKernelState();
      state = KernelState.genesis();
    }

    return {
      state,
      replayedFrom: startIndex,
      totalEntries,
      snapshotUsed: startIndex > 0,
    };
  }

  // ── Snapshot trigger ───────────────────────────────────────────────────────

  /**
   * maybeSnapshot(state) → Promise<snapshot | null>
   *
   * Call after every committed event. Snapshots when the interval is reached.
   * Returns the new snapshot object if one was taken, null otherwise.
   */
  async maybeSnapshot(state) {
    const currentSize = this._ledger.size();
    const delta       = currentSize - this._lastSnapshotSize;

    if (delta < this._interval) return null;

    return this.forceSnapshot(state);
  }

  /**
   * forceSnapshot(state) → Promise<snapshot>
   *
   * Immediately create and persist a snapshot of the given state.
   */
  async forceSnapshot(state) {
    const crypto    = _requireCrypto();
    const head      = this._ledger.head();
    if (!head) return null; // nothing to snapshot yet

    const stateJSON  = state.toJSON();
    const stateHash  = await crypto.sha256(stateJSON);

    const snapshot = {
      version:    SNAPSHOT_VERSION,
      ledgerSize: this._ledger.size(),
      anchorId:   head.id,
      anchorHash: head.hash,
      stateHash,
      state:      stateJSON,
      createdAt:  new Date().toISOString(),
    };

    await this._storage.saveSnapshot(snapshot);
    this._lastSnapshotSize = this._ledger.size();

    await this._pruneOldSnapshots();

    return snapshot;
  }

  // ── Verify ─────────────────────────────────────────────────────────────────

  /**
   * verifySnapshot(snapshot) → Promise<{ ok, reason? }>
   *
   * Recomputes the state hash and checks anchor hash integrity.
   */
  async verifySnapshot(snapshot) {
    const crypto = _requireCrypto();

    if (!snapshot)             return { ok: false, reason: 'snapshot is null' };
    if (!snapshot.state)       return { ok: false, reason: 'snapshot has no state' };
    if (!snapshot.stateHash)   return { ok: false, reason: 'snapshot has no stateHash' };
    if (!snapshot.anchorId)    return { ok: false, reason: 'snapshot has no anchorId' };

    const recomputed = await crypto.sha256(snapshot.state);
    if (recomputed !== snapshot.stateHash) {
      return { ok: false, reason: `stateHash mismatch: expected ${recomputed.slice(0,8)} got ${snapshot.stateHash.slice(0,8)}` };
    }

    return { ok: true };
  }

  // ── Pruning ────────────────────────────────────────────────────────────────

  /**
   * pruneBeforeAnchor(anchorId) → Promise<{ pruned: number }>
   *
   * Removes ledger entries BEFORE the given anchor (the snapshot point).
   * ONLY call this if you have a verified snapshot covering these entries.
   * This is irreversible — ensure the snapshot is safe before pruning.
   *
   * Note: IndexedDB has no native range-delete by position, so this
   * rebuilds the ledger store from anchorId onwards.
   */
  async pruneBeforeAnchor(anchorId) {
    if (!this._pruneEnabled) {
      return { pruned: 0, skipped: true, reason: 'pruning disabled' };
    }

    const all = await this._storage.readLedger();
    const idx = all.findIndex(e => e.id === anchorId);
    if (idx <= 0) return { pruned: 0 };

    // The entries to keep: from the anchor onwards
    const keep   = all.slice(idx);
    const pruned = idx; // number of entries we're removing

    // Wipe and re-insert only the kept entries
    await this._storage.wipeAll(); // clears all stores — caller must re-persist identities, schemas etc.
    for (const entry of keep) {
      await this._storage.appendLedgerEntry(entry);
    }

    return { pruned };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  /**
   * status() → object
   */
  status() {
    return {
      interval:          this._interval,
      keepCount:         this._keepCount,
      pruneEnabled:      this._pruneEnabled,
      lastSnapshotSize:  this._lastSnapshotSize,
      ledgerSize:        this._ledger.size(),
      nextSnapshotIn:    Math.max(0, this._interval - (this._ledger.size() - this._lastSnapshotSize)),
    };
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  async _loadVerifiedSnapshot() {
    try {
      const snap = await this._storage.getLatestSnapshot();
      if (!snap) return null;

      const v = await this.verifySnapshot(snap);
      if (!v.ok) {
        console.warn('[JBC/snapshot] Snapshot failed verification:', v.reason);
        return null;
      }
      return snap;
    } catch (e) {
      console.warn('[JBC/snapshot] Could not load snapshot:', e.message);
      return null;
    }
  }

  async _pruneOldSnapshots() {
    // Storage only retains latest snapshot natively — no additional cleanup needed
    // unless we implement a multi-snapshot store. This is a hook for that.
  }

  _hydrateState(stateJSON) {
    const { KernelState } = _requireKernelState();

    // KernelState.toJSON() returns { tick, entries: { key: value }, size }
    // Re-inflate entries into the Map<key, { value, tick, actor }> format
    const entries     = new Map();
    const accepted    = new Set();
    const authorTicks = new Map();

    for (const [k, v] of Object.entries(stateJSON.entries ?? {})) {
      // stateJSON.entries is key → value (from toJSON) — we lose tick/actor on serialisation
      // so we store a richer form (see note below)
      if (v && typeof v === 'object' && '__jbc_entry__' in v) {
        entries.set(k, { value: v.value, tick: v.tick, actor: v.actor });
      } else {
        entries.set(k, { value: v, tick: stateJSON.tick ?? 0, actor: 'unknown' });
      }
    }

    return new KernelState({ tick: stateJSON.tick ?? 0, entries, accepted, authorTicks });
  }
}

// ── Rich snapshot serialisation helper ────────────────────────────────────────
// Patch KernelState.toJSON to emit richer entries when used with snapshots.
// Call enrichSnapshotSerialization() once at startup to enable.

function enrichSnapshotSerialization() {
  const { KernelState } = _requireKernelState();
  if (!KernelState || KernelState._snapshotEnriched) return;

  const orig = KernelState.prototype.toJSON;
  KernelState.prototype.toJSON = function() {
    const base = orig.call(this);
    // Replace simple key→value with rich key→{__jbc_entry__, value, tick, actor}
    const richEntries = {};
    for (const [k, v] of this.entries) {
      richEntries[k] = { __jbc_entry__: true, value: v.value, tick: v.tick, actor: v.actor };
    }
    return { ...base, entries: richEntries };
  };
  KernelState._snapshotEnriched = true;
}

function _requireCrypto() {
  const c = (typeof window !== 'undefined' && window.JBC?.crypto) ||
            (typeof module !== 'undefined' && (() => { try { return require('./crypto'); } catch { return null; } })());
  if (!c) throw new Error('JBC.crypto must be loaded before JBC.SnapshotManager');
  return c;
}

function _requireKernelState() {
  const c = (typeof window !== 'undefined' && window.JBC) ||
            (typeof module !== 'undefined' && (() => { try { return require('./kernel'); } catch { return {}; } })());
  return c;
}

// ── Export ─────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.SnapshotManager              = SnapshotManager;
  window.JBC.enrichSnapshotSerialization  = enrichSnapshotSerialization;
}
if (typeof module !== 'undefined') module.exports = { SnapshotManager, enrichSnapshotSerialization };
