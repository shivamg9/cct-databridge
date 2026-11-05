// HTTP client for NSR /partner/ingest_data. Node built-ins only.
// Classifies every result into one outcome, with one rule: retry automatically only when the
// request certainly was not processed. Anything that may have reached NSR is UNCERTAIN and goes to
// manual reconciliation, because a blind resend could create a duplicate household in the registry.
'use strict';
const http = require('node:http');
const https = require('node:https');

const MAX_RESPONSE = 1024 * 1024;
// Failures before any byte reached NSR: safe to send again.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNABORTED']);
// TLS and certificate problems are configuration faults: retrying will not help.
const TLS = /CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/;

// Reason text from NSR is stored, never logged, and long digit runs (IDs, NINs, account numbers) are removed.
const redact = (s) => (s === null || s === undefined ? null : String(s).replace(/\d{6,}/g, '[redacted]').slice(0, 300));

// outcome: ACCEPTED | REJECTED | RETRY | UNCERTAIN | FAILED
function classify(status, body) {
  const ack = body && typeof body === 'object' ? {
    action: body.header && body.header.action, status: body.header && body.header.status,
    status_reason_code: redact(body.header && body.header.status_reason_code), status_reason_message: redact(body.header && body.header.status_reason_message),
    ack_status: body.message && body.message.ack_status, correlation_id: body.message && body.message.correlation_id ? String(body.message.correlation_id).slice(0, 100) : null,
    error: redact(body.message && body.message.error && (body.message.error.message || body.message.error.code || JSON.stringify(body.message.error))),
    response_message_id: body.header && body.header.message_id ? String(body.header.message_id).slice(0, 100) : null,
  } : null;
  if (status >= 200 && status < 300) {
    if (!ack) return { outcome: 'UNCERTAIN', reason: 'NSR answered 2xx without a readable acknowledgement', ack };
    if (ack.ack_status === 'ACK' && (ack.status === undefined || ack.status === 'succ')) return { outcome: 'ACCEPTED', reason: 'NSR acknowledged the message', ack };
    if (ack.ack_status === 'NACK' || ack.ack_status === 'ERR' || (ack.status && ack.status !== 'succ')) return { outcome: 'REJECTED', reason: 'NSR returned a negative acknowledgement', ack };
    return { outcome: 'UNCERTAIN', reason: 'NSR answered 2xx with an unrecognised acknowledgement', ack };
  }
  if (status === 401 || status === 403) return { outcome: 'FAILED', reason: `NSR refused the sender (HTTP ${status}); check partner registration and signature`, ack };
  if (status === 404) return { outcome: 'FAILED', reason: 'NSR endpoint not found (HTTP 404); check the base URL and data model', ack };
  if (status === 408 || status === 429 || status === 502 || status === 503) return { outcome: 'RETRY', reason: `NSR is temporarily unavailable (HTTP ${status})`, ack };
  if (status >= 400 && status < 500) return { outcome: 'REJECTED', reason: `NSR rejected the message (HTTP ${status})`, ack };
  return { outcome: 'UNCERTAIN', reason: `NSR failed while handling the message (HTTP ${status}); it may or may not have been ingested`, ack };
}

// Sends body (a JSON string). Resolves, never rejects: { outcome, reason, httpStatus, ack, durationMs, errorCode }.
function send(cfg, body) {
  const url = new URL(cfg.endpoint);
  const lib = url.protocol === 'https:' ? https : http;
  const started = Date.now();
  return new Promise((resolve) => {
    let written = false, settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ durationMs: Date.now() - started, httpStatus: null, ack: null, errorCode: null, ...r }); } };
    const req = lib.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Accept: 'application/json', 'User-Agent': 'CCT-DataBridge-NSR-Webhook' },
    }, (res) => {
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size <= MAX_RESPONSE) chunks.push(c); });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { /* not JSON */ }
        done({ httpStatus: res.statusCode, ...classify(res.statusCode, parsed) });
      });
      res.on('error', () => done({ httpStatus: res.statusCode, outcome: 'UNCERTAIN', reason: 'The NSR response was cut off' }));
    });
    // 'finish': the whole request body has been handed to the network. From then on the outcome is uncertain.
    req.on('finish', () => { written = true; });
    req.on('error', (e) => {
      const code = e.code || 'ERROR';
      if (TLS.test(code) || TLS.test(e.message || '')) return done({ outcome: 'FAILED', reason: `TLS failure talking to NSR (${code})`, errorCode: code });
      if (code === 'ETIMEDOUT_DB') return done({ outcome: written ? 'UNCERTAIN' : 'RETRY', reason: `No answer from NSR within ${cfg.timeoutMs} ms${written ? '; the message may have been received' : ''}`, errorCode: 'TIMEOUT' });
      if (NOT_SENT.has(code) || !written) return done({ outcome: 'RETRY', reason: `Could not reach NSR (${code})`, errorCode: code });
      return done({ outcome: 'UNCERTAIN', reason: `The connection to NSR failed after the message was sent (${code})`, errorCode: code });
    });
    const timer = setTimeout(() => { const e = new Error('timeout'); e.code = 'ETIMEDOUT_DB'; req.destroy(e); }, cfg.timeoutMs);
    req.end(body);
  });
}

module.exports = { send, classify, redact };
