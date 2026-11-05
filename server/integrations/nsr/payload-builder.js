// The OpenG2P request envelope: { header: { message_id, sender_id, timestamp }, signature, message }.
'use strict';
const crypto = require('node:crypto');

const FORMATS = ['single', 'records', 'array'];

// One message ID per delivery. Retries of the same delivery reuse it, so NSR can recognise a repeat
// (whether it does is an open question for the NSR team).
const newMessageId = () => `CCTDB-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`;

// ISO-8601 UTC without milliseconds, as in the spec examples ("2026-11-04T15:36:27Z").
const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// messages: household objects. format: 'single' (exactly one), 'records' ({ records: [...] }) or 'array' ([...]).
function buildEnvelope({ messages, format, messageId, timestamp, partnerId, signature }) {
  if (!FORMATS.includes(format)) throw new Error(`format must be one of ${FORMATS.join(', ')}`);
  if (format === 'single' && messages.length !== 1) throw new Error('A single submission carries exactly one household');
  if (!messages.length) throw new Error('No households to send');
  if (!signature) throw new Error('signature must be non-empty');
  return {
    header: { message_id: messageId, sender_id: partnerId, timestamp: isoSeconds(timestamp) },
    signature,
    message: format === 'single' ? messages[0] : format === 'records' ? { records: messages } : messages,
  };
}

module.exports = { buildEnvelope, newMessageId, isoSeconds, FORMATS };
