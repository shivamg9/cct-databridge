// Minimal REST API for OpenG2P integration. Node built-ins only, no install.
//
//   POST /api/v1/records   push one record (create or update by internal_record_id)
//   GET  /api/v1/records   pull records, paged, masked unless full access is granted
//   GET  /api/v1/health    liveness check
//
// Run:  node server/api.js [--seed-demo]
// Env:  DATABRIDGE_MODE              demo (default: synthetic records only) | integration
//       PORT (8080), HOST (127.0.0.1)
//       DATABRIDGE_API_KEY           standard key: push, and masked pull (required in integration mode)
//       DATABRIDGE_FULL_ACCESS_KEY   optional second key: unmasked pull, with an X-Access-Purpose header
//       DATABRIDGE_DATA_FILE         default server/data/<mode>-records.json
//       DATABRIDGE_ACCESS_LOG        default <data file>.access-log.jsonl (one line per unmasked pull)
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { pushRecord, pullRecords, createStore, seedFromIngestion } = require('./records.js');

const MAX_BODY = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MODES = ['demo', 'integration'];

// Reads settings from the environment and refuses unsafe combinations.
function configFromEnv(env, argv) {
  env = env || {}; argv = argv || [];
  const mode = env.DATABRIDGE_MODE || 'demo';
  if (!MODES.includes(mode)) throw new Error(`DATABRIDGE_MODE must be one of ${MODES.join(', ')}`);
  const host = env.HOST || '127.0.0.1';
  const apiKey = env.DATABRIDGE_API_KEY || null;
  const fullAccessKey = env.DATABRIDGE_FULL_ACCESS_KEY || null;
  const seedDemo = argv.includes('--seed-demo');
  if (mode === 'integration' && !apiKey) throw new Error('Integration mode needs DATABRIDGE_API_KEY.');
  if (!apiKey && !LOOPBACK.has(host)) throw new Error('Refusing to listen on a non-local address without DATABRIDGE_API_KEY.');
  if (fullAccessKey && !apiKey) throw new Error('DATABRIDGE_FULL_ACCESS_KEY needs DATABRIDGE_API_KEY as well.');
  if (fullAccessKey && fullAccessKey === apiKey) throw new Error('DATABRIDGE_FULL_ACCESS_KEY must differ from DATABRIDGE_API_KEY.');
  if (mode === 'integration' && seedDemo) throw new Error('--seed-demo is for demo mode only; it would mix synthetic records into the integration store.');
  const dataFile = env.DATABRIDGE_DATA_FILE || path.join(__dirname, 'data', `${mode}-records.json`);
  return { mode, host, port: Number(env.PORT || 8080), apiKey, fullAccessKey, seedDemo, dataFile, accessLog: env.DATABRIDGE_ACCESS_LOG || `${dataFile}.access-log.jsonl` };
}

function createServer(opts) {
  opts = opts || {};
  const mode = opts.mode || 'demo';
  const store = opts.store || createStore(opts.dataFile);
  if (mode === 'demo' && Object.values(store.items).some((it) => it.record.synthetic === false)) {
    throw new Error('This store holds real records (synthetic = false). Start in integration mode, or point DATABRIDGE_DATA_FILE at a demo store.');
  }
  const apiKey = opts.apiKey || null;
  const fullAccessKey = opts.fullAccessKey || null;

  function send(res, status, body, headers) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Trace-Id': res.traceId, ...(headers || {}) });
    res.end(JSON.stringify(body));
  }
  const fail = (res, status, code, message, details) => send(res, status, { error: { code, message, details: details || [], traceId: res.traceId } });

  const same = (got, want) => {
    const a = Buffer.from(String(got || '')), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  // 'full' | 'standard' | null. With no key configured (local demo) every caller is 'standard'.
  function access(req) {
    if (!apiKey) return 'standard';
    const got = req.headers['x-api-key'];
    if (fullAccessKey && same(got, fullAccessKey)) return 'full';
    return same(got, apiKey) ? 'standard' : null;
  }

  function readJson(req, res, done) {
    if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return fail(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'Content-Type must be application/json');
    let size = 0, tooBig = false;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) tooBig = true; else chunks.push(c); });
    req.on('end', () => {
      if (tooBig) return fail(res, 413, 'PAYLOAD_TOO_LARGE', `Body is larger than ${MAX_BODY / 1024} KB; send one record per request`);
      let body;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return fail(res, 400, 'INVALID_JSON', 'Body is not valid JSON'); }
      done(body);
    });
  }

  // Push and pull are kept as separate handlers.
  function handlePush(req, res) {
    readJson(req, res, (body) => {
      const out = pushRecord(store, body, { mode });
      if (!out.ok) {
        const shape = out.errors.some((e) => e.code === 'INVALID_BODY' || e.code === 'UNKNOWN_FIELD');
        return fail(res, shape ? 400 : 422, shape ? 'INVALID_REQUEST' : 'VALIDATION_FAILED', 'Record rejected; nothing was stored', out.errors);
      }
      const { ok, ...result } = out;
      send(res, out.status === 'CREATED' ? 201 : 200, result);
    });
  }

  function handlePull(req, res, url, level) {
    let purpose = null;
    if (level === 'full') {
      purpose = String(req.headers['x-access-purpose'] || '').trim().slice(0, 200);
      if (purpose.length < 10) return fail(res, 400, 'PURPOSE_REQUIRED', 'Unmasked pull needs an X-Access-Purpose header (at least 10 characters)');
    }
    const out = pullRecords(store, Object.fromEntries(url.searchParams), { view: level === 'full' ? 'full' : 'masked' });
    if (!out.ok) return fail(res, 400, 'INVALID_QUERY', 'Invalid query parameters', out.errors);
    if (purpose && opts.accessLog) {
      // Who saw unmasked data, when and why. Record IDs only, never values.
      const line = { at: new Date().toISOString(), traceId: res.traceId, purpose, query: url.search, count: out.items.length, ids: out.items.map((i) => i.record.internal_record_id) };
      fs.mkdirSync(path.dirname(opts.accessLog), { recursive: true });
      fs.appendFileSync(opts.accessLog, JSON.stringify(line) + '\n');
    }
    const { ok, ...result } = out;
    send(res, 200, result);
  }

  const server = http.createServer((req, res) => {
    res.traceId = 'tr-' + crypto.randomBytes(8).toString('hex');
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname === '/api/v1/health') {
        if (req.method === 'GET') return send(res, 200, { status: 'ok', mode });
        res.setHeader('Allow', 'GET');
        return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use GET');
      }
      if (url.pathname !== '/api/v1/records') return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
      const level = access(req);
      if (!level) return fail(res, 401, 'UNAUTHORISED', 'Missing or invalid X-API-Key');
      if (req.method === 'POST') return handlePush(req, res);
      if (req.method === 'GET') return handlePull(req, res, url, level);
      res.setHeader('Allow', 'GET, POST');
      return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Use POST to push or GET to pull');
    } catch (e) {
      console.error(res.traceId, e);
      return fail(res, 500, 'INTERNAL_ERROR', 'Unexpected error; quote the trace ID when reporting it');
    }
  });
  server.store = store;
  return server;
}

if (require.main === module) {
  let cfg;
  try { cfg = configFromEnv(process.env, process.argv); } catch (e) { console.error(e.message); process.exit(1); }
  let server;
  try { server = createServer(cfg); } catch (e) { console.error(e.message); process.exit(1); }
  if (cfg.seedDemo) console.log(`Seeded ${seedFromIngestion(server.store)} synthetic records from the ingestion pipeline.`);
  server.listen(cfg.port, cfg.host, () => {
    console.log(`CCT DataBridge API (${cfg.mode} mode) on http://${cfg.host}:${cfg.port}/api/v1/records · store ${cfg.dataFile}`);
    if (!cfg.apiKey) console.log('DATABRIDGE_API_KEY not set: no authentication (local use only).');
    if (cfg.mode === 'demo') console.log('Demo mode: records with synthetic=false are rejected.');
    console.log(cfg.fullAccessKey ? `Unmasked pull enabled for the full-access key; logged to ${cfg.accessLog}` : 'Pull returns masked records only (no full-access key configured).');
  });
}

module.exports = { createServer, configFromEnv };
