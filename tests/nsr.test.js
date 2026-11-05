// Outbound OpenG2P NSR webhook: mapping, payload, delivery outcomes, idempotency, persistence and security.
// Synthetic data only. Every HTTP call goes to an in-process mock NSR; the real endpoint is never used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const net = require('node:net');
const path = require('node:path');
const { createServer } = require('../server/api.js');
const R = require('../server/records.js');
const SCHEMA = require('../prototype/schema.js');
const { nsrConfigFromEnv } = require('../server/integrations/nsr/config.js');
const { buildHousehold, groupHouseholds, maskMessage, MAPPING } = require('../server/integrations/nsr/household-mapper.js');
const { buildEnvelope } = require('../server/integrations/nsr/payload-builder.js');
const { classify } = require('../server/integrations/nsr/client.js');
const { createMockNsr } = require('../scripts/nsr-mock-server.js');
const F = require('./fixtures/nsr-households.js');

const SPEC = fs.readFileSync(path.join(__dirname, '../docs/architecture/CCT_DataBridge_NSR_Webhook_Specification.md'), 'utf8');
const KEYS = { apiKey: 'test-standard-key', submit: 'test-nsr-submit-key', signature: 'test-signature-value' };
const NOW = Date.parse('2026-11-05T10:00:00Z');
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-nsr-'));

function storeWith(...households) {
  const store = R.createStore(null);
  for (const r of households.flat()) assert.equal(R.pushRecord(store, r, { mode: 'demo' }).ok, true, r.internal_record_id);
  return store;
}
const built = (store, serial, opts) => buildHousehold(serial, groupHouseholds(store).get(serial) || [], { now: NOW, maxMembers: 50, allowSynthetic: true, ...(opts || {}) });

async function withMock(fn) {
  const mock = createMockNsr();
  await new Promise((ok) => mock.server.listen(0, '127.0.0.1', ok));
  mock.base = `http://127.0.0.1:${mock.server.address().port}`;
  try { await fn(mock); } finally { await new Promise((ok) => mock.server.close(ok)); }
}
function nsrCfg(base, extra) {
  return Object.assign(nsrConfigFromEnv({
    NSR_WEBHOOK_ENABLED: 'true', NSR_WEBHOOK_BASE_URL: base, NSR_WEBHOOK_SIGNATURE: KEYS.signature, DATABRIDGE_NSR_SUBMIT_KEY: KEYS.submit,
    NSR_WEBHOOK_ALLOW_SYNTHETIC: 'true', NSR_WEBHOOK_RETRY_BASE_MS: '1000', NSR_WEBHOOK_RETRY_MAX_MS: '1000', NSR_WEBHOOK_MAX_RETRIES: '2',
  }, { apiKey: KEYS.apiKey }), extra || {});
}
async function withApi(opts, fn) {
  const logs = [];
  const clock = { t: NOW };
  const server = createServer({ apiKey: KEYS.apiKey, log: (l) => logs.push(l), now: () => clock.t, ...opts });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const call = async (method, p, body, headers) => {
    const res = await fetch(base + p, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json(), headers: res.headers };
  };
  const std = { 'X-API-Key': KEYS.apiKey };
  const op = { 'X-API-Key': KEYS.submit, 'X-Operator-Id': 'operator.one' };
  try { await fn({ call, std, op, server, logs, clock }); } finally { await new Promise((ok) => server.close(ok)); }
}

// ---- Specification coverage ----------------------------------------------------------

// Every NSR field and accepted key named in the specification, read from its tables.
function specFields() {
  const sections = SPEC.split(/^### Section \d+: /m).slice(1);
  const household = new Map(); const members = new Map();
  const ticks = (s) => [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1].replace(/^"|"$/g, ''));
  sections.forEach((sec, i) => {
    const rows = sec.split('\n').filter((l) => l.startsWith('| `') || l.startsWith('| ') && /`/.test(l));
    if (i === 5) { // assets: flag key and quantity key columns (not the header row)
      for (const l of rows.filter((x) => !x.includes('Ownership Flag Key'))) { const c = l.split('|').map((x) => x.trim()); for (const k of ticks(c[2]).concat(ticks(c[3]))) household.set(k, [k]); }
    } else if (i === 7) { // members: "name (or alias — values)", header row skipped
      for (const l of rows.filter((x) => !x.includes('Accepted Member Fields'))) {
        // Each name, with its "(or `alias` — values)" group consumed so the values are not read as names.
        for (const [, name, group] of l.split('|')[2].matchAll(/`([^`"]+)`(?:\s*\(([^)]*)\))?/g)) {
          const alias = group && group.match(/^or `([^`]+)`/);
          members.set(name, alias ? [name, alias[1]] : [name]);
        }
      }
    } else {
      for (const l of rows) { const c = l.split('|'); const t = ticks(c[1]); if (t.length) household.set(t[0], ticks(c[2]).filter((k) => !/^(true|false)$/.test(k))); }
    }
  });
  return { household, members };
}

test('mapping covers every field and accepted key in the specification, 8 sections', () => {
  const spec = specFields();
  const hh = MAPPING.household.filter((e) => e.section !== 'context');
  assert.deepEqual(hh.map((e) => e.target).sort(), [...spec.household.keys()].sort());
  assert.deepEqual(MAPPING.members.map((e) => e.target).sort(), [...spec.members.keys()].sort());
  assert.equal(hh.length, 121, 'sections 1-7');
  assert.equal(MAPPING.members.length, 81, '81 fields per member');
  assert.deepEqual([...new Set(hh.map((e) => e.section))], ['survey_consent', 'composition_and_headship', 'dwelling_and_services', 'vulnerability_shocks_and_coping', 'household_health_insurance', 'household_assets_inventory', 'household_crops_grown']);
  for (const e of hh) assert.deepEqual([...e.aliases].sort(), [...spec.household.get(e.target)].sort(), `accepted keys for ${e.target}`);
  for (const e of MAPPING.members) assert.deepEqual(e.aliases, spec.members.get(e.target), `accepted keys for member ${e.target}`);
  assert.equal(hh.filter((e) => e.section === 'household_assets_inventory').length, 67, 'spec says 68; its table lists 67 (open question)');
  assert.equal(hh.filter((e) => e.section === 'household_crops_grown').length, 23);
});

test('every one of the 145 canonical fields is mapped or listed as not sent, with a reason', () => {
  const used = new Set();
  for (const e of [...MAPPING.household, ...MAPPING.members]) if (e.source && !e.source.includes('*')) used.add(e.source);
  SCHEMA.fields.filter((f) => f.name.startsWith('asset_') || f.name.startsWith('member_')).forEach((f) => used.add(f.name));
  ['longitude', 'accuracy_m'].forEach((n) => used.add(n));
  for (const f of SCHEMA.fields) assert.ok(used.has(f.name) || MAPPING.not_sent[f.name], `${f.name} accounted for`);
  for (const [k, why] of Object.entries(MAPPING.not_sent)) { assert.ok(R.FIELDS.has(k)); assert.ok(why.length > 5); assert.ok(!used.has(k), `${k} both used and not sent`); }
  for (const e of [...MAPPING.household, ...MAPPING.members]) {
    assert.ok(Object.keys(MAPPING.classifications).includes(e.classification), e.target);
    if (e.source && !e.source.includes('*')) assert.ok(R.FIELDS.has(e.source), `${e.target} source ${e.source} exists`);
    if (['MISSING'].includes(e.classification)) assert.equal(e.transform, 'none');
  }
});

// ---- Mapping --------------------------------------------------------------------------

test('a full household maps every section with documented values, nothing invented', () => {
  const store = storeWith(F.fullHousehold('HH-FULL-0001', 2));
  const h = built(store, 'HH-FULL-0001');
  assert.equal(h.status, 'READY', JSON.stringify(h.errors));
  const m = h.message;
  // Section 1
  assert.deepEqual([m.sponsor, m.other_sponsor, m.consent, m.enumerator, m.community, m.individual_sn, m.hhaddress], ['OTHER', 'Community trust', 'YES', 'ENUM-OYO-01', 'Ward 9 Community', 'HH-FULL-0001', '72 Market Road']);
  assert.ok(!('unlisted_enum' in m) && !('coordinate_source' in m), 'never sent');
  // GPS: the three components, never an invented altitude
  assert.deepEqual([m.latitude, m.longitude, m.accuracy_m, m.gps], [7.44637, 3.96521, 6.4, undefined]);
  // Section 2
  assert.equal(m.total_heads, 2);
  assert.ok(!('disroster' in m));
  // Section 3: codes passed through unchanged (vocabulary unconfirmed)
  assert.deepEqual([m.roof_dwelling, m.floor_dwelling, m.num_room, m.drink_dwelling, m.toilet_dwelling, m.devicetype_dwelling, m.light_dwelling, m.cook_dwelling], ['1', '4', 4, '4', '7', '1', '5', '1']);
  // Section 4
  assert.deepEqual([m.livelihoods, m.other_specify_livelihoods, m.anyshocks, m.shock_type, m.other_specify_shock, m.shock_year, m.mechanism_type, m.other_specify_mechanism, m.mechanism_year],
    ['1', 'Petty trading', 'YES', '1 2', 'Pest attack', '2024', '1 6', 'Borrowed seed', '2025']);
  // Section 5
  assert.deepEqual([m.health_insurance, m.health_insurance_type, m.otherhealth_insurance_type], ['YES', '2', 'Mutual aid']);
  // Section 6: every asset flag and quantity
  F.ASSETS.forEach((a, i) => {
    const e = MAPPING.household.find((x) => x.source === `asset_${a}` && x.transform === 'count_flag');
    const q = MAPPING.household.find((x) => x.source === `asset_${a}` && x.transform === 'count_num');
    assert.equal(m[e.target], i % 3 > 0 ? 'YES' : 'NO', e.target);
    assert.equal(m[q.target], String(i % 3), q.target);
  });
  assert.equal(m.hh_items_list, 'YES');
  // Section 7: every crop
  for (const c of SCHEMA.codeLists.crop) assert.equal(m[c.label], ['3', '10', '20'].includes(c.code) ? 'YES' : 'NO', c.label);
  assert.deepEqual([m.hh_crops_options, m.other_crop, m.other_crop_specify], ['YES', 'YES', 'Pepper']);
  // Section 8: members, head first
  assert.equal(m.household_members.length, 2);
  const head = m.household_members[0];
  assert.deepEqual([head.surname, head.firstname, head.othername, head.relationship, head.sex, head.year, head.month, head.day, head.age, head.maritalstatus, head.birthcertificate],
    ['Eze', 'Chinedu', 'Ade', 'HEAD', 'MALE', 1990, 11, 25, 35, 'MARRIED', 'YES']);
  assert.deepEqual([head.validnin, head.validnintype, head.nin, head.ninsurname, head.ninfirstname, head.ninothername, head.contactno], ['YES', 'NIN', 'HH-FULL-0001'.replace(/\D/g, '') && head.nin, 'Eze', 'Chinedu', 'Ade', '+2348010038295']);
  assert.match(head.nin, /^99\d{9}$/);
  assert.deepEqual([head.bank_name, head.other_bank_name, head.accountname, head.accountno, head.bvn], ['8', 'Microfinance', 'Chinedu Eze', '2000017595', '22000013455']);
  assert.deepEqual([head.b5labour, head.b6labour, head.agriculture, head.mining, head.b6_other], ['4', '1', '5', undefined, 'Seasonal'], 'subsector only under its sector key');
  assert.deepEqual([head.educationalqualification, head.currentlyenrolledinschl, head.outofschoolgrade, head.monthstopschool, head.yearstopschool, head.howfarisschoolenrolled], ['5', 'NO', '12', '6', '2019', '1']);
  assert.deepEqual([head.benefitfromhealthcare, head.howfarishealthcentre, head.muac, head.food_nutrition], ['YES', '2', 24.5, '2 3']);
  assert.deepEqual([head.disability, head.seeing, head.hearing, head.walking, head.remembering, head.selfcare, head.communication, head.chronicallyill, head.chronicallyilltype, head.otherchronicallyilltype],
    ['YES', '2', '1', '3', '1', '1', '4', 'YES', '2 8', 'Asthma']);
  assert.deepEqual([head.socialnetwork_label, head.cooperative, head.religiousgroup, head.businessgroup, head.agegroup, head.other_social_group, head.othergroup], ['YES', 'YES', 'NO', 'NO', 'YES', 'YES', 'Farmers union']);
  for (const k of ['connin', 'contrackid', 'confrim_contactno', 'caccountno', 'cbvn', 'health_problem_label']) assert.ok(!(k in head), `${k} is not invented`);
  const member = m.household_members[1];
  assert.deepEqual([member.relationship, member.maritalstatus], ['CHILD', 'NEVER_MARRIED']);
  assert.ok(!('bvn' in member) && !('pregnant' in member) && !('disability' in member), 'absent member values stay absent');
});

test('code conversions follow the specification, never raw codes that NSR would misread', () => {
  const store = storeWith(F.household('HH-CODE-0001', 3, { member: { gender: '0', relationship_to_head: '4', birth_certificate: '3' }, household: { health_insurance_covered: '2', survey_sponsor: '4' } }));
  const h = built(store, 'HH-CODE-0001');
  const [head, m2] = h.message.household_members;
  assert.equal(head.sex, 'MALE');
  assert.equal(m2.sex, 'FEMALE', 'build-sheet female is "0"; NSR reads "2" as female');
  assert.equal(m2.relationship, 'OTHER');
  assert.equal(m2.birthcertificate, 'NO');
  assert.equal(h.message.sponsor, 'STATE_GOVERNMENT');
  assert.ok(!('health_insurance' in h.message), '"Don\'t know" is not turned into NO');
  const codes = h.warnings.map((w) => `${w.code}:${w.field}`);
  assert.ok(codes.includes('VALUE_GENERALISED:relationship'));
  assert.ok(codes.includes('VALUE_NOT_SENT:health_insurance'));
  assert.ok(codes.includes('NSR_DEFAULT_APPLIES:health_insurance'), 'the operator is told NSR will record NO');
});

test('households are grouped by serial: one member, several members, head first, never mixed', () => {
  const store = storeWith(F.household('HH-ONE-0001', 1), F.household('HH-FOUR-0002', 4).reverse());
  const groups = groupHouseholds(store);
  assert.deepEqual([...groups.keys()].sort(), ['HH-FOUR-0002', 'HH-ONE-0001']);
  const one = built(store, 'HH-ONE-0001');
  assert.deepEqual([one.status, one.message.household_members.length, one.message.total_heads], ['READY', 1, 1]);
  const four = built(store, 'HH-FOUR-0002');
  assert.equal(four.status, 'READY');
  assert.deepEqual(four.message.household_members.map((m) => m.relationship), ['HEAD', 'CHILD', 'CHILD', 'CHILD']);
  assert.equal(four.message.internal_record_id, 'HH-FOUR-0002-M1', 'the head record');
  assert.ok(four.message.household_members.every((m) => !four.record_ids.includes(m.nsr_household_serial)));
  assert.equal(new Set(four.message.household_members.map((m) => m.nin)).size, 4);
});

test('a household is blocked, never guessed, when consent, headship, count, duplicates or values do not line up', () => {
  const cases = [
    ['HH-NOCONS-0001', F.household('HH-NOCONS-0001', 2, { member: { consent_to_share_data: false } }), 'CONSENT_NOT_GIVEN'],
    ['HH-NOHEAD-0002', F.household('HH-NOHEAD-0002', 2, { head: { relationship_to_head: '2', is_household_head: false } }), 'NO_HEAD'],
    ['HH-TWOHEAD-0003', F.household('HH-TWOHEAD-0003', 2, { member: { relationship_to_head: '1', is_household_head: true } }), 'MULTIPLE_HEADS'],
    ['HH-COUNT-0004', F.household('HH-COUNT-0004', 2).map((r) => ({ ...r, member_count: 3 })), 'MEMBER_COUNT_MISMATCH'],
    ['HH-DUP-0005', F.household('HH-DUP-0005', 2).map((r) => ({ ...r, nin: '99123456789' })), 'DUPLICATE_MEMBER'],
    ['HH-CONFL-0006', F.household('HH-CONFL-0006', 2, { member: { household_address: '9 Other Street' } }), 'HOUSEHOLD_FIELD_CONFLICT'],
  ];
  const store = storeWith(...cases.map((c) => c[1]));
  for (const [serial, , code] of cases) {
    const h = built(store, serial);
    assert.equal(h.status, 'VALIDATION_FAILED', serial);
    assert.ok(h.errors.some((e) => e.code === code), `${serial}: ${code} in ${JSON.stringify(h.errors)}`);
    for (const e of h.errors) assert.doesNotMatch(e.message, /99\d{9}|Chinedu|Market Road/, 'reasons never repeat values');
  }
  // Consent missing (not just false), synthetic not allowed, too many members.
  const missing = F.household('HH-NOCONS2-0007', 1).map((r) => { const x = { ...r }; delete x.consent_to_share_data; return x; });
  assert.ok(buildHousehold('X', missing, { now: NOW, allowSynthetic: true }).errors.some((e) => e.code === 'CONSENT_MISSING'));
  assert.ok(built(store, 'HH-CONFL-0006', { allowSynthetic: false }).errors.some((e) => e.code === 'SYNTHETIC_NOT_ALLOWED'));
  assert.ok(built(storeWith(F.household('HH-BIG-0008', 3)), 'HH-BIG-0008', { maxMembers: 2 }).errors.some((e) => e.code === 'TOO_MANY_MEMBERS'));
  assert.equal(built(store, 'HH-NONE-0009').errors[0].code, 'HOUSEHOLD_NOT_FOUND');
  const mixed = [...F.household('HH-MIX-0010', 2)]; mixed[1] = { ...mixed[1], synthetic: false };
  assert.ok(buildHousehold('HH-MIX-0010', mixed, { now: NOW, allowSynthetic: true }).errors.some((e) => e.code === 'MIXED_SYNTHETIC'));
});

test('missing optional values are left out and reported where NSR would fill a default', () => {
  const plain = F.household('HH-PLAIN-0001', 1).map((r) => { const x = { ...r }; delete x.latitude; delete x.longitude; delete x.accuracy_m; delete x.roof_material; return x; });
  const h = built(storeWith(plain), 'HH-PLAIN-0001');
  assert.equal(h.status, 'READY');
  for (const k of ['latitude', 'gps', 'roof_dwelling', 'sponsor', 'anyshocks', 'health_insurance', 'hh_items_list', 'hh_crops_options', 'Cassava']) assert.ok(!(k in h.message), `${k} not invented`);
  const defaults = h.warnings.filter((w) => w.code === 'NSR_DEFAULT_APPLIES').map((w) => w.field).sort();
  assert.deepEqual(defaults, ['anyshocks', 'disroster', 'enumerator', 'gps', 'health_insurance', 'household_crops_grown', 'roof_dwelling', 'sponsor']);
  // Only one of latitude/longitude: neither is sent.
  const half = F.household('HH-HALF-0002', 1).map((r) => { const x = { ...r }; delete x.longitude; return x; });
  const h2 = buildHousehold('HH-HALF-0002', half, { now: NOW, allowSynthetic: true });
  assert.ok(!('latitude' in h2.message));
  assert.ok(h2.warnings.some((w) => w.code === 'VALUE_NOT_SENT' && w.field === 'gps'));
});

test('building a payload never changes stored records, their hashes or push idempotency', () => {
  const store = storeWith(F.fullHousehold('HH-FULL-0002', 2));
  const before = JSON.stringify(store.items);
  const a = built(store, 'HH-FULL-0002');
  const b = buildHousehold('HH-FULL-0002', groupHouseholds(store).get('HH-FULL-0002'), { now: NOW + 400 * 86400000, allowSynthetic: true });
  assert.equal(JSON.stringify(store.items), before);
  assert.equal(a.content_hash, b.content_hash, 'same records, same hash, even a year later');
  assert.notEqual(a.message.household_members[0].age, b.message.household_members[0].age);
  for (const r of F.fullHousehold('HH-FULL-0002', 2)) assert.equal(R.pushRecord(store, r, { mode: 'demo' }).status, 'UNCHANGED');
});

test('masked preview follows the build sheet rules for every value it shows', () => {
  const h = built(storeWith(F.fullHousehold('HH-MASK-0001', 2)), 'HH-MASK-0001');
  const masked = maskMessage(h.message);
  const head = masked.household_members[0];
  assert.deepEqual([head.nin, head.bvn, head.accountno, head.firstname, head.surname], ['*******1001', '*******3455', '******7595', 'C******', 'E***']);
  assert.equal(head.disability, null, 'health: withheld');
  assert.equal(head.religiousgroup, null, 'religion: withheld');
  assert.equal(head.year, null);
  assert.equal(masked.latitude, null);
  assert.equal(head.relationship, 'HEAD');
  assert.equal(h.message.household_members[0].nin.startsWith('99'), true, 'original untouched');
});

// ---- Envelope -------------------------------------------------------------------------

test('the envelope has the required header, sender, timestamp, signature and three message shapes', () => {
  const env = (format, n) => buildEnvelope({ messages: Array.from({ length: n }, (_, i) => ({ n: i })), format, messageId: 'MSG-1', timestamp: NOW, partnerId: 'CCT_DATABRIDGE', signature: 'sig' });
  const single = env('single', 1);
  assert.deepEqual(Object.keys(single), ['header', 'signature', 'message']);
  assert.deepEqual(single.header, { message_id: 'MSG-1', sender_id: 'CCT_DATABRIDGE', timestamp: '2026-11-05T10:00:00Z' });
  assert.deepEqual(single.message, { n: 0 });
  assert.deepEqual(env('records', 2).message, { records: [{ n: 0 }, { n: 1 }] });
  assert.deepEqual(env('array', 2).message, [{ n: 0 }, { n: 1 }]);
  assert.throws(() => env('single', 2), /exactly one/);
  assert.throws(() => buildEnvelope({ messages: [{}], format: 'single', messageId: 'x', timestamp: NOW, partnerId: 'P', signature: '' }), /non-empty/);
});

test('acknowledgements are classified without treating 200 or ACK as registry creation', () => {
  const ackBody = (ack, status) => ({ header: { action: 'on-ingest', status: status || 'succ', status_reason_code: null, status_reason_message: null }, message: { ack_status: ack, correlation_id: 'abc' } });
  assert.equal(classify(200, ackBody('ACK')).outcome, 'ACCEPTED');
  assert.equal(classify(200, ackBody('ACK')).ack.correlation_id, 'abc');
  assert.equal(classify(200, ackBody('NACK', 'rjct')).outcome, 'REJECTED');
  assert.equal(classify(200, null).outcome, 'UNCERTAIN');
  assert.equal(classify(200, { foo: 1 }).outcome, 'UNCERTAIN');
  assert.equal(classify(400, null).outcome, 'REJECTED');
  assert.equal(classify(422, null).outcome, 'REJECTED');
  for (const s of [401, 403, 404]) assert.equal(classify(s, null).outcome, 'FAILED', s);
  for (const s of [408, 429, 502, 503]) assert.equal(classify(s, null).outcome, 'RETRY', s);
  for (const s of [500, 504]) assert.equal(classify(s, null).outcome, 'UNCERTAIN', s);
  const leak = classify(400, { header: { status: 'rjct', status_reason_message: 'NIN 99000001035 invalid' }, message: {} });
  assert.doesNotMatch(JSON.stringify(leak), /99000001035/, 'reason text is redacted');
});

// ---- Configuration --------------------------------------------------------------------

test('configuration: off by default, https only, secrets required when on, keys distinct', () => {
  const off = nsrConfigFromEnv({}, {});
  assert.equal(off.enabled, false);
  assert.equal(off.endpoint, 'https://staff-nsr.openg2p.dpiforall.com/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=a0000000-0000-4000-8000-000000000002&intake_form_id=c1000000-0000-4000-8000-000000000002');
  assert.equal(off.partnerId, 'CCT_DATABRIDGE');
  assert.equal(off.allowSynthetic, false);
  const on = { NSR_WEBHOOK_ENABLED: 'true', NSR_WEBHOOK_SIGNATURE: 's', DATABRIDGE_NSR_SUBMIT_KEY: 'op' };
  assert.throws(() => nsrConfigFromEnv({ ...on, NSR_WEBHOOK_SIGNATURE: '' }, { apiKey: 'k' }), /NSR_WEBHOOK_SIGNATURE/);
  assert.throws(() => nsrConfigFromEnv({ ...on, DATABRIDGE_NSR_SUBMIT_KEY: '' }, { apiKey: 'k' }), /DATABRIDGE_NSR_SUBMIT_KEY/);
  assert.throws(() => nsrConfigFromEnv({ ...on, NSR_WEBHOOK_BASE_URL: 'http://nsr.example.org' }, { apiKey: 'k' }), /https/);
  assert.doesNotThrow(() => nsrConfigFromEnv({ ...on, NSR_WEBHOOK_BASE_URL: 'http://nsr-mock:8090', NSR_WEBHOOK_INSECURE_TEST_ENDPOINT: 'true' }, { apiKey: 'k' }));
  assert.throws(() => nsrConfigFromEnv({ ...on, NSR_WEBHOOK_BASE_URL: 'https://user:pw@nsr.example.org' }, { apiKey: 'k' }), /credentials/);
  assert.throws(() => nsrConfigFromEnv({ ...on, DATABRIDGE_NSR_SUBMIT_KEY: 'k' }, { apiKey: 'k' }), /must differ/);
  assert.throws(() => nsrConfigFromEnv({ NSR_WEBHOOK_ENABLED: 'yes' }, {}), /true or false/);
  assert.throws(() => nsrConfigFromEnv({ NSR_WEBHOOK_TIMEOUT_MS: '5' }, {}), /NSR_WEBHOOK_TIMEOUT_MS/);
});

// ---- API: access and the disabled state --------------------------------------------------

test('every NSR endpoint needs the API key; only the submit key may submit, and it must name the operator', async () => {
  await withMock(async (mock) => {
    await withApi({ store: storeWith(F.household('HH-AUTH-0001', 1)), nsr: nsrCfg(mock.base) }, async ({ call, std, op }) => {
      for (const [m, p] of [['GET', '/nsr/config'], ['GET', '/nsr/households'], ['POST', '/nsr/preview'], ['POST', '/nsr/submit'], ['GET', '/nsr/deliveries']]) {
        assert.equal((await call(m, p, m === 'POST' ? {} : undefined)).status, 401, `${m} ${p} without key`);
        assert.equal((await call(m, p, m === 'POST' ? {} : undefined, { 'X-API-Key': 'wrong-key' })).status, 401);
      }
      const body = { household_serial: 'HH-AUTH-0001', confirm: true };
      const r1 = await call('POST', '/nsr/submit', body, std);
      assert.deepEqual([r1.status, r1.body.error.code], [403, 'NSR_SUBMIT_FORBIDDEN'], 'the standard key cannot submit');
      const r2 = await call('POST', '/nsr/submit', body, { 'X-API-Key': KEYS.submit });
      assert.deepEqual([r2.status, r2.body.error.code], [400, 'OPERATOR_REQUIRED']);
      assert.equal(mock.received.length, 0);
      assert.equal((await call('POST', '/nsr/submit', { household_serial: 'HH-AUTH-0001' }, op)).body.error.code, 'CONFIRMATION_REQUIRED');
      assert.equal((await call('GET', '/nsr/preview', undefined, std)).status, 405);
      assert.equal((await call('GET', '/nsr/unknown', undefined, std)).status, 404);
      assert.equal(mock.received.length, 0, 'nothing reached NSR');
    });
  });
});

test('with the webhook disabled, preview works and nothing is ever sent', async () => {
  await withMock(async (mock) => {
    const cfg = nsrConfigFromEnv({ NSR_WEBHOOK_BASE_URL: mock.base, NSR_WEBHOOK_ALLOW_SYNTHETIC: 'true' }, { apiKey: KEYS.apiKey });
    await withApi({ store: storeWith(F.household('HH-OFF-0001', 1)), nsr: cfg }, async ({ call, std, server }) => {
      const conf = await call('GET', '/nsr/config', undefined, std);
      assert.equal(conf.body.enabled, false);
      const p = await call('POST', '/nsr/preview', { household_serials: ['HH-OFF-0001'] }, std);
      assert.deepEqual([p.status, p.body.status, p.body.webhook_enabled], [200, 'READY', false]);
      const s = await call('POST', '/nsr/submit', { household_serial: 'HH-OFF-0001', confirm: true }, { 'X-API-Key': KEYS.apiKey });
      assert.deepEqual([s.status, s.body.error.code], [503, 'NSR_WEBHOOK_DISABLED']);
      for (const p of ['/nsr/submit/batch', '/nsr/deliveries/dlv-x/retry', '/nsr/deliveries/dlv-x/reconcile']) assert.equal((await call('POST', p, {}, std)).status, 503, p);
      assert.equal(await server.nsr.tick(), 0);
      assert.equal(Object.keys(server.deliveries.items).length, 0);
    });
    assert.equal(mock.received.length, 0);
  });
});

test('seeded demo records and ordinary pulls never trigger a submission', async () => {
  await withMock(async (mock) => {
    const store = R.createStore(null);
    R.seedFromIngestion(store);
    await withApi({ store, nsr: nsrCfg(mock.base) }, async ({ call, std, server }) => {
      assert.equal((await call('GET', '/records?page_size=200', undefined, std)).status, 200);
      assert.equal((await call('POST', '/records', F.SAMPLE, std)).status, 201);
      assert.equal(await server.nsr.tick(), 0);
      const hh = await call('GET', '/nsr/households', undefined, std);
      assert.equal(hh.body.total, 13, 'the pushed sample joins household NSR-HH-000151');
      assert.ok(hh.body.items.some((h) => h.status === 'READY'));
      assert.ok(hh.body.items.find((h) => h.household_serial === 'NSR-HH-000152').errors.includes('CONSENT_NOT_GIVEN'));
      assert.doesNotMatch(JSON.stringify(hh.body), /99\d{9}|\+234/, 'the household list holds no personal values');
    });
    assert.equal(mock.received.length, 0);
  });
});

// ---- API: preview and submission --------------------------------------------------------

test('preview shows the exact request: endpoint, header, masked or full values, never the signature', async () => {
  await withMock(async (mock) => {
    await withApi({ store: storeWith(F.fullHousehold('HH-PREV-0001', 2), F.household('HH-PREV-0002', 1)), nsr: nsrCfg(mock.base) }, async ({ call, std }) => {
      const p = await call('POST', '/nsr/preview', { household_serials: ['HH-PREV-0001', 'HH-PREV-0002'] }, std);
      assert.equal(p.body.status, 'READY');
      assert.equal(p.body.view, 'masked');
      assert.equal(p.body.request.url, `${mock.base}/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=a0000000-0000-4000-8000-000000000002&intake_form_id=c1000000-0000-4000-8000-000000000002`);
      assert.deepEqual(p.body.request.headers, { 'Content-Type': 'application/json' });
      assert.equal(p.body.request.format, 'records');
      assert.equal(p.body.request.body.message.records.length, 2);
      assert.equal(p.body.request.body.header.sender_id, 'CCT_DATABRIDGE');
      assert.doesNotMatch(JSON.stringify(p.body), new RegExp(KEYS.signature), 'signature never shown');
      assert.doesNotMatch(JSON.stringify(p.body), /99\d{9}/, 'masked view');
      const bad = await call('POST', '/nsr/preview', { household_serials: ['HH-NOPE-0009'] }, std);
      assert.deepEqual([bad.body.status, bad.body.households[0].errors[0].code], ['VALIDATION_FAILED', 'HOUSEHOLD_NOT_FOUND']);
      assert.equal((await call('POST', '/nsr/preview', { household_serials: 'x' }, std)).status, 400);
    });
    await withApi({ store: storeWith(F.household('HH-PREV-0003', 1)), nsr: nsrCfg(mock.base), unmaskedPull: true }, async ({ call, std }) => {
      const p = await call('POST', '/nsr/preview', { household_serials: ['HH-PREV-0003'] }, std);
      assert.equal(p.body.view, 'full');
      assert.equal(p.body.request.format, 'single');
      assert.match(p.body.request.body.message.household_members[0].nin, /^99\d{9}$/);
    });
    assert.equal(mock.received.length, 0, 'preview never sends');
  });
});

test('single submission: exact endpoint, header and envelope; ACK recorded with correlation ID, not as registry creation', async () => {
  await withMock(async (mock) => {
    await withApi({ store: storeWith(F.fullHousehold('HH-SUB-0001', 2)), nsr: nsrCfg(mock.base) }, async ({ call, std, op, logs }) => {
      const r = await call('POST', '/nsr/submit', { household_serial: 'HH-SUB-0001', confirm: true }, op);
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.status, r.body.registry_commit, r.body.attempt_count, r.body.created_by], ['ACCEPTED', 'NOT_CONFIRMED', 1, 'operator.one']);
      assert.match(r.body.correlation_id, /^[0-9a-f]{32}$/);
      assert.equal(r.body.ack.ack_status, 'ACK');
      assert.equal(mock.received.length, 1);
      const got = mock.received[0];
      assert.deepEqual(got.query, { data_model: 'CCT_DATABRIDGE_INTAKE', register_id: 'a0000000-0000-4000-8000-000000000002', intake_form_id: 'c1000000-0000-4000-8000-000000000002' });
      assert.equal(got.headers['content-type'], 'application/json');
      assert.equal(got.body.header.sender_id, 'CCT_DATABRIDGE');
      assert.equal(got.body.header.message_id, r.body.message_id);
      assert.match(got.body.header.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      assert.equal(got.body.signature, KEYS.signature);
      assert.equal(got.body.message.individual_sn, 'HH-SUB-0001');
      assert.equal(got.body.message.household_members.length, 2);
      assert.match(got.body.message.household_members[0].nin, /^99\d{9}$/, 'NSR receives real (synthetic) values');
      const d = await call('GET', `/nsr/deliveries/${r.body.id}`, undefined, std);
      assert.deepEqual([d.body.status, d.body.attempts.length, d.body.attempts[0].http_status], ['ACCEPTED', 1, 200]);
      assert.ok(!('messages' in d.body), 'payload is not returned after submission');
      const list = await call('GET', '/nsr/deliveries?household_serial=HH-SUB-0001', undefined, std);
      assert.equal(list.body.total, 1);
      assert.equal(logs.length, 1);
      assert.match(logs[0], /attempt 1 ACCEPTED -> ACCEPTED http=200/);
    });
  });
});

test('batch submission in both batch shapes, one message, one delivery', async () => {
  await withMock(async (mock) => {
    await withApi({ store: storeWith(F.household('HH-B-0001', 2), F.household('HH-B-0002', 1), F.household('HH-B-0003', 3)), nsr: nsrCfg(mock.base) }, async ({ call, op }) => {
      const a = await call('POST', '/nsr/submit/batch', { household_serials: ['HH-B-0001', 'HH-B-0002'], confirm: true }, op);
      assert.deepEqual([a.status, a.body.status, a.body.format, a.body.households.length], [201, 'ACCEPTED', 'records', 2]);
      assert.deepEqual(mock.received[0].body.message.records.map((m) => m.individual_sn), ['HH-B-0001', 'HH-B-0002']);
      const b = await call('POST', '/nsr/submit/batch', { household_serials: ['HH-B-0003'], batch_format: 'array', confirm: true }, op);
      assert.equal(b.body.format, 'array');
      assert.ok(Array.isArray(mock.received[1].body.message));
      assert.equal(mock.received[1].body.message[0].household_members.length, 3);
    });
  });
});

test('invalid households, oversized batches and duplicate submissions are refused before anything is sent', async () => {
  await withMock(async (mock) => {
    const store = storeWith(F.household('HH-D-0001', 1), F.household('HH-D-0002', 2, { member: { consent_to_share_data: false } }), F.household('HH-D-0003', 1), F.household('HH-D-0004', 1));
    await withApi({ store, nsr: nsrCfg(mock.base, { maxBatchHouseholds: 2, maxBodyBytes: 1200 }) }, async ({ call, op }) => {
      const invalid = await call('POST', '/nsr/submit/batch', { household_serials: ['HH-D-0001', 'HH-D-0002'], confirm: true }, op);
      assert.deepEqual([invalid.status, invalid.body.error.code, invalid.body.error.details[0].household_serial], [422, 'VALIDATION_FAILED', 'HH-D-0002']);
      assert.equal((await call('POST', '/nsr/submit/batch', { household_serials: ['HH-D-0001', 'HH-D-0003', 'HH-D-0004'], confirm: true }, op)).body.error.code, 'BATCH_TOO_LARGE');
      const big = await call('POST', '/nsr/submit/batch', { household_serials: ['HH-D-0001', 'HH-D-0003'], confirm: true }, op);
      assert.deepEqual([big.status, big.body.error.code], [413, 'BATCH_TOO_LARGE'], 'body limit, no truncation');
      assert.equal(mock.received.length, 0);

      const first = await call('POST', '/nsr/submit', { household_serial: 'HH-D-0001', confirm: true }, op);
      assert.equal(first.body.status, 'ACCEPTED');
      const again = await call('POST', '/nsr/submit', { household_serial: 'HH-D-0001', confirm: true }, op);
      assert.deepEqual([again.status, again.body.error.details[0].code], [409, 'ALREADY_ACCEPTED']);
      assert.equal(mock.received.length, 1);

      // Idempotency-Key: a repeat returns the same delivery; reuse for other households is refused.
      const k = { ...op, 'Idempotency-Key': 'retry-safe-key-0001' };
      const i1 = await call('POST', '/nsr/submit', { household_serial: 'HH-D-0003', confirm: true }, k);
      const i2 = await call('POST', '/nsr/submit', { household_serial: 'HH-D-0003', confirm: true }, k);
      assert.deepEqual([i1.status, i2.status, i2.body.id], [201, 200, i1.body.id]);
      assert.equal((await call('POST', '/nsr/submit', { household_serial: 'HH-D-0004', confirm: true }, k)).body.error.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal(mock.received.length, 2);
    });
  });
});

test('a household that NSR already accepted and has since changed needs an explicit resubmit', async () => {
  await withMock(async (mock) => {
    const store = storeWith(F.household('HH-RS-0001', 1));
    await withApi({ store, nsr: nsrCfg(mock.base) }, async ({ call, op }) => {
      await call('POST', '/nsr/submit', { household_serial: 'HH-RS-0001', confirm: true }, op);
      R.pushRecord(store, { ...F.household('HH-RS-0001', 1)[0], rooms_occupied: 6 }, { mode: 'demo' });
      const r = await call('POST', '/nsr/submit', { household_serial: 'HH-RS-0001', confirm: true }, op);
      assert.equal(r.body.error.details[0].code, 'ACCEPTED_BEFORE_CHANGED');
      const ok = await call('POST', '/nsr/submit', { household_serial: 'HH-RS-0001', confirm: true, resubmit: true }, op);
      assert.equal(ok.body.status, 'ACCEPTED');
      assert.equal(mock.received[1].body.message.num_room, 6);
    });
  });
});

// ---- Delivery outcomes ------------------------------------------------------------------

async function submitWith(mock, responses, cfgExtra) {
  mock.queue.push(...responses);
  const out = {};
  await withApi({ store: storeWith(F.household('HH-OUT-0001', 1)), nsr: nsrCfg(mock.base, cfgExtra) }, async (api) => {
    out.res = await api.call('POST', '/nsr/submit', { household_serial: 'HH-OUT-0001', confirm: true }, api.op);
    out.api = api;
    if (out.after) await out.after(api);
  });
  return out.res;
}

test('NACK, 400 and 422 are REJECTED; 401, 403 and 404 are DELIVERY_FAILED; none is retried', async () => {
  await withMock(async (mock) => {
    const nack = { header: { action: 'on-ingest', status: 'rjct', status_reason_code: 'rjct.schema', status_reason_message: 'bad' }, message: { ack_status: 'NACK', correlation_id: null } };
    const cases = [[{ status: 200, body: nack }, 'REJECTED'], [{ status: 400 }, 'REJECTED'], [{ status: 422 }, 'REJECTED'], [{ status: 401 }, 'DELIVERY_FAILED'], [{ status: 403 }, 'DELIVERY_FAILED'], [{ status: 404 }, 'DELIVERY_FAILED']];
    for (const [resp, status] of cases) {
      const r = await submitWith(mock, [resp]);
      assert.equal(r.body.status, status, JSON.stringify(resp));
      assert.equal(r.body.next_attempt_at, null);
    }
    assert.equal(mock.received.length, cases.length);
  });
});

test('429 and 503 are retried with backoff until accepted, or until retries run out', async () => {
  await withMock(async (mock) => {
    mock.queue.push({ status: 429 }, { status: 503 });
    await withApi({ store: storeWith(F.household('HH-RT-0001', 1)), nsr: nsrCfg(mock.base) }, async ({ call, op, std, server, clock }) => {
      const r = await call('POST', '/nsr/submit', { household_serial: 'HH-RT-0001', confirm: true }, op);
      assert.equal(r.body.status, 'RETRY_SCHEDULED');
      const wait = Date.parse(r.body.next_attempt_at) - clock.t;
      assert.ok(wait >= 500 && wait <= 1000, `backoff with jitter: ${wait} ms`);
      assert.equal(await server.nsr.tick(), 0, 'not due yet');
      clock.t += 1000;
      await server.nsr.tick();
      assert.equal((await call('GET', `/nsr/deliveries/${r.body.id}`, undefined, std)).body.status, 'RETRY_SCHEDULED');
      clock.t += 1000;
      await server.nsr.tick();
      const d = (await call('GET', `/nsr/deliveries/${r.body.id}`, undefined, std)).body;
      assert.deepEqual([d.status, d.attempt_count, d.attempts.map((a) => a.http_status)], ['ACCEPTED', 3, [429, 503, 200]]);
      assert.equal(new Set(mock.received.map((m) => m.body.header.message_id)).size, 1, 'retries reuse the message ID');
    });
    mock.received.length = 0;
    // Retries used up: DELIVERY_FAILED (dead letter); a manual retry gets a fresh allowance.
    mock.queue.push({ status: 503 }, { status: 503 }, { status: 503 });
    await withApi({ store: storeWith(F.household('HH-RT-0002', 1)), nsr: nsrCfg(mock.base) }, async ({ call, op, server, clock }) => {
      const r = await call('POST', '/nsr/submit', { household_serial: 'HH-RT-0002', confirm: true }, op);
      for (let i = 0; i < 3; i++) { clock.t += 1000; await server.nsr.tick(); }
      const d = server.deliveries.items[r.body.id];
      assert.deepEqual([d.status, d.attempt_count], ['DELIVERY_FAILED', 3]);
      assert.match(d.last_reason, /retries used up/);
      const m = await call('POST', `/nsr/deliveries/${r.body.id}/retry`, undefined, op);
      assert.deepEqual([m.status, m.body.status, m.body.attempt_count], [200, 'ACCEPTED', 4]);
    });
  });
});

test('500, 504, a timeout or a dropped connection are uncertain: no automatic resend, operator reconciles', async () => {
  await withMock(async (mock) => {
    for (const resp of [{ status: 500 }, { status: 504 }, { destroy: true }, { delayMs: 1500 }]) {
      const r = await submitWith(mock, [resp], { timeoutMs: 1000 });
      assert.equal(r.body.status, 'CONFIRMATION_PENDING', JSON.stringify(resp));
      assert.equal(r.body.next_attempt_at, null);
    }
    mock.queue.length = 0;
    mock.queue.push({ status: 500 });
    await withApi({ store: storeWith(F.household('HH-UN-0001', 1), F.household('HH-UN-0002', 1)), nsr: nsrCfg(mock.base) }, async ({ call, op, server, clock }) => {
      const r = await call('POST', '/nsr/submit', { household_serial: 'HH-UN-0001', confirm: true }, op);
      clock.t += 3600000;
      assert.equal(await server.nsr.tick(), 0, 'never resent by the timer');
      assert.equal((await call('POST', '/nsr/submit', { household_serial: 'HH-UN-0001', confirm: true }, op)).body.error.details[0].code, 'DELIVERY_IN_PROGRESS');
      assert.equal((await call('POST', `/nsr/deliveries/${r.body.id}/retry`, {}, op)).body.error.code, 'CONFIRMATION_REQUIRED');
      assert.equal((await call('POST', `/nsr/deliveries/${r.body.id}/reconcile`, { outcome: 'ACCEPTED', note: 'short' }, op)).status, 400);
      const rec = await call('POST', `/nsr/deliveries/${r.body.id}/reconcile`, { outcome: 'ACCEPTED', note: 'Found in NSR Household Register on 5 Nov', correlation_id: 'abc123' }, op);
      assert.deepEqual([rec.body.status, rec.body.correlation_id, rec.body.reconciliation.by], ['ACCEPTED', 'abc123', 'operator.one']);
      // Not received: confirm, then resend.
      mock.queue.push({ status: 504 });
      const r2 = await call('POST', '/nsr/submit', { household_serial: 'HH-UN-0002', confirm: true }, op);
      const again = await call('POST', `/nsr/deliveries/${r2.body.id}/retry`, { confirm_not_received: true }, op);
      assert.equal(again.body.status, 'ACCEPTED');
    });
  });
});

test('an unreachable NSR is retried later (nothing was sent)', async () => {
  const port = await new Promise((ok) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });
  await withApi({ store: storeWith(F.household('HH-NET-0001', 1)), nsr: nsrCfg(`http://127.0.0.1:${port}`) }, async ({ call, op }) => {
    const r = await call('POST', '/nsr/submit', { household_serial: 'HH-NET-0001', confirm: true }, op);
    assert.equal(r.body.status, 'RETRY_SCHEDULED');
    assert.match(r.body.last_reason, /ECONNREFUSED/);
  });
});

test('delivery state survives a restart; a crash mid-send becomes CONFIRMATION_PENDING', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'demo-nsr-deliveries.json');
  await withMock(async (mock) => {
    const store = storeWith(F.household('HH-PER-0001', 1));
    mock.queue.push({ status: 503 });
    let id;
    await withApi({ store, nsr: nsrCfg(mock.base), nsrDeliveryFile: file }, async ({ call, op }) => {
      id = (await call('POST', '/nsr/submit', { household_serial: 'HH-PER-0001', confirm: true }, op)).body.id;
    });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[id].status, 'RETRY_SCHEDULED');
    await withApi({ store, nsr: nsrCfg(mock.base), nsrDeliveryFile: file }, async ({ call, std, server, clock }) => {
      assert.equal((await call('GET', `/nsr/deliveries/${id}`, undefined, std)).body.status, 'RETRY_SCHEDULED', 'reloaded');
      clock.t += 1000;
      await server.nsr.tick();
      assert.equal(server.deliveries.items[id].status, 'ACCEPTED');
    });
    // Simulate a crash while sending.
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    Object.assign(saved[id], { status: 'PENDING', in_flight: true });
    fs.writeFileSync(file, JSON.stringify(saved));
    await withApi({ store, nsr: nsrCfg(mock.base), nsrDeliveryFile: file }, async ({ server }) => {
      assert.equal(server.deliveries.items[id].status, 'CONFIRMATION_PENDING');
      assert.equal(await server.nsr.tick(), 0);
    });
    assert.equal(mock.received.length, 2);
    const audit = fs.readFileSync(file + '.audit.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(audit.map((a) => a.action), ['NSR_SUBMITTED', 'NSR_ATTEMPT', 'NSR_ATTEMPT', 'NSR_RECOVERED']);
  });
});

test('logs and the audit trail hold identifiers and outcomes only, never personal values or secrets', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'demo-nsr-deliveries.json');
  await withMock(async (mock) => {
    mock.queue.push({ status: 400, body: { header: { status: 'rjct', status_reason_message: 'nin 99000001001 rejected' }, message: { ack_status: 'NACK' } } });
    await withApi({ store: storeWith(F.fullHousehold('HH-LOG-0001', 2)), nsr: nsrCfg(mock.base), nsrDeliveryFile: file }, async ({ call, op, logs }) => {
      await call('POST', '/nsr/submit', { household_serial: 'HH-LOG-0001', confirm: true }, op);
      await call('POST', '/nsr/submit', { household_serial: 'HH-LOG-0001', confirm: true }, op);
      const text = logs.join('\n') + fs.readFileSync(file + '.audit.jsonl', 'utf8');
      for (const secret of [/99\d{9}/, /\+234\d+/, /22000013455/, /2000017595/, /Chinedu/, /Market Road/, new RegExp(KEYS.signature), new RegExp(KEYS.submit), new RegExp(KEYS.apiKey)]) {
        assert.doesNotMatch(text, secret);
      }
      const stored = JSON.stringify(Object.values(JSON.parse(fs.readFileSync(file, 'utf8')))[0].ack);
      assert.doesNotMatch(stored, /99000001001/, 'NSR reason text is redacted before it is stored');
    });
  });
});

test('config endpoint shows settings without secrets', async () => {
  await withMock(async (mock) => {
    await withApi({ nsr: nsrCfg(mock.base) }, async ({ call, std }) => {
      const c = (await call('GET', '/nsr/config', undefined, std)).body;
      assert.deepEqual([c.enabled, c.partner_id, c.signature_configured, c.submit_key_configured, c.allow_synthetic], [true, 'CCT_DATABRIDGE', true, true, true]);
      assert.doesNotMatch(JSON.stringify(c), new RegExp(`${KEYS.signature}|${KEYS.submit}|${KEYS.apiKey}`));
    });
  });
});

test('docs/api/nsr-field-mapping.md is generated from mapping.json and up to date', () => {
  const { render, OUT } = require('../scripts/build-nsr-mapping-doc.js');
  assert.equal(fs.readFileSync(OUT, 'utf8'), render(), 'run: node scripts/build-nsr-mapping-doc.js');
});
