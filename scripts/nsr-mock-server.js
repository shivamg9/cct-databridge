// Mock of OpenG2P NSR POST /partner/ingest_data, for tests and local Docker checks. Never use against real data.
//
//   node scripts/nsr-mock-server.js            listens on 0.0.0.0:8090 (MOCK_PORT, MOCK_HOST)
//
// Default answer: HTTP 200 with the specification's ACK shape and a new correlation_id.
// Program the next answers (consumed in order) with:
//   POST /__mock/responses  [{ "status": 503 }, { "status": 200, "body": {...} }, { "delayMs": 5000 }, { "destroy": true }]
// Inspect and reset:
//   GET  /__mock/received   { count, messages: [{ query, headers, body }] }
//   POST /__mock/reset
'use strict';
const http = require('node:http');
const crypto = require('node:crypto');

const ack = () => ({
  signature: 'unsigned-stub-signature',
  header: { version: '1.0.0', message_id: 'res-' + crypto.randomBytes(4).toString('hex'), message_ts: new Date().toISOString(), action: 'on-ingest', status: 'succ', status_reason_code: null, status_reason_message: null },
  message: { ack_status: 'ACK', timestamp: new Date().toISOString(), error: null, correlation_id: crypto.randomBytes(16).toString('hex') },
});

function createMockNsr() {
  const received = [];
  const queue = [];
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://mock');
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/__mock/responses' && req.method === 'POST') { queue.push(...[].concat(JSON.parse(text || '[]'))); return json(res, 200, { queued: queue.length }); }
      if (url.pathname === '/__mock/received') return json(res, 200, { count: received.length, messages: received });
      if (url.pathname === '/__mock/reset' && req.method === 'POST') { received.length = 0; queue.length = 0; return json(res, 200, { reset: true }); }
      if (url.pathname !== '/partner/ingest_data' || req.method !== 'POST') return json(res, 404, { detail: 'Not Found' });
      let body = null;
      try { body = JSON.parse(text); } catch (e) { /* recorded as null */ }
      received.push({ at: new Date().toISOString(), query: Object.fromEntries(url.searchParams), headers: { 'content-type': req.headers['content-type'] }, body });
      const next = queue.shift() || {};
      const answer = () => {
        if (next.destroy) return req.socket.destroy();
        json(res, next.status || 200, next.body !== undefined ? next.body : (next.status || 200) === 200 ? ack() : { detail: `mock error ${next.status}` });
      };
      if (next.delayMs) setTimeout(answer, next.delayMs); else answer();
    });
  });
  return { server, received, queue };
}

if (require.main === module) {
  const { server } = createMockNsr();
  const port = Number(process.env.MOCK_PORT || 8090), host = process.env.MOCK_HOST || '0.0.0.0';
  server.listen(port, host, () => console.log(`Mock NSR on http://${host}:${port}/partner/ingest_data`));
}

module.exports = { createMockNsr, ack };
