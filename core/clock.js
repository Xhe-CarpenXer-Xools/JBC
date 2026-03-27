/**
 * JBC · clock.js
 * Logical clock. Monotonic. Merge-safe. Replay-stable.
 *
 * Event clock format: { counter: number, node: string }
 */

'use strict';

class LogicalClock {
  /**
   * @param {string} nodeId - stable identifier for this node
   */
  constructor(nodeId) {
    if (!nodeId) throw new TypeError('LogicalClock requires a nodeId');
    this._node    = nodeId;
    this._counter = 0;
  }

  /**
   * tick() → { counter, node }
   * Advance and return current clock value.
   */
  tick() {
    this._counter++;
    return this.current();
  }

  /**
   * current() → { counter, node }
   */
  current() {
    return { counter: this._counter, node: this._node };
  }

  /**
   * merge(remote) → { counter, node }
   * Advance to max(local, remote) + 1 to guarantee causal ordering.
   * remote: { counter: number } or a bare number
   */
  merge(remote) {
    const remoteCounter = typeof remote === 'number'
      ? remote
      : (remote?.counter ?? 0);
    this._counter = Math.max(this._counter, remoteCounter) + 1;
    return this.current();
  }

  /**
   * compare(a, b) → -1 | 0 | 1
   * Deterministic total order: counter first, node string second.
   * Used for stable event ordering during replay.
   */
  static compare(a, b) {
    const dc = a.counter - b.counter;
    if (dc !== 0) return dc < 0 ? -1 : 1;
    if (a.node < b.node) return -1;
    if (a.node > b.node) return  1;
    return 0;
  }

  /**
   * toJSON() / fromJSON() for serialization
   */
  toJSON() {
    return { counter: this._counter, node: this._node };
  }

  static fromJSON({ counter, node }) {
    const c = new LogicalClock(node);
    c._counter = counter;
    return c;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.LogicalClock = LogicalClock;
}
if (typeof module !== 'undefined') module.exports = { LogicalClock };
