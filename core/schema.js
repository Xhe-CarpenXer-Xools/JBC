/**
 * JBC · schema.js
 * Mandatory schema validation. Every event validated before ledger append.
 *
 * Schema version format: { schema: "1" }
 * Unknown schema version → reject.
 *
 * Field constraint types: string, number, boolean, object, array
 */

'use strict';

class SchemaField {
  constructor({ name, type, required = false, description = '', constraints = {} }) {
    if (!name) throw new TypeError('SchemaField.name required');
    if (!type) throw new TypeError('SchemaField.type required');
    this.name        = name;
    this.type        = type;      // string | number | boolean | object | array
    this.required    = required;
    this.description = description;
    this.constraints = constraints; // { min?, max?, minLength?, maxLength?, pattern?, enum? }
    Object.freeze(this);
  }

  validate(value) {
    if (value === undefined || value === null) {
      if (this.required) return { ok: false, reason: `field '${this.name}' is required` };
      return { ok: true };
    }

    // Type check
    const actualType = Array.isArray(value) ? 'array' : typeof value;
    if (actualType !== this.type) {
      return { ok: false, reason: `field '${this.name}': expected ${this.type}, got ${actualType}` };
    }

    const c = this.constraints;

    // Number constraints
    if (this.type === 'number') {
      if (c.min !== undefined && value < c.min)
        return { ok: false, reason: `field '${this.name}': ${value} < min ${c.min}` };
      if (c.max !== undefined && value > c.max)
        return { ok: false, reason: `field '${this.name}': ${value} > max ${c.max}` };
    }

    // String constraints
    if (this.type === 'string') {
      if (c.minLength !== undefined && value.length < c.minLength)
        return { ok: false, reason: `field '${this.name}': length ${value.length} < minLength ${c.minLength}` };
      if (c.maxLength !== undefined && value.length > c.maxLength)
        return { ok: false, reason: `field '${this.name}': length ${value.length} > maxLength ${c.maxLength}` };
      if (c.pattern !== undefined && !new RegExp(c.pattern).test(value))
        return { ok: false, reason: `field '${this.name}': does not match pattern ${c.pattern}` };
    }

    // Enum constraint (all types)
    if (c.enum !== undefined && !c.enum.includes(value))
      return { ok: false, reason: `field '${this.name}': '${value}' not in enum [${c.enum.join(', ')}]` };

    return { ok: true };
  }

  toJSON() {
    return { name: this.name, type: this.type, required: this.required, description: this.description, constraints: this.constraints };
  }

  static fromJSON(obj) { return new SchemaField(obj); }
}

class Schema {
  constructor({ name, version = '1', fields = [], description = '' }) {
    if (!name) throw new TypeError('Schema.name required');
    this.name        = name;
    this.version     = String(version);
    this.description = description;
    this.fields      = fields.map(f => f instanceof SchemaField ? f : SchemaField.fromJSON(f));
    Object.freeze(this.fields);
    Object.freeze(this);
  }

  /**
   * validate(payload) → { ok, reason? }
   * Validates a payload object against this schema's fields.
   */
  validate(payload) {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, reason: 'payload must be an object' };
    }

    for (const field of this.fields) {
      const result = field.validate(payload[field.name]);
      if (!result.ok) return result;
    }

    return { ok: true };
  }

  toJSON() {
    return {
      name:        this.name,
      version:     this.version,
      description: this.description,
      fields:      this.fields.map(f => f.toJSON()),
    };
  }

  static fromJSON(obj) { return new Schema(obj); }
}

class SchemaRegistry {
  constructor() {
    // Map of eventType → Map<version, Schema>
    this._schemas = new Map();
  }

  // ── API ───────────────────────────────────────────────────────────────────

  /**
   * registerSchema(eventType, schema) → Schema
   * Registers a schema for a given event type.
   * Multiple versions allowed — keyed by schema.version.
   */
  registerSchema(eventType, schema) {
    if (!eventType) throw new TypeError('eventType required');
    const s = schema instanceof Schema ? schema : Schema.fromJSON(schema);
    if (!this._schemas.has(eventType)) this._schemas.set(eventType, new Map());
    this._schemas.get(eventType).set(s.version, s);
    return s;
  }

  /**
   * validate(eventType, payload, schemaVersion?) → { ok, reason? }
   * Validates payload against the registered schema.
   * Rejects unknown event types unless they have no registered schema.
   */
  validate(eventType, payload, schemaVersion = '1') {
    const versions = this._schemas.get(eventType);

    // No schema registered for this type → reject (spec: reject unknown schema)
    if (!versions || versions.size === 0) {
      return { ok: false, reason: `no schema registered for event type '${eventType}'` };
    }

    const schema = versions.get(String(schemaVersion));
    if (!schema) {
      return { ok: false, reason: `unknown schema version '${schemaVersion}' for '${eventType}'` };
    }

    return schema.validate(payload);
  }

  /**
   * version(eventType) → string | null
   * Returns the latest registered version for an event type.
   */
  version(eventType) {
    const versions = this._schemas.get(eventType);
    if (!versions) return null;
    const keys = [...versions.keys()].sort((a,b) => Number(b) - Number(a));
    return keys[0] ?? null;
  }

  /**
   * migrate(eventType, payload, fromVersion, toVersion) → { ok, payload?, reason? }
   * Stub migration pathway. Implement per event type by overriding.
   * Returns unchanged payload if from === to.
   */
  migrate(eventType, payload, fromVersion, toVersion) {
    if (fromVersion === toVersion) return { ok: true, payload };
    // Custom migrators registered via registerMigrator()
    const key = `${eventType}:${fromVersion}->${toVersion}`;
    const fn  = this._migrators?.get(key);
    if (!fn) return { ok: false, reason: `no migrator for ${key}` };
    try {
      return { ok: true, payload: fn(payload) };
    } catch (e) {
      return { ok: false, reason: `migrator threw: ${e.message}` };
    }
  }

  /**
   * registerMigrator(eventType, fromVersion, toVersion, fn) → void
   */
  registerMigrator(eventType, fromVersion, toVersion, fn) {
    this._migrators = this._migrators ?? new Map();
    this._migrators.set(`${eventType}:${fromVersion}->${toVersion}`, fn);
  }

  // ── Introspection ─────────────────────────────────────────────────────────

  hasType(eventType)      { return this._schemas.has(eventType); }
  types()                 { return [...this._schemas.keys()]; }
  getSchema(type, ver)    { return this._schemas.get(type)?.get(String(ver ?? '1')) ?? null; }

  toJSON() {
    const out = {};
    for (const [type, versions] of this._schemas) {
      out[type] = {};
      for (const [ver, schema] of versions) out[type][ver] = schema.toJSON();
    }
    return { schemas: out };
  }

  static fromJSON(obj) {
    const reg = new SchemaRegistry();
    for (const [type, versions] of Object.entries(obj.schemas ?? {})) {
      for (const [, schema] of Object.entries(versions)) {
        reg.registerSchema(type, Schema.fromJSON(schema));
      }
    }
    return reg;
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

if (typeof window !== 'undefined') {
  window.JBC = window.JBC ?? {};
  window.JBC.SchemaField    = SchemaField;
  window.JBC.Schema         = Schema;
  window.JBC.SchemaRegistry = SchemaRegistry;
}
if (typeof module !== 'undefined') module.exports = { SchemaField, Schema, SchemaRegistry };
