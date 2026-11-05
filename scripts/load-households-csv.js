// Loads a household sheet (CSV, one row per member) into the DataBridge backend through POST /api/v1/records,
// so the households appear under Transfers > Send to NSR. The console's file upload does not reach the backend.
// Nothing is sent to NSR here. Loading the same sheet again returns UNCHANGED.
//
//   node scripts/load-households-csv.js docs/samples/nsr-test-households.csv
//   node scripts/load-households-csv.js <file> --url http://127.0.0.1:8080
//
// Key: DATABRIDGE_API_KEY from the environment, otherwise from .env. Multi-select cells use ";" (1;3;10).
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const SCHEMA = require('../prototype/schema.js');
const { parseCsv } = require('../prototype/engine.js');

const FIELDS = new Map(SCHEMA.fields.map((f) => [f.name, f]));

function apiKey() {
  if (process.env.DATABRIDGE_API_KEY) return process.env.DATABRIDGE_API_KEY;
  const env = path.join(__dirname, '..', '.env');
  const line = fs.existsSync(env) && fs.readFileSync(env, 'utf8').split(/\r?\n/).find((l) => l.startsWith('DATABRIDGE_API_KEY='));
  return line ? line.slice('DATABRIDGE_API_KEY='.length).trim() : null;
}

// One cell to the JSON type the API expects. Blank cells are left out.
function cellValue(f, v) {
  if (f.type === 'enumeration (multi)') return v.split(';').map((x) => x.trim()).filter(Boolean);
  if (f.type.startsWith('integer') || f.type.startsWith('decimal')) return Number(v);
  if (f.type === 'json') return JSON.parse(v);
  return v;
}

function toRecord(header, row) {
  const rec = {};
  header.forEach((name, i) => {
    const v = (row[i] || '').trim();
    if (!v) return;
    const f = FIELDS.get(name);
    if (!f) throw new Error(`Unknown column: ${name}`);
    rec[name] = cellValue(f, v);
  });
  return rec;
}

async function main(argv) {
  const file = argv[0];
  const at = argv.indexOf('--url');
  const base = (at > -1 ? argv[at + 1] : 'http://127.0.0.1:8080').replace(/\/+$/, '');
  if (!file) { console.error('Usage: node scripts/load-households-csv.js <file.csv> [--url http://127.0.0.1:8080]'); return 1; }
  const key = apiKey();
  if (!key) { console.error('DATABRIDGE_API_KEY is not set and is not in .env.'); return 1; }

  const [header, ...rows] = parseCsv(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')).filter((r) => r.some((c) => String(c).trim()));
  let failed = 0;
  for (const row of rows) {
    const rec = toRecord(header, row);
    const res = await fetch(`${base}/api/v1/records`, { method: 'POST', headers: { 'X-API-Key': key, 'Content-Type': 'application/json' }, body: JSON.stringify(rec) });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) failed++;
    const problems = (body.error && (body.error.details || [{ message: body.error.message }]) || []).map((d) => d.message).join('; ');
    console.log(`${res.status} ${rec.internal_record_id} ${rec.nsr_household_serial} ${body.status || ''} ${problems}`.trim());
  }
  console.log(`${rows.length - failed} of ${rows.length} rows loaded. Next: Transfers > Send to NSR > Connect.`);
  return failed ? 1 : 0;
}

if (require.main === module) main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => { console.error(e.message); process.exitCode = 1; });
