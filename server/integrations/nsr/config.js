// Settings for the outbound OpenG2P NSR webhook (POST /partner/ingest_data).
// Off unless NSR_WEBHOOK_ENABLED=true. Refuses unsafe combinations at startup.
'use strict';

const DEFAULTS = {
  baseUrl: 'https://staff-nsr.openg2p.dpiforall.com',
  path: '/partner/ingest_data',
  dataModel: 'CCT_DATABRIDGE_INTAKE',
  registerId: 'a0000000-0000-4000-8000-000000000002',
  intakeFormId: 'c1000000-0000-4000-8000-000000000002',
  partnerId: 'CCT_DATABRIDGE',
};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function bool(env, name, def) {
  const v = String(env[name] === undefined || env[name] === '' ? def : env[name]).trim().toLowerCase();
  if (v !== 'true' && v !== 'false') throw new Error(`${name} must be true or false.`);
  return v === 'true';
}
function int(env, name, def, min, max) {
  if (env[name] === undefined || env[name] === '') return def;
  const n = Number(env[name]);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return n;
}

// env: process.env. base: { mode, apiKey } from the main config.
function nsrConfigFromEnv(env, base) {
  env = env || {}; base = base || {};
  const cfg = {
    enabled: bool(env, 'NSR_WEBHOOK_ENABLED', 'false'),
    baseUrl: (env.NSR_WEBHOOK_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, ''),
    path: DEFAULTS.path,
    dataModel: env.NSR_WEBHOOK_DATA_MODEL || DEFAULTS.dataModel,
    registerId: env.NSR_WEBHOOK_REGISTER_ID || DEFAULTS.registerId,
    intakeFormId: env.NSR_WEBHOOK_INTAKE_FORM_ID || DEFAULTS.intakeFormId,
    partnerId: env.NSR_WEBHOOK_PARTNER_ID || DEFAULTS.partnerId,
    // Provisional: the spec requires a non-empty "signature" string but defines no algorithm. Kept secret anyway.
    signature: env.NSR_WEBHOOK_SIGNATURE || null,
    submitKey: env.DATABRIDGE_NSR_SUBMIT_KEY || null,
    allowSynthetic: bool(env, 'NSR_WEBHOOK_ALLOW_SYNTHETIC', 'false'),
    // Plain HTTP for a local mock only. Never for the real registry.
    allowInsecureTestEndpoint: bool(env, 'NSR_WEBHOOK_INSECURE_TEST_ENDPOINT', 'false'),
    timeoutMs: int(env, 'NSR_WEBHOOK_TIMEOUT_MS', 20000, 1000, 120000),
    maxRetries: int(env, 'NSR_WEBHOOK_MAX_RETRIES', 5, 0, 20),
    retryBaseMs: int(env, 'NSR_WEBHOOK_RETRY_BASE_MS', 30000, 100, 3600000),
    retryMaxMs: int(env, 'NSR_WEBHOOK_RETRY_MAX_MS', 1800000, 100, 86400000),
    workerIntervalMs: int(env, 'NSR_WEBHOOK_WORKER_INTERVAL_MS', 5000, 50, 600000),
    maxBatchHouseholds: int(env, 'NSR_WEBHOOK_MAX_BATCH_HOUSEHOLDS', 50, 1, 1000),
    maxMembers: int(env, 'NSR_WEBHOOK_MAX_MEMBERS', 50, 1, 500),
    maxBodyBytes: int(env, 'NSR_WEBHOOK_MAX_BODY_BYTES', 2 * 1024 * 1024, 1024, 50 * 1024 * 1024),
  };
  let url;
  try { url = new URL(cfg.baseUrl + cfg.path); } catch (e) { throw new Error('NSR_WEBHOOK_BASE_URL is not a valid URL.'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('NSR_WEBHOOK_BASE_URL must be scheme://host[:port] only (no credentials, query or fragment).');
  if (url.protocol !== 'https:') {
    if (url.protocol !== 'http:' || !(cfg.allowInsecureTestEndpoint || LOOPBACK.has(url.hostname))) {
      throw new Error('NSR_WEBHOOK_BASE_URL must use https. Plain http is allowed only for a local mock (NSR_WEBHOOK_INSECURE_TEST_ENDPOINT=true).');
    }
  }
  for (const k of ['dataModel', 'registerId', 'intakeFormId', 'partnerId']) if (!/^[A-Za-z0-9_.-]{1,100}$/.test(cfg[k])) throw new Error(`NSR webhook ${k} has unexpected characters.`);
  if (cfg.retryMaxMs < cfg.retryBaseMs) throw new Error('NSR_WEBHOOK_RETRY_MAX_MS must be at least NSR_WEBHOOK_RETRY_BASE_MS.');
  if (cfg.submitKey && base.apiKey && cfg.submitKey === base.apiKey) throw new Error('DATABRIDGE_NSR_SUBMIT_KEY must differ from DATABRIDGE_API_KEY.');
  if (cfg.submitKey && base.fullAccessKey && cfg.submitKey === base.fullAccessKey) throw new Error('DATABRIDGE_NSR_SUBMIT_KEY must differ from DATABRIDGE_FULL_ACCESS_KEY.');
  if (cfg.submitKey && !base.apiKey) throw new Error('DATABRIDGE_NSR_SUBMIT_KEY needs DATABRIDGE_API_KEY as well.');
  if (cfg.enabled) {
    if (!cfg.signature) throw new Error('NSR_WEBHOOK_ENABLED=true needs NSR_WEBHOOK_SIGNATURE.');
    if (!cfg.submitKey) throw new Error('NSR_WEBHOOK_ENABLED=true needs DATABRIDGE_NSR_SUBMIT_KEY, so only operators holding it can submit.');
  }
  url.search = new URLSearchParams({ data_model: cfg.dataModel, register_id: cfg.registerId, intake_form_id: cfg.intakeFormId }).toString();
  cfg.endpoint = url.toString();
  cfg.endpointHost = url.host;
  return cfg;
}

// Settings safe to show to API callers and in logs: no signature, no keys.
function publicConfig(cfg) {
  return {
    enabled: cfg.enabled,
    endpoint: cfg.endpoint,
    partner_id: cfg.partnerId,
    data_model: cfg.dataModel,
    register_id: cfg.registerId,
    intake_form_id: cfg.intakeFormId,
    signature_configured: Boolean(cfg.signature),
    submit_key_configured: Boolean(cfg.submitKey),
    allow_synthetic: cfg.allowSynthetic,
    insecure_test_endpoint: cfg.endpoint.startsWith('http:'),
    limits: { timeout_ms: cfg.timeoutMs, max_retries: cfg.maxRetries, max_batch_households: cfg.maxBatchHouseholds, max_members: cfg.maxMembers, max_body_bytes: cfg.maxBodyBytes },
  };
}

module.exports = { nsrConfigFromEnv, publicConfig, DEFAULTS };
