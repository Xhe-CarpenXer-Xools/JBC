/**
 * JBC · query.js
 * Derived state only. Query never mutates ledger.
 *
 * All reads go through derived state materialized from ledger replay.
 * Indexes are ephemeral acceleration structures, not sources of truth.
 */

'use strict';

class QueryEngine {
  constructor(kernel) {
    if (!kernel) throw new TypeError('QueryEngine requires a SovereignKernel instance');
    this._kernel  = kernel;
    this._indexes = new Map(); // name → index object
  }

  // ── query(state, type, params?) ───────────────────────────────────────────

  /**
   * query(state, type, params?) → result
   * Read-only queries against derived state.
   *
   * type: 'all' | 'key' | 'prefix' | 'entries' | 'author' | 'tick_range'
   */
  query(state, type, params = {}) {
    switch (type) {
      case 'all':
        return this._queryAll(state);

      case 'key':
        return this._queryKey(state, params.key);

      case 'keys':
        return this._queryKeys(state, params.keys);

      case 'prefix':
        return this._queryPrefix(state, params.prefix);

      case 'entries':
        return this._queryEntries(state, params);

      case 'author':
        return this._queryByAuthor(state, params.actor);

      case 'tick_range':
        return this._queryTickRange(state, params.from, params.to);

      default:
        throw new TypeError(`Unknown query type: '${type}'. Valid: all, key, keys, prefix, entries, author, tick_range`);
    }
  }

  /**
   * filter(results, predicate) → results[]
   * Post-query filtering. Never touches the ledger.
   */
  filter(results, predicate) {
    if (Array.isArray(results)) return results.filter(predicate);
    if (typeof results === 'object' && results !== null) {
      return Object.fromEntries(Object.entries(results).filter(([k, v]) => predicate(v, k)));
    }
    return results;
  }

  /**
   * materialize(ledgerEntries, reducer?) → Promise<KernelState>
   * Build state from ledger entries. Uses kernel.replay internally.
   * Never stores result — always freshly derived.
   */
  async materialize(ledgerEntries, reducer = null) {
    if (reducer) {
      let state = null;
      for (const entry of ledgerEntries) state = await reducer(state, entry);
      return state;
    }
    return this._kernel.replay(ledgerEntries);
  }

  /**
   * index(name, state, keyFn) → { get(key), keys(), size() }
   * Build an ephemeral index for fast repeated lookups.
   * Indexes are rebuild-on-demand — they are never persisted.
   */
  index(name, state, keyFn) {
    const idx = new Map();
    for (const [k, v] of state.entries) {
      const indexKey = keyFn(k, v);
      if (indexKey !== undefined) {
        if (!idx.has(indexKey)) idx.set(indexKey, []);
        idx.get(indexKey).push({ key: k, ...v });
      }
    }
    const built = Object.freeze({
      get:  (k) => idx.get(k) ?? [],
      keys: ()  => [...idx.keys()],
      size: ()  => idx.size,
    });
    this._indexes.set(name, built);
    return built;
  }

  /**
   * getIndex(name) → index | null
   */
  getIndex(name) {
    return this._indexes.get(name) ?? null;
  }

  // ── Private query implementations ─────────────────────────────────────────

  _queryAll(state) {
    return Object.fromEntries(
      [...state.entries.entries()].map(([k, v]) => [k, v.value])
    );
  }

  _queryKey(state, key) {
    if (!key) throw new TypeError('query.key: params.key required');
    return { [key]: state.get(key) };
  }

  _queryKeys(state, keys) {
    if (!Array.isArray(keys)) throw new TypeError('query.keys: params.keys must be array');
    return Object.fromEntries(keys.map(k => [k, state.get(k)]));
  }

  _queryPrefix(state, prefix) {
    if (!prefix) throw new TypeError('query.prefix: params.prefix required');
    const result = {};
    for (const [k, v] of state.entries) {
      if (k.startsWith(prefix)) result[k] = v.value;
    }
    return result;
  }

  _queryEntries(state, { sort = 'key', order = 'asc', limit } = {}) {
    let entries = [...state.entries.entries()].map(([k, v]) => ({
      key:   k,
      value: v.value,
      tick:  v.tick,
      actor: v.actor,
    }));

    entries.sort((a, b) => {
      let cmp = 0;
      if (sort === 'key')  cmp = a.key  < b.key  ? -1 : a.key  > b.key  ? 1 : 0;
      if (sort === 'tick') cmp = a.tick - b.tick;
      return order === 'desc' ? -cmp : cmp;
    });

    if (limit !== undefined) entries = entries.slice(0, limit);
    return entries;
  }

  _queryByAuthor(state, actor) {
    if (!actor) throw new TypeError('query.author: params.actor required');
    const result = {};
    for (const [k, v] of state.entries) {
      if (v.actor === actor) result[k] = v.value;
    }
    return result;
  }

  _queryTickRange(state, from = 0, to = Infinity) {
    const result = {};
    for (const [k, v] of state.entries) {
      if (v.tick >= from && v.tick <= to) result[k] = v.value;
    }
    return result;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.QueryEngine = QueryEngine;
}
if (typeof module !== 'undefined') module.exports = { QueryEngine };
