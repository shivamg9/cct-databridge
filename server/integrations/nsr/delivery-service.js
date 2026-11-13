// Outbound NSR workflow: preview, submit, queue, dispatch, retry, reconcile, and a timer that sends what is due.
// Nothing is sent unless an operator submits households, or submits a transfer with NSR_WEBHOOK_AUTO_SEND=true.
// Seeding, pulls, pushes and startup never send.
//
// Delivery statuses
//   PENDING               queued or being sent
//   ACCEPTED              NSR acknowledged the message (ACK). Ingestion is asynchronous: this is NOT proof
//                         the household is in the register (registry_commit stays NOT_CONFIRMED)
//   REJECTED              NSR answered and refused it (4xx, NACK). Fix the data and submit again
//   RETRY_SCHEDULED       NSR certainly did not process it (unreachable, 429, 502, 503); sent again later
//   CONFIRMATION_PENDING  it may have reached NSR (timeout, 500, 504, crash mid-send). Not resent automatically:
//                         an operator checks NSR and reconciles, so a household is never created twice
//   DELIVERY_FAILED       retries used up, or a configuration fault (401/403/404, TLS). Manual retry allowed
'use strict';
const { buildHousehold, groupHouseholds, maskMessage } = require('./household-mapper.js');
const { buildEnvelope, newMessageId, FORMATS } = require('./payload-builder.js');
const { publicConfig } = require('./config.js');
const client = require('./client.js');
const crypto = require('node:crypto');

const ACTIVE = new Set(['PENDING', 'RETRY_SCHEDULED', 'CONFIRMATION_PENDING']);
const SERIAL = /^[A-Za-z0-9._\/-]{1,100}$/;
const MAX_QUEUE_SERIALS = 2000;
const ENVELOPE_BYTES = 1024; // room for the header and signature when sizing a batch

class NsrError extends Error {
  constructor(status, code, message, details) { super(message); this.status = status; this.code = code; this.details = details || []; }
}

function createNsrService({ cfg, records, deliveries, log, now, send }) {
  const clock = now || Date.now;
  const post = send || client.send;
  const say = log || ((line) => console.log(line));
  const inFlight = new Set();
  let timer = null, ticking = false;

  // ---- households -----------------------------------------------------------------
  const build = (serial, groups) => buildHousehold(serial, groups.get(serial) || [], { now: clock(), maxMembers: cfg.maxMembers, allowSynthetic: cfg.allowSynthetic });
  const deliveriesFor = (serial) => Object.values(deliveries.items).filter((d) => d.households.some((h) => h.household_serial === serial))
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
  const brief = (d) => ({ id: d.id, status: d.status, created_at: d.created_at });

  function serialsFrom(body, single) {
    const list = single ? [body && body.household_serial] : body && body.household_serials;
    if (!Array.isArray(list) || !list.length || list.some((s) => typeof s !== 'string' || !SERIAL.test(s))) {
      throw new NsrError(400, 'INVALID_REQUEST', single ? 'Send { "household_serial": "<serial>" }' : 'Send { "household_serials": ["<serial>", ...] }');
    }
    if (new Set(list).size !== list.length) throw new NsrError(400, 'INVALID_REQUEST', 'household_serials has duplicates');
    if (list.length > cfg.maxBatchHouseholds) throw new NsrError(413, 'BATCH_TOO_LARGE', `At most ${cfg.maxBatchHouseholds} households per request (NSR_WEBHOOK_MAX_BATCH_HOUSEHOLDS); split the batch. Nothing was truncated or sent.`);
    return list;
  }
  function formatFrom(body, count) {
    const f = (body && body.batch_format) || (count === 1 ? 'single' : 'records');
    if (!FORMATS.includes(f) || (f === 'single' && count !== 1)) throw new NsrError(400, 'INVALID_REQUEST', `batch_format must be one of ${FORMATS.join(', ')} ("single" only for one household)`);
    return f;
  }

  function listHouseholds(query) {
    const groups = groupHouseholds(records);
    let rows = [...groups.keys()].sort().map((serial) => {
      const h = build(serial, groups);
      const last = deliveriesFor(serial)[0];
      const head = groups.get(serial).find((r) => r.internal_record_id === (h.message && h.message.internal_record_id)) || groups.get(serial)[0];
      return {
        household_serial: serial, status: h.status, members: h.record_ids.length, state_name: head.state_name || null, lga_name: head.lga_name || null,
        errors: h.errors.map((e) => e.code), warnings: h.warnings.length, latest_delivery: last ? brief(last) : null,
      };
    });
    if (query.status) rows = rows.filter((r) => r.status === query.status);
    return { items: rows, total: rows.length };
  }

  // ---- preview ----------------------------------------------------------------------
  function preview(body, view) {
    const serials = serialsFrom(body, false);
    const format = formatFrom(body, serials.length);
    const groups = groupHouseholds(records);
    const built = serials.map((s) => build(s, groups));
    const messages = built.filter((h) => h.message).map((h) => (view === 'full' ? h.message : maskMessage(h.message)));
    const envelope = messages.length ? buildEnvelope({ messages: format === 'single' ? messages.slice(0, 1) : messages, format, messageId: '(assigned at submission)', timestamp: clock(), partnerId: cfg.partnerId, signature: '(NSR_WEBHOOK_SIGNATURE, not shown)' }) : null;
    return {
      status: built.every((h) => h.status === 'READY') ? 'READY' : 'VALIDATION_FAILED',
      webhook_enabled: cfg.enabled,
      view,
      households: built.map((h) => ({
        household_serial: h.household_serial, status: h.status, members: h.record_ids.length, record_ids: h.record_ids,
        errors: h.errors, warnings: h.warnings, content_hash: h.content_hash, deliveries: deliveriesFor(h.household_serial).map(brief),
      })),
      request: envelope ? { method: 'POST', url: cfg.endpoint, headers: { 'Content-Type': 'application/json' }, format, body: envelope } : null,
      body_bytes: envelope ? Buffer.byteLength(JSON.stringify(envelope)) : 0,
    };
  }

  // ---- submit -----------------------------------------------------------------------
  async function submit(body, { single, operator, idempotencyKey }) {
    if (!cfg.enabled) throw new NsrError(503, 'NSR_WEBHOOK_DISABLED', 'The NSIPA Registry webhook is disabled (NSR_WEBHOOK_ENABLED=false). Nothing was sent.');
    if (!body || body.confirm !== true) throw new NsrError(400, 'CONFIRMATION_REQUIRED', 'Preview first, then send "confirm": true to submit');
    const serials = single ? serialsFrom(body, true) : serialsFrom(body, false);
    const format = single ? 'single' : formatFrom(body, serials.length);
    if (idempotencyKey) {
      const prior = Object.values(deliveries.items).find((d) => d.idempotency_key === idempotencyKey);
      if (prior) {
        const same = prior.households.map((h) => h.household_serial).sort().join() === [...serials].sort().join();
        if (!same) throw new NsrError(409, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was used for different households');
        return { status: 200, delivery: summary(prior), replayed: true };
      }
    }
    const groups = groupHouseholds(records);
    const built = serials.map((s) => build(s, groups));
    const invalid = built.filter((h) => h.status !== 'READY');
    if (invalid.length) {
      throw new NsrError(422, 'VALIDATION_FAILED', 'One or more households cannot be sent; nothing was sent', invalid.map((h) => ({ household_serial: h.household_serial, errors: h.errors })));
    }
    const clashes = built.map((h) => clashFor(h, body.resubmit === true)).filter(Boolean);
    if (clashes.length) throw new NsrError(409, 'DUPLICATE_SUBMISSION', 'Already sent or being sent; nothing was sent. A changed household that NSIPA Registry already accepted needs "resubmit": true.', clashes);

    const d = newDelivery(built, format, { operator, idempotencyKey, resubmit: body.resubmit === true, origin: 'manual' });
    const bytes = Buffer.byteLength(JSON.stringify(envelopeFor(d)));
    if (bytes > cfg.maxBodyBytes) throw new NsrError(413, 'BATCH_TOO_LARGE', `The message would be ${bytes} bytes; the limit is ${cfg.maxBodyBytes} (NSR_WEBHOOK_MAX_BODY_BYTES). Split the batch. Nothing was sent.`);
    deliveries.items[d.id] = d;
    deliveries.save();
    deliveries.audit({ action: 'NSR_SUBMITTED', delivery_id: d.id, operator, format, households: d.households.map((h) => h.household_serial), records: recordCount(d), message_id: d.message_id });
    await dispatch(d.id, operator);
    return { status: 201, delivery: summary(deliveries.items[d.id]) };
  }

  // Duplicate protection: one live delivery per household, and no silent resend of an accepted one.
  function clashFor(h, resubmit) {
    for (const d of deliveriesFor(h.household_serial)) {
      const mine = d.households.find((x) => x.household_serial === h.household_serial);
      if (ACTIVE.has(d.status)) return { household_serial: h.household_serial, code: 'DELIVERY_IN_PROGRESS', delivery_id: d.id, status: d.status };
      if (d.status === 'ACCEPTED' && mine.content_hash === h.content_hash) return { household_serial: h.household_serial, code: 'ALREADY_ACCEPTED', delivery_id: d.id, status: d.status };
      if (d.status === 'ACCEPTED' && !resubmit) return { household_serial: h.household_serial, code: 'ACCEPTED_BEFORE_CHANGED', delivery_id: d.id, status: d.status };
    }
    return null;
  }

  function newDelivery(built, format, { operator, idempotencyKey, resubmit, origin, source }) {
    const at = clock();
    return {
      id: 'dlv-' + crypto.randomUUID(),
      status: 'PENDING', format, message_id: newMessageId(), message_timestamp: at,
      households: built.map((h) => ({ household_serial: h.household_serial, record_ids: h.record_ids, content_hash: h.content_hash, synthetic: h.synthetic })),
      messages: built.map((h) => h.message),
      created_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString(), created_by: operator,
      origin, source: source || null,
      idempotency_key: idempotencyKey || null, resubmit: resubmit === true,
      attempts: [], attempt_count: 0, retry_budget_from: 0, next_attempt_at: null, in_flight: false,
      ack: null, correlation_id: null, registry_commit: 'NOT_CONFIRMED', last_reason: null, reconciliation: null,
    };
  }

  // Ready households in message-sized groups, within the household and byte limits.
  function batches(ready) {
    const out = [];
    let group = [], bytes = ENVELOPE_BYTES;
    for (const h of ready) {
      const size = Buffer.byteLength(JSON.stringify(h.message));
      if (group.length && (group.length >= cfg.maxBatchHouseholds || bytes + size > cfg.maxBodyBytes)) { out.push(group); group = []; bytes = ENVELOPE_BYTES; }
      group.push(h);
      bytes += size;
    }
    if (group.length) out.push(group);
    return out;
  }

  // Automatic send: stores the batches and returns at once; the timer sends them, so closing the page does not
  // stop them, and a restart picks them up. Anything not ready is skipped and reported. An accepted household
  // is never resent here, even if it changed: that stays an operator's decision.
  function queue(body, { operator }) {
    if (!cfg.enabled) throw new NsrError(503, 'NSR_WEBHOOK_DISABLED', 'The NSIPA Registry webhook is disabled (NSR_WEBHOOK_ENABLED=false). Nothing was sent.');
    if (!cfg.autoSend) throw new NsrError(503, 'NSR_AUTO_SEND_DISABLED', 'Automatic sending is off (NSR_WEBHOOK_AUTO_SEND=false). Nothing was queued.');
    if (!body || body.confirm !== true) throw new NsrError(400, 'CONFIRMATION_REQUIRED', 'Send "confirm": true to queue households');
    const list = body.household_serials;
    if (!Array.isArray(list) || !list.length || list.length > MAX_QUEUE_SERIALS || list.some((s) => typeof s !== 'string' || !SERIAL.test(s))) {
      throw new NsrError(400, 'INVALID_REQUEST', `Send { "household_serials": ["<serial>", ...] } with at most ${MAX_QUEUE_SERIALS} serials`);
    }
    const source = typeof body.source === 'string' ? body.source.trim().slice(0, 100) : null;
    const groups = groupHouseholds(records);
    const ready = [], skipped = [];
    for (const serial of new Set(list)) {
      const h = build(serial, groups);
      const clash = h.status === 'READY' ? clashFor(h, false) : null;
      if (h.status !== 'READY') skipped.push({ household_serial: serial, codes: h.errors.map((e) => e.code) });
      else if (clash) skipped.push({ household_serial: serial, codes: [clash.code], delivery_id: clash.delivery_id });
      else if (Buffer.byteLength(JSON.stringify(h.message)) + ENVELOPE_BYTES > cfg.maxBodyBytes) skipped.push({ household_serial: serial, codes: ['BATCH_TOO_LARGE'] });
      else ready.push(h);
    }
    const created = batches(ready).map((group) => newDelivery(group, group.length === 1 ? 'single' : 'records', { operator, origin: 'auto', source }));
    for (const d of created) deliveries.items[d.id] = d;
    if (created.length) deliveries.save();
    for (const d of created) deliveries.audit({ action: 'NSR_QUEUED', delivery_id: d.id, operator, format: d.format, households: d.households.map((h) => h.household_serial), records: recordCount(d), message_id: d.message_id });
    if (created.length) setImmediate(() => { tick().catch((e) => say(`nsr send timer error: ${e.message}`)); });
    return { status: 202, body: { queued_households: ready.length, deliveries: created.map(summary), skipped } };
  }
  const recordCount = (d) => d.households.reduce((n, h) => n + h.record_ids.length, 0);

  const envelopeFor = (d) => buildEnvelope({ messages: d.messages, format: d.format, messageId: d.message_id, timestamp: d.message_timestamp, partnerId: cfg.partnerId, signature: cfg.signature });

  function backoff(n) {
    const exp = Math.min(cfg.retryMaxMs, cfg.retryBaseMs * 2 ** Math.max(0, n - 1));
    return Math.round(exp / 2 + Math.random() * (exp / 2)); // "equal jitter": between half and all of the step
  }

  // Sends one delivery once. The in-flight flag is written to disk first, so a crash mid-send is detected on restart.
  async function dispatch(id, actor) {
    const d = deliveries.items[id];
    if (!d || inFlight.has(id)) return;
    inFlight.add(id);
    try {
      d.in_flight = true;
      d.attempt_count += 1;
      d.status = 'PENDING';
      d.updated_at = new Date(clock()).toISOString();
      deliveries.save();
      const r = await post(cfg, JSON.stringify(envelopeFor(d)));
      const at = new Date(clock()).toISOString();
      d.attempts.push({ n: d.attempt_count, at, outcome: r.outcome, http_status: r.httpStatus, duration_ms: r.durationMs, error_code: r.errorCode, reason: r.reason });
      d.last_reason = r.reason;
      if (r.ack) d.ack = r.ack;
      if (r.ack && r.ack.correlation_id) d.correlation_id = r.ack.correlation_id;
      d.next_attempt_at = null;
      if (r.outcome === 'ACCEPTED') d.status = 'ACCEPTED';
      else if (r.outcome === 'REJECTED') d.status = 'REJECTED';
      else if (r.outcome === 'UNCERTAIN') d.status = 'CONFIRMATION_PENDING';
      else if (r.outcome === 'FAILED') d.status = 'DELIVERY_FAILED';
      else if (d.attempt_count - d.retry_budget_from <= cfg.maxRetries) {
        d.status = 'RETRY_SCHEDULED';
        d.next_attempt_at = new Date(clock() + backoff(d.attempt_count - d.retry_budget_from)).toISOString();
      } else {
        d.status = 'DELIVERY_FAILED';
        d.last_reason = `${r.reason}; retries used up (${cfg.maxRetries})`;
      }
      d.in_flight = false;
      d.updated_at = at;
      deliveries.save();
      deliveries.audit({ action: 'NSR_ATTEMPT', delivery_id: id, operator: actor || 'retry-timer', attempt: d.attempt_count, outcome: r.outcome, status: d.status, http_status: r.httpStatus, correlation_id: d.correlation_id, next_attempt_at: d.next_attempt_at });
      // Operational log: identifiers and outcomes only. Never the payload or any field value.
      say(`nsr delivery ${id} attempt ${d.attempt_count} ${r.outcome} -> ${d.status} http=${r.httpStatus === null ? '-' : r.httpStatus} ms=${r.durationMs}${d.correlation_id ? ' correlation=' + d.correlation_id : ''}${r.errorCode ? ' error=' + r.errorCode : ''}`);
    } finally {
      inFlight.delete(id);
    }
  }

  // ---- manual actions ---------------------------------------------------------------
  function get(id) {
    const d = deliveries.items[id];
    if (!d) throw new NsrError(404, 'NOT_FOUND', 'No such delivery');
    return d;
  }

  async function retry(id, body, operator) {
    if (!cfg.enabled) throw new NsrError(503, 'NSR_WEBHOOK_DISABLED', 'The NSIPA Registry webhook is disabled. Nothing was sent.');
    const d = get(id);
    if (inFlight.has(id)) throw new NsrError(409, 'IN_FLIGHT', 'This delivery is being sent right now');
    if (d.status === 'CONFIRMATION_PENDING' && !(body && body.confirm_not_received === true)) {
      throw new NsrError(409, 'CONFIRMATION_REQUIRED', 'The outcome is uncertain. Check NSIPA Registry first: if the household is there, reconcile as ACCEPTED; if not, retry with "confirm_not_received": true');
    }
    if (!['RETRY_SCHEDULED', 'DELIVERY_FAILED', 'CONFIRMATION_PENDING'].includes(d.status)) throw new NsrError(409, 'NOT_RETRYABLE', `A ${d.status} delivery cannot be retried`);
    d.retry_budget_from = d.attempt_count;
    deliveries.audit({ action: 'NSR_MANUAL_RETRY', delivery_id: id, operator, previous_status: d.status });
    await dispatch(id, operator);
    return summary(d);
  }

  function reconcile(id, body, operator) {
    const d = get(id);
    if (d.status !== 'CONFIRMATION_PENDING') throw new NsrError(409, 'NOT_RECONCILABLE', 'Only CONFIRMATION_PENDING deliveries are reconciled');
    const outcome = body && body.outcome;
    const note = body && typeof body.note === 'string' ? body.note.trim().slice(0, 300) : '';
    if (!['ACCEPTED', 'NOT_RECEIVED'].includes(outcome) || note.length < 10) {
      throw new NsrError(400, 'INVALID_REQUEST', 'Send { "outcome": "ACCEPTED" | "NOT_RECEIVED", "note": "<what you checked, at least 10 characters>" }');
    }
    const correlation = body.correlation_id ? String(body.correlation_id).slice(0, 100) : null;
    d.status = outcome === 'ACCEPTED' ? 'ACCEPTED' : 'DELIVERY_FAILED';
    if (correlation) d.correlation_id = correlation;
    d.reconciliation = { at: new Date(clock()).toISOString(), by: operator, outcome, note };
    d.updated_at = d.reconciliation.at;
    deliveries.save();
    deliveries.audit({ action: 'NSR_RECONCILED', delivery_id: id, operator, outcome, status: d.status, correlation_id: d.correlation_id });
    return summary(d);
  }

  // Metadata and result only. The payload is never returned after submission.
  function summary(d) {
    return {
      id: d.id, status: d.status, format: d.format, message_id: d.message_id, created_at: d.created_at, updated_at: d.updated_at, created_by: d.created_by,
      // Deliveries stored before automatic sending have no origin: they were all manual.
      origin: d.origin || 'manual', source: d.source || null, record_count: recordCount(d),
      households: d.households.map((h) => ({ household_serial: h.household_serial, record_ids: h.record_ids, content_hash: h.content_hash })),
      first_attempt_at: d.attempts.length ? d.attempts[0].at : null, last_attempt_at: d.attempts.length ? d.attempts[d.attempts.length - 1].at : null,
      attempt_count: d.attempt_count, next_attempt_at: d.next_attempt_at, last_reason: d.last_reason,
      ack: d.ack, correlation_id: d.correlation_id, registry_commit: d.registry_commit, reconciliation: d.reconciliation,
    };
  }
  function list(query) {
    let rows = Object.values(deliveries.items).sort((a, b) => b.created_at.localeCompare(a.created_at));
    if (query.status) rows = rows.filter((d) => d.status === query.status);
    if (query.household_serial) rows = rows.filter((d) => d.households.some((h) => h.household_serial === query.household_serial));
    const page = Math.max(1, Number(query.page) || 1), size = Math.min(200, Math.max(1, Number(query.page_size) || 50));
    return { items: rows.slice((page - 1) * size, page * size).map(summary), page, page_size: size, total: rows.length, has_more: page * size < rows.length };
  }
  function detail(id) {
    const d = get(id);
    return { ...summary(d), attempts: d.attempts };
  }

  // ---- startup recovery and retry timer -------------------------------------------------
  // A delivery marked in flight when the process stopped may or may not have reached NSR.
  function recover() {
    let n = 0;
    for (const d of Object.values(deliveries.items)) {
      if (!d.in_flight) continue;
      d.in_flight = false;
      d.status = 'CONFIRMATION_PENDING';
      d.last_reason = 'DataBridge stopped while sending; the message may have been received';
      d.updated_at = new Date(clock()).toISOString();
      deliveries.audit({ action: 'NSR_RECOVERED', delivery_id: d.id, operator: 'startup', status: d.status });
      n++;
    }
    if (n) deliveries.save();
    return n;
  }
  async function tick() {
    if (!cfg.enabled || ticking) return 0;
    ticking = true;
    let sent = 0;
    try {
      const due = Object.values(deliveries.items).filter((d) => !d.in_flight && (
        (d.status === 'RETRY_SCHEDULED' && Date.parse(d.next_attempt_at) <= clock()) || (d.status === 'PENDING' && d.attempt_count === 0)));
      for (const d of due) { await dispatch(d.id); sent++; }
    } finally { ticking = false; }
    return sent;
  }
  function start() {
    recover();
    if (!cfg.enabled || timer) return;
    timer = setInterval(() => { tick().catch((e) => say(`nsr send timer error: ${e.message}`)); }, cfg.workerIntervalMs);
    timer.unref();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }

  return { listHouseholds, preview, submit, queue, retry, reconcile, list, detail, recover, tick, start, stop, config: () => publicConfig(cfg) };
}

module.exports = { createNsrService, NsrError };
