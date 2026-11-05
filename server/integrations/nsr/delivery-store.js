// Durable delivery state: one JSON file { [delivery_id]: delivery }, written to a temporary file and renamed
// (same pattern as the record store), plus an append-only JSONL audit log. With no file, state is in memory (tests).
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function createDeliveryStore(file, auditFile) {
  const items = Object.create(null);
  if (file && fs.existsSync(file)) Object.assign(items, JSON.parse(fs.readFileSync(file, 'utf8')));
  const auditLines = [];
  function save() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(items, null, 1));
    fs.renameSync(file + '.tmp', file);
  }
  // Who did what to which delivery. Household serials and record IDs only, never field values.
  function audit(entry) {
    const line = { at: new Date().toISOString(), ...entry };
    if (!auditFile) { auditLines.push(line); return; }
    fs.mkdirSync(path.dirname(auditFile), { recursive: true });
    fs.appendFileSync(auditFile, JSON.stringify(line) + '\n');
  }
  function readAudit() {
    if (!auditFile) return auditLines.slice();
    if (!fs.existsSync(auditFile)) return [];
    return fs.readFileSync(auditFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  }
  return { items, save, audit, readAudit, file, auditFile };
}

module.exports = { createDeliveryStore };
