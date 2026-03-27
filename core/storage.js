/**
 * JBC · storage.js
 * IndexedDB canonical persistence.
 *
 * Stores:
 *   ledger            – append-only event log
 *   identities        – identity registry
 *   snapshots         – optional state snapshots
 *   transport_queue   – outbound message queue
 *   schema_registry   – schema definitions
 *
 * Rules:
 *   - Ledger persisted append-only (no updates, no deletes)
 *   - Snapshots optional acceleration — never source of truth
 *   - No state stored outside ledger-derived objects
 */

'use strict';

const DB_NAME    = 'JBC_v1';
const DB_VERSION = 1;

const STORES = {
  ledger:           { keyPath: 'id',   autoIncrement: false },
  identities:       { keyPath: 'did',  autoIncrement: false },
  snapshots:        { keyPath: 'id',   autoIncrement: true  },
  transport_queue:  { keyPath: 'id',   autoIncrement: false },
  schema_registry:  { keyPath: 'name', autoIncrement: false },
};

class Storage {
  constructor() {
    this._db = null;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * open() → Promise<void>
   * Opens (or creates) the IndexedDB database.
   */
  async open() {
    if (this._db) return;
    this._db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        for (const [name, opts] of Object.entries(STORES)) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, opts);
          }
        }
      };
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  /**
   * close() → void
   */
  close() {
    this._db?.close();
    this._db = null;
  }

  // ── Ledger store (append-only) ────────────────────────────────────────────

  /**
   * appendLedgerEntry(entry) → Promise<void>
   * Stores a ledger entry. Rejects if id already exists (append-only guarantee).
   */
  async appendLedgerEntry(entry) {
    await this._put('ledger', entry, true /* noOverwrite */);
  }

  /**
   * readLedger(from?, to?) → Promise<entry[]>
   * Reads all ledger entries in insertion order.
   */
  async readLedger(from = 0, to = undefined) {
    const all = await this._getAll('ledger');
    return to !== undefined ? all.slice(from, to) : all.slice(from);
  }

  /**
   * getLedgerEntry(id) → Promise<entry|null>
   */
  async getLedgerEntry(id) {
    return this._get('ledger', id);
  }

  /**
   * ledgerSize() → Promise<number>
   */
  async ledgerSize() {
    return this._count('ledger');
  }

  // ── Identity store ────────────────────────────────────────────────────────

  async saveIdentity(identity) {
    await this._put('identities', identity.toJSON ? identity.toJSON() : identity);
  }

  async getIdentity(did) {
    return this._get('identities', did);
  }

  async getAllIdentities() {
    return this._getAll('identities');
  }

  // ── Snapshot store ────────────────────────────────────────────────────────

  /**
   * saveSnapshot({ ledgerSize, stateHash, state }) → Promise<void>
   * Snapshots are acceleration hints. They never replace the ledger.
   */
  async saveSnapshot(snapshot) {
    const entry = { ...snapshot, savedAt: new Date().toISOString() };
    await this._put('snapshots', entry);
  }

  async getLatestSnapshot() {
    const all = await this._getAll('snapshots');
    return all[all.length - 1] ?? null;
  }

  // ── Transport queue ───────────────────────────────────────────────────────

  async enqueue(envelope) {
    await this._put('transport_queue', envelope);
  }

  async dequeue(id) {
    await this._delete('transport_queue', id);
  }

  async getPendingQueue() {
    return this._getAll('transport_queue');
  }

  // ── Schema registry store ─────────────────────────────────────────────────

  async saveSchemaRegistry(registryJSON) {
    // Store as a single document keyed 'main'
    await this._put('schema_registry', { name: 'main', ...registryJSON });
  }

  async loadSchemaRegistry() {
    return this._get('schema_registry', 'main');
  }

  // ── Wipe (testing only) ───────────────────────────────────────────────────

  async wipeAll() {
    for (const storeName of Object.keys(STORES)) {
      await this._clear(storeName);
    }
  }

  // ── IndexedDB primitives ──────────────────────────────────────────────────

  _tx(storeNames, mode = 'readonly') {
    if (!this._db) throw new Error('Storage not open. Call storage.open() first.');
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return this._db.transaction(names, mode);
  }

  _put(storeName, obj, noOverwrite = false) {
    return new Promise((resolve, reject) => {
      const tx    = this._tx(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req   = noOverwrite ? store.add(obj) : store.put(obj);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _get(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx    = this._tx(storeName);
      const store = tx.objectStore(storeName);
      const req   = store.get(key);
      req.onsuccess = (e) => resolve(e.target.result ?? null);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _getAll(storeName) {
    return new Promise((resolve, reject) => {
      const tx    = this._tx(storeName);
      const store = tx.objectStore(storeName);
      const req   = store.getAll();
      req.onsuccess = (e) => resolve(e.target.result ?? []);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _count(storeName) {
    return new Promise((resolve, reject) => {
      const tx    = this._tx(storeName);
      const store = tx.objectStore(storeName);
      const req   = store.count();
      req.onsuccess = (e) => resolve(e.target.result);
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _delete(storeName, key) {
    return new Promise((resolve, reject) => {
      const tx    = this._tx(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req   = store.delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }

  _clear(storeName) {
    return new Promise((resolve, reject) => {
      const tx    = this._tx(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req   = store.clear();
      req.onsuccess = () => resolve();
      req.onerror   = (e) => reject(e.target.error);
    });
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.Storage = Storage;
}
if (typeof module !== 'undefined') module.exports = { Storage };
