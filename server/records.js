// Push and pull logic for the OpenG2P record API. Field names, types, code lists
// and mandatory flags come from prototype/schema.js, which scripts/build.py
// generates from NSR_Registry_Build_Sheet.xlsx > Create Fields. No other
// attributes are accepted or returned.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SCHEMA = require('../prototype/schema.js');
const DB = require('../prototype/engine.js');

const FIELDS = new Map(SCHEMA.fields.map((f) => [f.name, f]));
const KEY = 'internal_record_id';
// System fields DataBridge fills when the caller leaves them out (sheet: "set by middleware/registry").
// In integration mode `synthetic` has no default: the caller must state it.
const SYSTEM_DEFAULTS = { record_status: 'ACTIVE', country_code: 'NG', data_source: 'OpenG2P', synthetic: true };
const MULTI = SCHEMA.fields.filter((f) => f.type === 'enumeration (multi)').map((f) => f.name);
const ORIGINS = ['openg2p-push', 'databridge-ingestion'];
// Masked values from a pull (for example "*******1035") must never be stored as real data.
const MASKED = /\*{3,}/;

// Pull masking follows the sheet's Sensitivity / Masking columns:
//   High (health), High (religion)  hidden: field left out
//   High                            last 4 characters visible
//   Medium                          partially masked: first character, or year of a date; numbers left out
const MASK = new Map(SCHEMA.fields.filter((f) => f.sensitivity !== 'Low').map((f) => [f.name, f.sensitivePersonal ? 'HIDE' : f.sensitivity === 'High' ? 'LAST4' : 'PARTIAL']));

// One engine instance, used only for its canonical validation rules
// (required, format, range, code list, dates, formula cells, conditional rules).
const engine = DB.createEngine(SCHEMA, { now: Date.now() });

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const BOOL = { true: true, false: false, yes: true, no: false, 1: true, 0: false };

// Converts one JSON value to the sheet's data type. Returns { value } or { error }.
function coerce(f, v) {
  const t = f.type;
  if (t.startsWith('string')) {
    return typeof v === 'string' ? { value: v.trim().replace(/\s+/g, ' ') } : { error: 'must be a string' };
  }
  if (t === 'enumeration') {
    return typeof v === 'string' || Number.isInteger(v) ? { value: String(v).trim() } : { error: 'must be a code (string)' };
  }
  if (t === 'enumeration (multi)') {
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === 'string' || Number.isInteger(x))) return { error: 'must be a non-empty array of codes' };
    const list = SCHEMA.codeLists[f.codeList] || [];
    const value = v.map((x) => String(x).trim());
    const bad = value.filter((x) => !list.some((c) => c.code === x));
    return bad.length ? { error: `has codes not in code list ${f.codeList}: ${bad.join(', ')}` } : { value };
  }
  if (t.startsWith('boolean')) {
    const key = String(typeof v === 'string' ? v.trim().toLowerCase() : v);
    return ['boolean', 'string', 'number'].includes(typeof v) && key in BOOL ? { value: BOOL[key] } : { error: 'must be true or false' };
  }
  if (t.startsWith('integer')) return Number.isInteger(v) ? { value: v } : { error: 'must be an integer' };
  if (t.startsWith('decimal')) return typeof v === 'number' && Number.isFinite(v) ? { value: v } : { error: 'must be a number' };
  if (t === 'date') {
    // The round trip rejects impossible dates such as 1990-02-31.
    const ok = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
    return ok ? { value: v } : { error: 'must be a real date in YYYY-MM-DD format' };
  }
  if (t === 'json') {
    if (v && typeof v === 'object') return { value: v };
    try { const p = JSON.parse(v); if (p && typeof p === 'object') return { value: p }; } catch (e) { /* falls through */ }
    return { error: 'must be a JSON object or array' };
  }
  return { error: `has unsupported type ${t}` };
}

// Validates and normalises a pushed record. Returns { record, errors, warnings }.
// opts.mode: 'demo' (default, synthetic records only) or 'integration'.
// opts.defaults: system values to fill when absent (an update keeps the stored ones).
function validateRecord(body, opts) {
  opts = opts || {};
  const mode = opts.mode || 'demo';
  const defaults = opts.defaults || SYSTEM_DEFAULTS;
  const errors = [], warnings = [];
  const issue = (field, code, message) => errors.push({ field, code, message });
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { record: null, errors: [{ field: null, code: 'INVALID_BODY', message: 'Body must be one JSON object of record fields' }], warnings };
  }
  const record = {};
  for (const [name, v] of Object.entries(body)) {
    const f = FIELDS.get(name);
    if (!f) { issue(name, 'UNKNOWN_FIELD', `${name} is not an attribute in the build sheet`); continue; }
    if (blank(v)) continue;
    const c = coerce(f, v);
    if (c.error) { issue(name, 'INVALID_TYPE', `${name} ${c.error}`); continue; }
    if (typeof c.value === 'string' && c.value.length > 200) { issue(name, 'FIELD_VALIDATION_FAILED', `${name} longer than 200 characters`); continue; }
    if (typeof c.value === 'string' && MASKED.test(c.value)) { issue(name, 'MASKED_VALUE', `${name} looks like a masked value from a pull; send the real value or leave it out`); continue; }
    // The engine checks range and format for source fields; system and derived fields are checked here.
    if (f.fill !== 'source' && f.range && (c.value < f.range[0] || c.value > f.range[1])) { issue(name, 'FIELD_VALIDATION_FAILED', `${name} outside range ${f.range[0]}..${f.range[1]}`); continue; }
    record[name] = c.value;
  }
  if (blank(record[KEY])) issue(KEY, 'REQUIRED_FIELD_MISSING', `${KEY} is required (the OpenG2P record ID)`);
  for (const [k, v] of Object.entries(defaults)) {
    if (record[k] !== undefined) continue;
    if (k === 'synthetic' && mode === 'integration' && !opts.defaults) continue;
    record[k] = v;
  }
  if (mode === 'demo' && record.synthetic === false) issue('synthetic', 'FIELD_VALIDATION_FAILED', 'synthetic must be true: demo mode accepts test data only');
  // Second guard against real records in demo storage: synthetic NINs in this project start with 99.
  if (mode === 'demo' && typeof record.nin === 'string' && !record.nin.startsWith('99')) issue('nin', 'FIELD_VALIDATION_FAILED', 'demo mode accepts synthetic NINs only (starting with 99)');
  if (mode === 'integration' && record.synthetic === undefined) issue('synthetic', 'REQUIRED_FIELD_MISSING', 'synthetic is required in integration mode (true for test data, false for real records)');

  engine.state.now = Date.now();
  for (const i of engine.validateCanonical(record, MULTI)) {
    if (errors.some((e) => e.field === i.field)) continue;
    if (i.field === 'consent_to_share_data' && i.severity === 'WARN') { warnings.push({ field: i.field, code: 'CONSENT_NOT_GIVEN', message: 'consent_to_share_data is false; downstream sharing must be restricted' }); continue; }
    (i.severity === 'WARN' ? warnings : errors).push({ field: i.field, code: i.code, message: i.message });
  }
  return { record: errors.length ? null : { [KEY]: record[KEY], ...record }, errors, warnings };
}

// Canonical JSON (sorted keys) so the same record always hashes the same.
function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
const hash = (rec) => crypto.createHash('sha256').update(stable(rec)).digest('hex');

// A JSON file holding { [internal_record_id]: { record, meta } }. Writes go to a
// temporary file first, then replace the original, so a crash never leaves half a file.
function createStore(file) {
  // No prototype, so record IDs such as "__proto__" or "toString" are plain keys.
  const items = Object.create(null);
  if (file && fs.existsSync(file)) Object.assign(items, JSON.parse(fs.readFileSync(file, 'utf8')));
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(items, null, 1));
    fs.renameSync(file + '.tmp', file);
  }
  return { items, save };
}

// Push: create, update or (for an identical repeat) leave unchanged.
// meta.origin is who created the record; meta.last_changed_by is who changed it last.
function pushRecord(store, body, opts) {
  opts = opts || {};
  const by = opts.origin || 'openg2p-push';
  const id = body && typeof body === 'object' && typeof body[KEY] === 'string' ? body[KEY].trim() : null;
  const prev = id && Object.hasOwn(store.items, id) ? store.items[id] : null;
  const defaults = prev ? Object.fromEntries(Object.keys(SYSTEM_DEFAULTS).map((k) => [k, prev.record[k]])) : null;
  const v = validateRecord(body, { mode: opts.mode, defaults });
  if (!v.record) return { ok: false, errors: v.errors, warnings: v.warnings };
  const now = new Date().toISOString();
  const h = hash(v.record);
  let status;
  if (!prev) {
    store.items[id] = { record: v.record, meta: { version: 1, received_at: now, updated_at: now, origin: by, last_changed_by: by, content_hash: h } };
    status = 'CREATED';
  } else if (prev.meta.content_hash === h) {
    status = 'UNCHANGED';
  } else {
    prev.record = v.record;
    Object.assign(prev.meta, { version: prev.meta.version + 1, updated_at: now, last_changed_by: by, content_hash: h });
    status = 'UPDATED';
  }
  if (status !== 'UNCHANGED') store.save();
  const m = store.items[id].meta;
  return { ok: true, status, internal_record_id: id, version: m.version, received_at: m.received_at, updated_at: m.updated_at, warnings: v.warnings };
}

function maskValue(rule, f, v) {
  if (rule === 'LAST4') { const s = String(v); return '*'.repeat(Math.max(s.length - 4, 3)) + s.slice(-4); }
  if (typeof v === 'number') return undefined;
  if (f.type === 'date') return `${String(v).slice(0, 4)}-**-**`;
  const s = String(v);
  return s.slice(0, 1) + '*'.repeat(Math.max(s.length - 1, 3));
}
function maskRecord(record) {
  const out = {};
  for (const [k, v] of Object.entries(record)) {
    const rule = MASK.get(k);
    if (rule === 'HIDE') continue;
    const m = rule ? maskValue(rule, FIELDS.get(k), v) : v;
    if (m !== undefined) out[k] = m;
  }
  return out;
}

// Pull: oldest change first, so a caller can page through and keep the last
// updated_at it saw as the next updated_since.
// opts.view: 'masked' (default) applies the sheet's masking; 'full' returns stored values.
function pullRecords(store, query, opts) {
  const view = (opts && opts.view) === 'full' ? 'full' : 'masked';
  const errors = [];
  const int = (name, def, min, max) => {
    if (query[name] === undefined) return def;
    const n = Number(query[name]);
    if (!Number.isInteger(n) || n < min || n > max) { errors.push({ field: name, code: 'INVALID_QUERY', message: `${name} must be an integer from ${min} to ${max}` }); return def; }
    return n;
  };
  const page = int('page', 1, 1, 1e6);
  const pageSize = int('page_size', 50, 1, 200);
  let since = null;
  if (query.updated_since !== undefined) {
    since = Date.parse(query.updated_since);
    if (isNaN(since)) errors.push({ field: 'updated_since', code: 'INVALID_QUERY', message: 'updated_since must be an ISO 8601 date-time' });
  }
  const changedBy = query.changed_by;
  if (changedBy !== undefined && !ORIGINS.includes(changedBy)) errors.push({ field: 'changed_by', code: 'INVALID_QUERY', message: `changed_by must be one of ${ORIGINS.join(', ')}` });
  if (errors.length) return { ok: false, errors };
  const all = Object.values(store.items)
    .filter((it) => since === null || Date.parse(it.meta.updated_at) > since)
    .filter((it) => changedBy === undefined || lastChangedBy(it) === changedBy)
    .sort((a, b) => a.meta.updated_at.localeCompare(b.meta.updated_at) || a.record[KEY].localeCompare(b.record[KEY]));
  const slice = all.slice((page - 1) * pageSize, page * pageSize);
  return {
    ok: true,
    view,
    items: slice.map((it) => ({
      record: view === 'full' ? it.record : maskRecord(it.record),
      meta: { version: it.meta.version, received_at: it.meta.received_at, updated_at: it.meta.updated_at, origin: it.meta.origin },
    })),
    page, page_size: pageSize, total: all.length, has_more: page * pageSize < all.length,
  };
}
// Files written before last_changed_by existed fall back to the creator.
const lastChangedBy = (it) => it.meta.last_changed_by || it.meta.origin;

// Loads synthetic records that went through the existing ingestion pipeline
// (scenario S01: NASSCO API → validate → de-duplicate → simulated Master Registry 1),
// so the pull API has data to return before OpenG2P pushes anything.
function seedFromIngestion(store) {
  const e = DB.createEngine(SCHEMA, { now: Date.now() });
  const sc = DB.SCENARIOS.find((s) => s.id === 'S01');
  const run = e.runToCompletion(e.startRun(sc.source, { mode: sc.mode, scenarioId: sc.id, sim: { ...(sc.sim || {}) } }));
  e.advanceClock(200000);
  let added = 0;
  for (const r of run.records) {
    if (r.primary.status !== 'WRITTEN' || Object.hasOwn(store.items, r.primary.masterId)) continue;
    const res = pushRecord(store, { ...r.canonical, [KEY]: r.primary.masterId }, { origin: 'databridge-ingestion' });
    if (res.ok) added++;
  }
  return added;
}

module.exports = { validateRecord, pushRecord, pullRecords, maskRecord, createStore, seedFromIngestion, FIELDS, SYSTEM_DEFAULTS, MASK, ORIGINS };
