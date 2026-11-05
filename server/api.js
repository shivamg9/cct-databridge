// Minimal REST API for OpenG2P integration. Node built-ins only, no install.
//
//   POST /api/v1/records   push one record (create or update by internal_record_id)
//   GET  /api/v1/records   pull records, paged, masked unless full access is granted
//   GET  /api/v1/health    liveness check
//   /api/v1/nsr/...        outbound OpenG2P NSR webhook: households, preview, submit, deliveries
//                          (see server/integrations/nsr/ and docs/api/nsr-webhook-integration.md)
//
// Run:  node server/api.js [--seed-demo]
// Env:  DATABRIDGE_MODE              demo (default: synthetic records only) | integration
//       PORT (8080), HOST (127.0.0.1)
//       DATABRIDGE_API_KEY           standard key: push, and masked pull (required in integration mode)
//       DATABRIDGE_FULL_ACCESS_KEY   optional second key: unmasked pull, with an X-Access-Purpose header
//       DATABRIDGE_UNMASKED_PULL     true | false (default). Demo mode only: the standard key pulls
//                                    stored (synthetic) values unmasked. Refused in integration mode.
//       DATABRIDGE_DATA_FILE         default server/data/<mode>-records.json
//       DATABRIDGE_ACCESS_LOG        default <data file>.access-log.jsonl (one line per unmasked pull)
//       DATABRIDGE_NSR_SUBMIT_KEY    key for NSR submit, retry and reconcile (operators only)
//       NSR_WEBHOOK_*                NSR webhook settings; off unless NSR_WEBHOOK_ENABLED=true (see nsr/config.js)
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
const { pushRecord, pullRecords, createStore, seedFromIngestion } = require('./records.js');
const { nsrConfigFromEnv } = require('./integrations/nsr/config.js');
const { createDeliveryStore } = require('./integrations/nsr/delivery-store.js');
const { createNsrService, NsrError } = require('./integrations/nsr/delivery-service.js');

const MAX_BODY = 64 * 1024;
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const MODES = ['demo', 'integration'];
const OPERATOR_ID = /^[A-Za-z0-9._@ -]{3,64}$/;
const UNMASKED_DEMO_ONLY ='DATABRIDGE_UNMASKED_PULL is for demo mode only; in integration mode unmasked pull needs DATABRIDGE_FULL_ACCESS_KEY and X-Access-Purpose.';

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
  const unmaskedRaw = String(env.DATABRIDGE_UNMASKED_PULL || 'false').trim().toLowerCase();
  if (!['true', 'false'].includes(unmaskedRaw)) throw new Error('DATABRIDGE_UNMASKED_PULL must be true or false.');
  const unmaskedPull = unmaskedRaw === 'true';
  if (unmaskedPull && mode !== 'demo') throw new Error(UNMASKED_DEMO_ONLY);
  const dataFile = env.DATABRIDGE_DATA_FILE || path.join(__dirname, 'data', `${mode}-records.json`);
  const nsr = nsrConfigFromEnv(env, { mode, apiKey, fullAccessKey });
  // Delivery state sits next to the record store, so it lives on the same volume.
  const nsrDeliveryFile = env.NSR_WEBHOOK_DELIVERY_FILE || path.join(path.dirname(dataFile), `${mode}-nsr-deliveries.json`);
  return { mode, host, port: Number(env.PORT || 8080), apiKey, fullAccessKey, unmaskedPull, seedDemo, dataFile, accessLog: env.DATABRIDGE_ACCESS_LOG || `${dataFile}.access-log.jsonl`, nsr, nsrDeliveryFile };
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
  // Demo stores hold synthetic records only (checked above), so this never reveals real data.
  const unmaskedPull = opts.unmaskedPull === true;
  if (unmaskedPull && mode !== 'demo') throw new Error(UNMASKED_DEMO_ONLY);
  // NSR webhook: disabled unless configured. Nothing is sent at startup; the timer only resends due
  // retries of deliveries an operator already submitted.
  const nsrCfg = opts.nsr || nsrConfigFromEnv({}, { mode, apiKey, fullAccessKey });
  const nsrSubmitKey = nsrCfg.submitKey || null;
  const deliveries = opts.deliveries || createDeliveryStore(opts.nsrDeliveryFile, opts.nsrDeliveryFile ? `${opts.nsrDeliveryFile}.audit.jsonl` : null);
  const nsr = createNsrService({ cfg: nsrCfg, records: store, deliveries, log: opts.log, now: opts.now, send: opts.nsrSend });

  function send(res, status, body, headers) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Trace-Id': res.traceId, ...(headers || {}) });
    res.end(JSON.stringify(body));
  }
  const fail = (res, status, code, message, details) => send(res, status, { error: { code, message, details: details || [], traceId: res.traceId } });

  const same = (got, want) => {
    const a = Buffer.from(String(got || '')), b = Buffer.from(want);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };
  // 'full' | 'operator' | 'standard' | null. With no key configured (local demo) every caller is 'standard'.
  // 'operator' (DATABRIDGE_NSR_SUBMIT_KEY) may also submit to NSR; elsewhere it counts as 'standard'.
  function access(req) {
    if (!apiKey) return 'standard';
    const got = req.headers['x-api-key'];
    if (fullAccessKey && same(got, fullAccessKey)) return 'full';
    if (nsrSubmitKey && same(got, nsrSubmitKey)) return 'operator';
    return same(got, apiKey) ? 'standard' : null;
  }

  // Masked unless demo unmasked pull is on, or the full-access key states a purpose (which is logged).
  // Returns { view, purpose }, or null after sending the error.
  function viewFor(req, res, level) {
    if (level !== 'full') return { view: unmaskedPull ? 'full' : 'masked', purpose: null };
    const purpose = String(req.headers['x-access-purpose'] || '').trim().slice(0, 200);
    if (purpose.length < 10) { fail(res, 400, 'PURPOSE_REQUIRED', 'Unmasked pull needs an X-Access-Purpose header (at least 10 characters)'); return null; }
    return { view: 'full', purpose };
  }
  function logAccess(res, purpose, query, ids) {
    if (!purpose || !opts.accessLog) return;
    // Who saw unmasked data, when and why. Record IDs only, never values.
    const line = { at: new Date().toISOString(), traceId: res.traceId, purpose, query, count: ids.length, ids };
    fs.mkdirSync(path.dirname(opts.accessLog), { recursive: true });
    fs.appendFileSync(opts.accessLog, JSON.stringify(line) + '\n');
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
    // The full-access key keeps its purpose check and access log even when demo unmasked pull is on.
    const v = viewFor(req, res, level);
    if (!v) return;
    const out = pullRecords(store, Object.fromEntries(url.searchParams), { view: v.view });
    if (!out.ok) return fail(res, 400, 'INVALID_QUERY', 'Invalid query parameters', out.errors);
    logAccess(res, v.purpose, url.search, out.items.map((i) => i.record.internal_record_id));
    const { ok, ...result } = out;
    send(res, 200, result);
  }

  // ---- NSR webhook routes. Reads need the API key; submit, retry and reconcile need the NSR submit key. ----
  const submitWith = (single) => (ctx) => ctx.body((b) => nsr.submit(b, { single, operator: ctx.operator, idempotencyKey: ctx.idempotencyKey }).then((r) => ctx.ok(r.status, r.delivery)));
  const NSR_ROUTES = [
    ['GET', /^\/api\/v1\/nsr\/config$/, 'read', (ctx) => ctx.ok(200, nsr.config())],
    ['GET', /^\/api\/v1\/nsr\/households$/, 'read', (ctx) => ctx.ok(200, nsr.listHouseholds(ctx.query))],
    ['POST', /^\/api\/v1\/nsr\/preview$/, 'read', (ctx) => ctx.body((b) => {
      const v = viewFor(ctx.req, ctx.res, ctx.level);
      if (!v) return;
      const out = nsr.preview(b, v.view);
      logAccess(ctx.res, v.purpose, 'nsr-preview', out.households.flatMap((h) => h.record_ids));
      ctx.ok(200, out);
    })],
    ['POST', /^\/api\/v1\/nsr\/submit$/, 'submit', submitWith(true)],
    ['POST', /^\/api\/v1\/nsr\/submit\/batch$/, 'submit', submitWith(false)],
    ['GET', /^\/api\/v1\/nsr\/deliveries$/, 'read', (ctx) => ctx.ok(200, nsr.list(ctx.query))],
    ['GET', /^\/api\/v1\/nsr\/deliveries\/([A-Za-z0-9-]{1,80})$/, 'read', (ctx) => ctx.ok(200, nsr.detail(ctx.params[0]))],
    ['POST', /^\/api\/v1\/nsr\/deliveries\/([A-Za-z0-9-]{1,80})\/retry$/, 'submit', (ctx) => ctx.body((b) => nsr.retry(ctx.params[0], b, ctx.operator).then((d) => ctx.ok(200, d)), true)],
    ['POST', /^\/api\/v1\/nsr\/deliveries\/([A-Za-z0-9-]{1,80})\/reconcile$/, 'submit', (ctx) => ctx.body((b) => ctx.ok(200, nsr.reconcile(ctx.params[0], b, ctx.operator)))],
  ];
  function handleNsr(req, res, url, level) {
    const matches = NSR_ROUTES.map(([m, re, need, fn]) => ({ m, need, fn, p: url.pathname.match(re) })).filter((r) => r.p);
    if (!matches.length) return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
    const route = matches.find((r) => r.m === req.method);
    if (!route) { res.setHeader('Allow', [...new Set(matches.map((r) => r.m))].join(', ')); return fail(res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed'); }
    const onError = (e) => {
      if (e instanceof NsrError) return fail(res, e.status, e.code, e.message, e.details);
      console.error(res.traceId, e);
      return fail(res, 500, 'INTERNAL_ERROR', 'Unexpected error; quote the trace ID when reporting it');
    };
    const run = (fn, b) => { try { Promise.resolve(fn(b)).catch(onError); } catch (e) { onError(e); } };
    const ctx = {
      req, res, level, params: route.p.slice(1), query: Object.fromEntries(url.searchParams),
      ok: (status, body) => send(res, status, body),
      // emptyOk: the request may come without a body (retry).
      body: (fn, emptyOk) => {
        if (emptyOk && !req.headers['content-type'] && !Number(req.headers['content-length'] || 0)) return run(fn, {});
        readJson(req, res, (b) => run(fn, b));
      },
    };
    if (route.need === 'submit') {
      if (!nsrCfg.enabled) return fail(res, 503, 'NSR_WEBHOOK_DISABLED', 'The NSR webhook is disabled (NSR_WEBHOOK_ENABLED=false). Nothing was sent.');
      if (level !== 'operator') return fail(res, 403, 'NSR_SUBMIT_FORBIDDEN', 'Submitting to NSR needs the NSR submit key (DATABRIDGE_NSR_SUBMIT_KEY)');
      ctx.operator = String(req.headers['x-operator-id'] || '').trim();
      if (!OPERATOR_ID.test(ctx.operator)) return fail(res, 400, 'OPERATOR_REQUIRED', 'Send X-Operator-Id (3-64 characters: letters, digits, space, . _ @ -) to say who is acting');
      const key = req.headers['idempotency-key'];
      if (key !== undefined && !/^[A-Za-z0-9._:-]{8,100}$/.test(key)) return fail(res, 400, 'INVALID_REQUEST', 'Idempotency-Key must be 8-100 characters: letters, digits, . _ : -');
      ctx.idempotencyKey = key || null;
    }
    return run(route.fn, ctx);
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
      const isNsr = url.pathname.startsWith('/api/v1/nsr/');
      if (url.pathname !== '/api/v1/records' && !isNsr) return fail(res, 404, 'NOT_FOUND', 'No such endpoint');
      const level = access(req);
      if (!level) return fail(res, 401, 'UNAUTHORISED', 'Missing or invalid X-API-Key');
      if (isNsr) return handleNsr(req, res, url, level);
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
  server.nsr = nsr;
  server.deliveries = deliveries;
  nsr.start();
  server.on('close', () => nsr.stop());
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
    if (cfg.unmaskedPull) console.log('Demo unmasked pull is on (DATABRIDGE_UNMASKED_PULL=true): pull returns stored synthetic values.');
    if (cfg.fullAccessKey) console.log(`Unmasked pull enabled for the full-access key; logged to ${cfg.accessLog}`);
    else if (!cfg.unmaskedPull) console.log('Pull returns masked records only (no full-access key configured).');
    console.log(cfg.nsr.enabled
      ? `NSR webhook ON: ${cfg.nsr.endpoint} (submit needs the NSR submit key; synthetic records ${cfg.nsr.allowSynthetic ? 'allowed' : 'blocked'}). Deliveries: ${cfg.nsrDeliveryFile}`
      : 'NSR webhook off (NSR_WEBHOOK_ENABLED=false): preview only, nothing is sent.');
  });
}

module.exports = { createServer, configFromEnv };
