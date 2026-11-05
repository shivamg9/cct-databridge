// Builds the Postman collection and environments in postman/.
// Field names come from prototype/schema.js (generated from the build sheet), never typed by hand.
// Run from the repo root:  node scripts/build-postman.js
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const SCHEMA = require(path.join(root, 'prototype/schema.js'));
const { SYSTEM_DEFAULTS } = require(path.join(root, 'server/records.js'));
const sample = JSON.parse(fs.readFileSync(path.join(root, 'docs/samples/openg2p-push-record.json'), 'utf8'));
const canonical = SCHEMA.fields.map((f) => f.name);
const NSR_IDS = { register: 'a0000000-0000-4000-8000-000000000002', form: 'c1000000-0000-4000-8000-000000000002' };

const lines = (s) => s.trim().split('\n');
const ev = (listen, src) => ({ listen, script: { type: 'text/javascript', exec: lines(src) } });
const url = (p, query) => {
  const raw = '{{base_url}}' + p + (query ? '?' + query.map(([k, v]) => `${k}=${v}`).join('&') : '');
  const u = { raw, host: ['{{base_url}}'], path: p.split('/').filter(Boolean) };
  if (query) u.query = query.map(([key, value]) => ({ key, value }));
  return u;
};
const keyHeader = { key: 'X-API-Key', value: '{{api_key}}' };
const jsonHeader = { key: 'Content-Type', value: 'application/json' };

// Skips a request unless the server reported the given mode in "Health".
const onlyIn = (mode) => `if (pm.collectionVariables.get('server_mode') !== '${mode}') pm.execution.skipRequest();`;

function req(name, { method = 'GET', p, query, headers = [], body, pre, test, description, noauth }) {
  const r = {
    name,
    request: { method, header: [...(noauth ? [] : [keyHeader]), ...headers], url: url(p, query), description },
    event: [],
  };
  if (body !== undefined) {
    r.request.body = { mode: 'raw', raw: body, options: { raw: { language: 'json' } } };
    if (!headers.some((h) => h.key === 'Content-Type')) r.request.header.push(jsonHeader);
  }
  if (pre) r.event.push(ev('prerequest', pre));
  if (test) r.event.push(ev('test', test));
  return r;
}
const folder = (name, description, item) => ({ name, description, item });

// Shared check: each record has exactly the 145 canonical fields, in sheet order.
const CHECK_145 = `
const canonical = JSON.parse(pm.collectionVariables.get('canonical_fields'));
pm.test('Schema lists 145 fields', () => pm.expect(canonical.length).to.eql(145));
pm.test('Every record has exactly the 145 canonical fields', () => b.items.forEach((i) => pm.expect(Object.keys(i.record)).to.eql(canonical)));
pm.test('meta is separate: version, received_at, updated_at, origin', () => b.items.forEach((i) => pm.expect(Object.keys(i.meta).sort()).to.eql(['origin', 'received_at', 'updated_at', 'version'])));
pm.test('view matches expected_view', () => pm.expect(b.view).to.eql(pm.environment.get('expected_view') || pm.collectionVariables.get('expected_view')));`;
const expectedView = `const fullView = (pm.environment.get('expected_view') || pm.collectionVariables.get('expected_view')) === 'full';`;

const recordBody = (patch) => JSON.stringify({ ...sample, internal_record_id: '{{record_id}}', ...patch }, null, 2);

function badPush(name, { change, status, code, field, description, demoOnly }) {
  return req(name, {
    method: 'POST', p: '/api/v1/records', body: '{{bad_body}}', description,
    pre: `
${demoOnly ? onlyIn('demo') + ' // integration mode accepts this record\n' : ''}const r = JSON.parse(pm.collectionVariables.get('sample_record'));
r.internal_record_id = pm.collectionVariables.get('record_id') + '-NEG';
${change}
pm.variables.set('bad_body', JSON.stringify(r));`,
    test: `
pm.test('Status ${status}', () => pm.response.to.have.status(${status}));
const e = pm.response.json().error;
pm.test('Error code ${status === 400 ? 'INVALID_REQUEST' : 'VALIDATION_FAILED'}', () => pm.expect(e.code).to.eql('${status === 400 ? 'INVALID_REQUEST' : 'VALIDATION_FAILED'}'));
pm.test('Detail ${code} on ${field}', () => pm.expect(e.details.some((d) => d.code === '${code}' && d.field === ${field === null ? 'null' : `'${field}'`})).to.be.true);
pm.test('Nothing stored', () => pm.expect(e.message).to.include('nothing was stored'));`,
  });
}
function badQuery(name, query, field) {
  return req(name, {
    p: '/api/v1/records', query,
    test: `
pm.test('Status 400', () => pm.response.to.have.status(400));
const e = pm.response.json().error;
pm.test('INVALID_QUERY', () => pm.expect(e.code).to.eql('INVALID_QUERY'));
pm.test('Names the field ${field}', () => pm.expect(e.details.map((d) => d.field)).to.include('${field}'));`,
  });
}

const collection = {
  info: {
    name: 'CCT DataBridge API',
    description: lines(`
Push/pull API for the OpenG2P integration.

Setup: select an environment and set api_key (Current value only, so it is never synced). For the live demo, get it on the server with:
  k -n cct-databridge get secret databridge-secrets -o jsonpath='{.data.DATABRIDGE_API_KEY}' | base64 -d

expected_view in the environment says what pull should return: "full" when the server runs with DATABRIDGE_UNMASKED_PULL=true (demo), "masked" otherwise.

Run the whole collection in order (Runner). "02 Push" creates fresh synthetic records with IDs PM-TEST-<timestamp> on every run; later folders depend on them. Demo mode accepts synthetic data only (synthetic=true, NINs starting with 99), so never put real beneficiary data here.

"08 Integration mode" runs only against a server in integration mode (use the "Local Integration" environment with full_access_key set); elsewhere it is skipped. Folder 07 needs the nginx frontend, so leave it out for a bare API server.

"09 NSR webhook" previews synthetic test households. Its submit requests run only where the environment sets nsr_submit_allowed = "true" (the Local NSR Mock environment, with nsr_submit_key set); everywhere else they are skipped, so it never sends to a real NSR.`).join('\n'),
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  variable: [
    { key: 'sample_record', value: JSON.stringify(sample) },
    { key: 'canonical_fields', value: JSON.stringify(canonical) },
    { key: 'system_defaults', value: JSON.stringify(Object.keys(SYSTEM_DEFAULTS)) },
    { key: 'expected_view', value: 'full' },
    { key: 'server_mode', value: '' },
    { key: 'record_id', value: '' },
    { key: 'run_started', value: '' },
    { key: 'nsr_enabled', value: '' },
    { key: 'nsr_allow_synthetic', value: '' },
    { key: 'nsr_run', value: '' },
    { key: 'nsr_hh_a', value: '' },
    { key: 'nsr_hh_b', value: '' },
    { key: 'nsr_delivery_id', value: '' },
  ],
  event: [
    ev('test', `
// Every API response carries a trace ID; errors repeat it in the body.
if (pm.request.url.getPath().startsWith('/api/')) {
  pm.test('Has X-Trace-Id', () => pm.expect(pm.response.headers.get('X-Trace-Id')).to.match(/^tr-[0-9a-f]{16}$/));
  pm.test('Cache-Control no-store', () => pm.expect(pm.response.headers.get('Cache-Control')).to.eql('no-store'));
  let b; try { b = pm.response.json(); } catch (e) {}
  if (b && b.error) pm.test('Error traceId matches header', () => pm.expect(b.error.traceId).to.eql(pm.response.headers.get('X-Trace-Id')));
}`),
  ],
  item: [
    folder('01 Health and access', 'No key needed for health. Every /api/v1/records call needs X-API-Key.', [
      req('Health', {
        p: '/api/v1/health', noauth: true,
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('status ok', () => pm.expect(b.status).to.eql('ok'));
pm.test('mode is demo or integration', () => pm.expect(['demo', 'integration']).to.include(b.mode));
pm.test('Nothing but status and mode', () => pm.expect(Object.keys(b).sort()).to.eql(['mode', 'status']));
pm.collectionVariables.set('server_mode', b.mode);`,
      }),
      req('Health - wrong method (405)', {
        method: 'POST', p: '/api/v1/health', noauth: true,
        test: `
pm.test('Status 405', () => pm.response.to.have.status(405));
pm.test('Allow: GET', () => pm.expect(pm.response.headers.get('Allow')).to.eql('GET'));`,
      }),
      req('Pull - no key (401)', {
        p: '/api/v1/records', noauth: true,
        test: `
pm.test('Status 401', () => pm.response.to.have.status(401));
pm.test('UNAUTHORISED', () => pm.expect(pm.response.json().error.code).to.eql('UNAUTHORISED'));
pm.test('No records leaked', () => pm.expect(pm.response.json()).to.not.have.property('items'));`,
      }),
      req('Pull - wrong key (401)', {
        p: '/api/v1/records', noauth: true, headers: [{ key: 'X-API-Key', value: 'not-the-key' }],
        test: `
pm.test('Status 401', () => pm.response.to.have.status(401));
pm.test('UNAUTHORISED', () => pm.expect(pm.response.json().error.code).to.eql('UNAUTHORISED'));`,
      }),
      req('Push - no key (401)', {
        method: 'POST', p: '/api/v1/records', noauth: true, body: recordBody(),
        test: `pm.test('Status 401', () => pm.response.to.have.status(401));`,
      }),
      req('Key is set', {
        p: '/api/v1/records', query: [['page_size', '1']],
        description: 'Fails if api_key in the environment is empty or wrong. Fix it before running the rest.',
        test: `pm.test('api_key accepted (200)', () => pm.response.to.have.status(200));`,
      }),
    ]),
    folder('02 Push (create, repeat, update)', 'Upsert keyed by internal_record_id. Identical repeat returns UNCHANGED; a change bumps the version.', [
      req('Push - create (201)', {
        method: 'POST', p: '/api/v1/records', body: recordBody(),
        pre: `
// New ID per run so the create always returns 201.
pm.collectionVariables.set('record_id', 'PM-TEST-' + Date.now());
pm.collectionVariables.set('run_started', new Date(Date.now() - 5000).toISOString());`,
        test: `
pm.test('Status 201', () => pm.response.to.have.status(201));
const b = pm.response.json();
pm.test('CREATED, version 1', () => { pm.expect(b.status).to.eql('CREATED'); pm.expect(b.version).to.eql(1); });
pm.test('Echoes the ID', () => pm.expect(b.internal_record_id).to.eql(pm.collectionVariables.get('record_id')));
pm.test('Timestamps are ISO', () => { pm.expect(Date.parse(b.received_at)).to.be.a('number').and.not.NaN; pm.expect(b.updated_at).to.eql(b.received_at); });
pm.test('No warnings', () => pm.expect(b.warnings).to.eql([]));`,
      }),
      req('Push - identical repeat (200 UNCHANGED)', {
        method: 'POST', p: '/api/v1/records', body: recordBody(),
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('UNCHANGED, still version 1', () => { pm.expect(b.status).to.eql('UNCHANGED'); pm.expect(b.version).to.eql(1); });`,
      }),
      req('Push - update (200 UPDATED)', {
        method: 'POST', p: '/api/v1/records', body: recordBody({ rooms_occupied: 5 }),
        description: 'Same record with rooms_occupied changed from 4 to 5.',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('UPDATED, version 2', () => { pm.expect(b.status).to.eql('UPDATED'); pm.expect(b.version).to.eql(2); });
pm.test('updated_at moved on', () => pm.expect(Date.parse(b.updated_at)).to.be.above(Date.parse(b.received_at) - 1));`,
      }),
      req('Push - no consent (201 with warning)', {
        method: 'POST', p: '/api/v1/records', body: JSON.stringify({ ...sample, internal_record_id: '{{record_id}}-NOCONSENT', consent_to_share_data: false }, null, 2),
        description: 'Stored, but the response warns that downstream sharing must be restricted.',
        test: `
pm.test('Status 201', () => pm.response.to.have.status(201));
pm.test('CONSENT_NOT_GIVEN warning', () => pm.expect(pm.response.json().warnings.map((w) => w.code)).to.include('CONSENT_NOT_GIVEN'));`,
      }),
    ]),
    folder('03 Pull (145 fields, paging, filters, values)', 'Every record lists all 145 build-sheet fields; a field with no stored value is null. Oldest change first: keep the last updated_at you saw and send it as the next updated_since.', [
      req('Pull - default page', {
        p: '/api/v1/records',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();${CHECK_145}
pm.test('Paging fields', () => { pm.expect(b.page).to.eql(1); pm.expect(b.page_size).to.eql(50); pm.expect(b.total).to.be.a('number'); pm.expect(b.has_more).to.be.a('boolean'); });
pm.test('Oldest change first', () => { const t = b.items.map((i) => i.meta.updated_at); pm.expect(t).to.eql([...t].sort()); });`,
      }),
      req('Pull - page 2 of 5', {
        p: '/api/v1/records', query: [['page', '2'], ['page_size', '5']],
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();${CHECK_145}
pm.test('At most 5 items', () => pm.expect(b.items.length).to.be.at.most(5));
pm.test('page 2, page_size 5', () => { pm.expect(b.page).to.eql(2); pm.expect(b.page_size).to.eql(5); });
pm.test('has_more matches total', () => pm.expect(b.has_more).to.eql(10 < b.total));`,
      }),
      req('Pull - this run\'s record: values and nulls', {
        p: '/api/v1/records', query: [['updated_since', '{{run_started}}'], ['changed_by', 'openg2p-push'], ['page_size', '200']],
        description: 'Finds the record pushed in 02. Full view: every pushed value comes back exactly; masked view: the build-sheet masking applies. Fields that were never pushed are null.',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();${CHECK_145}
${expectedView}
const it = b.items.find((i) => i.record.internal_record_id === pm.collectionVariables.get('record_id'));
pm.test('Pushed record is returned', () => pm.expect(it).to.be.an('object'));
if (it) {
  const r = it.record;
  const sent = Object.assign(JSON.parse(pm.collectionVariables.get('sample_record')), { internal_record_id: pm.collectionVariables.get('record_id'), rooms_occupied: 5 });
  const defaults = JSON.parse(pm.collectionVariables.get('system_defaults'));
  pm.test('meta: version 2, origin openg2p-push', () => { pm.expect(it.meta.version).to.eql(2); pm.expect(it.meta.origin).to.eql('openg2p-push'); });
  pm.test('Fields never pushed are null', () => Object.keys(r).filter((k) => !(k in sent) && !defaults.includes(k)).forEach((k) => pm.expect(r[k], k).to.eql(null)));
  pm.test('System defaults filled', () => { pm.expect(r.record_status).to.eql('ACTIVE'); pm.expect(r.country_code).to.eql('NG'); pm.expect(r.data_source).to.eql('OpenG2P'); });
  pm.test('Low fields unchanged', () => { pm.expect(r.state_name).to.eql('Oyo'); pm.expect(r.rooms_occupied).to.eql(5); pm.expect(r.synthetic).to.eql(true); });
  if (fullView) {
    pm.test('Every pushed value returned exactly, types kept', () => Object.keys(sent).forEach((k) => pm.expect(r[k], k).to.eql(sent[k])));
    pm.test('NIN, BVN unmasked', () => { pm.expect(r.nin).to.eql('99000001035'); pm.expect(r.bvn).to.eql('22000013455'); pm.expect(r.account_number).to.eql('2000017595'); });
    pm.test('Phone, names, birth date unmasked', () => { pm.expect(r.phone_number).to.eql('+2348010038295'); pm.expect(r.given_name).to.eql('Chinedu'); pm.expect(r.family_name).to.eql('Eze'); pm.expect(r.birth_date).to.eql('1990-11-25'); });
    pm.test('No asterisks anywhere', () => pm.expect(JSON.stringify(r)).to.not.include('***'));
  } else {
    pm.test('High: NIN, BVN, account number show last 4', () => { pm.expect(r.nin).to.eql('*******1035'); pm.expect(r.bvn).to.eql('*******3455'); pm.expect(r.account_number).to.eql('******7595'); });
    pm.test('Medium: names first letter, birth year only', () => { pm.expect(r.given_name).to.eql('C******'); pm.expect(r.family_name).to.eql('E***'); pm.expect(r.birth_date).to.eql('1990-**-**'); });
    pm.test('Medium numbers withheld as null: latitude, longitude', () => { pm.expect(r.latitude).to.eql(null); pm.expect(r.longitude).to.eql(null); });
  }
}
pm.test('Every item changed after run_started', () => b.items.forEach((i) => pm.expect(Date.parse(i.meta.updated_at)).to.be.above(Date.parse(pm.collectionVariables.get('run_started')))));`,
      }),
      req('Pull - changed_by=databridge-ingestion, 5 records', {
        p: '/api/v1/records', query: [['changed_by', 'databridge-ingestion'], ['page_size', '5']],
        description: 'Records last changed by DataBridge itself (the seeded demo records). OpenG2P uses changed_by=databridge-ingestion to avoid pulling back its own pushes.',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();${CHECK_145}
${expectedView}
pm.test('Five records when available', () => pm.expect(b.items.length).to.eql(Math.min(5, b.total)));
pm.test('Does not include this run\\'s pushes', () => pm.expect(b.items.map((i) => i.record.internal_record_id).join(',')).to.not.include(pm.collectionVariables.get('record_id')));
pm.test('Seeded records (SR1-...)', () => b.items.forEach((i) => pm.expect(i.record.internal_record_id).to.match(/^SR1-\\d{7}$/)));
pm.test('Absent fields are null, not invented', () => b.items.forEach((i) => pm.expect(Object.values(i.record).filter((v) => v === null).length).to.be.above(0)));
pm.test('Populated values keep their types', () => b.items.forEach((i) => { pm.expect(i.record.synthetic).to.eql(true); if (i.record.member_count !== null) pm.expect(i.record.member_count).to.be.a('number'); }));
if (fullView) {
  pm.test('Synthetic NINs unmasked (99 + 9 digits)', () => b.items.forEach((i) => { if (i.record.nin !== null) pm.expect(i.record.nin).to.match(/^99\\d{9}$/); }));
  pm.test('BVN unmasked when present', () => b.items.forEach((i) => { if (i.record.bvn !== null) pm.expect(i.record.bvn).to.match(/^\\d{11}$/); }));
  pm.test('Phone numbers and names unmasked when present', () => b.items.forEach((i) => ['phone_number', 'given_name', 'family_name', 'household_name'].forEach((k) => { if (i.record[k] !== null) pm.expect(i.record[k], k).to.not.include('*'); })));
  pm.test('At least one NIN present', () => pm.expect(b.items.some((i) => i.record.nin !== null)).to.be.true);
} else {
  pm.test('NINs masked', () => b.items.forEach((i) => { if (i.record.nin !== null) pm.expect(i.record.nin).to.match(/^\\*+\\d{4}$/); }));
}`,
      }),
      req('Pull - changed_by=databridge-ingestion, page 2', {
        p: '/api/v1/records', query: [['changed_by', 'databridge-ingestion'], ['page', '2'], ['page_size', '5']],
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();${CHECK_145}
pm.test('Page 2', () => pm.expect(b.page).to.eql(2));
pm.test('has_more matches total', () => pm.expect(b.has_more).to.eql(10 < b.total));`,
      }),
      req('Pull - nothing newer than now', {
        p: '/api/v1/records', query: [['updated_since', '2999-01-01T00:00:00Z']],
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('Empty page', () => { pm.expect(b.items).to.eql([]); pm.expect(b.total).to.eql(0); pm.expect(b.has_more).to.eql(false); });`,
      }),
    ]),
    folder('04 Push validation errors', 'Each request changes one thing in the sample record. 400 = wrong shape, 422 = failed a build-sheet rule. Nothing is stored.', [
      badPush('Unknown field (400)', { change: "r.favourite_colour = 'blue';", status: 400, code: 'UNKNOWN_FIELD', field: 'favourite_colour', description: 'Only the 145 build-sheet attributes are accepted.' }),
      badPush('Array instead of object (400)', { change: "pm.variables.set('bad_body', JSON.stringify([r])); return;", status: 400, code: 'INVALID_BODY', field: null, description: 'One record per request.' }),
      badPush('Missing internal_record_id (422)', { change: 'delete r.internal_record_id;', status: 422, code: 'REQUIRED_FIELD_MISSING', field: 'internal_record_id' }),
      badPush('Missing mandatory given_name (422)', { change: 'delete r.given_name;', status: 422, code: 'REQUIRED_FIELD_MISSING', field: 'given_name' }),
      badPush('Real-looking NIN in demo mode (422)', { change: "r.nin = '12345678901';", status: 422, code: 'FIELD_VALIDATION_FAILED', field: 'nin', demoOnly: true, description: 'Demo mode accepts synthetic NINs only (starting with 99). Skipped in integration mode.' }),
      badPush('synthetic=false in demo mode (422)', { change: 'r.synthetic = false;', status: 422, code: 'FIELD_VALIDATION_FAILED', field: 'synthetic', demoOnly: true, description: 'Skipped in integration mode.' }),
      badPush('Impossible date 1990-02-31 (422)', { change: "r.birth_date = '1990-02-31';", status: 422, code: 'INVALID_TYPE', field: 'birth_date' }),
      badPush('Gender not in code list (422)', { change: "r.gender = '9';", status: 422, code: 'FIELD_VALIDATION_FAILED', field: 'gender' }),
      badPush('Bad phone format (422)', { change: "r.phone_number = 'abc';", status: 422, code: 'FIELD_VALIDATION_FAILED', field: 'phone_number', description: 'Must match ^(\\+234|0)[789][01]\\d{8}$' }),
      badPush('Masked value pushed back (422)', { change: "r.nin = '*******1035';", status: 422, code: 'MASKED_VALUE', field: 'nin', description: 'Stops a masked pull result from overwriting real data.' }),
      req('Invalid JSON (400)', {
        method: 'POST', p: '/api/v1/records', body: '{"internal_record_id": "PM-BROKEN",',
        test: `
pm.test('Status 400', () => pm.response.to.have.status(400));
pm.test('INVALID_JSON', () => pm.expect(pm.response.json().error.code).to.eql('INVALID_JSON'));`,
      }),
      req('Wrong Content-Type (415)', {
        method: 'POST', p: '/api/v1/records', headers: [{ key: 'Content-Type', value: 'text/plain' }], body: recordBody(),
        test: `
pm.test('Status 415', () => pm.response.to.have.status(415));
pm.test('UNSUPPORTED_MEDIA_TYPE', () => pm.expect(pm.response.json().error.code).to.eql('UNSUPPORTED_MEDIA_TYPE'));`,
      }),
      req('Body over 64 KB (413)', {
        method: 'POST', p: '/api/v1/records', body: '{{big_body}}',
        pre: `pm.variables.set('big_body', JSON.stringify({ internal_record_id: 'PM-BIG', household_address: 'x'.repeat(70 * 1024) }));`,
        test: `
pm.test('Status 413', () => pm.response.to.have.status(413));
pm.test('PAYLOAD_TOO_LARGE from the API', () => pm.expect(pm.response.json().error.code).to.eql('PAYLOAD_TOO_LARGE'));`,
      }),
    ]),
    folder('05 Pull query errors', 'Bad query parameters return 400 INVALID_QUERY.', [
      badQuery('page_size over 200 (400)', [['page_size', '500']], 'page_size'),
      badQuery('page 0 (400)', [['page', '0']], 'page'),
      badQuery('updated_since not a date (400)', [['updated_since', 'yesterday']], 'updated_since'),
      badQuery('changed_by unknown (400)', [['changed_by', 'someone-else']], 'changed_by'),
    ]),
    folder('06 Routing', 'Unknown paths and methods.', [
      req('Unknown endpoint (404)', {
        p: '/api/v1/beneficiaries',
        test: `
pm.test('Status 404', () => pm.response.to.have.status(404));
pm.test('NOT_FOUND', () => pm.expect(pm.response.json().error.code).to.eql('NOT_FOUND'));`,
      }),
      ...['PUT', 'DELETE'].map((m) => req(`${m} records (405)`, {
        method: m, p: '/api/v1/records',
        test: `
pm.test('Status 405', () => pm.response.to.have.status(405));
pm.test('Allow: GET, POST', () => pm.expect(pm.response.headers.get('Allow')).to.eql('GET, POST'));`,
      })),
    ]),
    folder('07 Operator console', 'The web console served by the nginx frontend.', [
      req('Console loads', {
        p: '/', noauth: true,
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
pm.test('HTML', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('text/html'));
pm.test('Security headers', () => { pm.expect(pm.response.headers.get('X-Content-Type-Options')).to.eql('nosniff'); pm.expect(pm.response.headers.get('X-Frame-Options')).to.eql('DENY'); pm.expect(pm.response.headers.get('Referrer-Policy')).to.eql('no-referrer'); });
pm.test('Title', () => pm.expect(pm.response.text()).to.include('CCT DataBridge'));`,
      }),
      ...['app.js', 'engine.js', 'schema.js', 'ui-terms.js'].map((f) => req(`Asset ${f}`, {
        p: '/' + f, noauth: true,
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
pm.test('JavaScript', () => pm.expect(pm.response.headers.get('Content-Type')).to.include('javascript'));`,
      })),
      req('Missing asset (404)', {
        p: '/does-not-exist.js', noauth: true,
        test: `pm.test('Status 404, not the console page', () => pm.response.to.have.status(404));`,
      }),
    ]),
    folder('08 Integration mode: full-access controls', 'Runs only when Health reports mode=integration; skipped on demo servers. The standard key always gets the masked view; unmasked pull needs the separate full-access key AND an X-Access-Purpose header, and is written to the access log. DATABRIDGE_UNMASKED_PULL cannot be used in this mode (the server refuses to start).', [
      req('Standard key gets masked view', {
        p: '/api/v1/records', query: [['page_size', '5']], headers: [{ key: 'X-Access-Purpose', value: 'trying to get everything' }],
        pre: onlyIn('integration'),
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('view masked, even with a purpose header', () => pm.expect(b.view).to.eql('masked'));
pm.test('No unmasked NIN', () => b.items.forEach((i) => { if (i.record.nin !== null) pm.expect(i.record.nin).to.match(/^\\*+\\d{4}$/); }));`,
      }),
      req('Full-access key without purpose (400)', {
        p: '/api/v1/records', noauth: true, headers: [{ key: 'X-API-Key', value: '{{full_access_key}}' }],
        pre: onlyIn('integration'),
        test: `
pm.test('Status 400', () => pm.response.to.have.status(400));
pm.test('PURPOSE_REQUIRED', () => pm.expect(pm.response.json().error.code).to.eql('PURPOSE_REQUIRED'));`,
      }),
      req('Full-access key with short purpose (400)', {
        p: '/api/v1/records', noauth: true, headers: [{ key: 'X-API-Key', value: '{{full_access_key}}' }, { key: 'X-Access-Purpose', value: 'test' }],
        pre: onlyIn('integration'),
        test: `pm.test('Status 400 PURPOSE_REQUIRED', () => { pm.response.to.have.status(400); pm.expect(pm.response.json().error.code).to.eql('PURPOSE_REQUIRED'); });`,
      }),
      req('Full-access key with purpose gets full view', {
        p: '/api/v1/records', query: [['updated_since', '{{run_started}}'], ['page_size', '200']], noauth: true,
        headers: [{ key: 'X-API-Key', value: '{{full_access_key}}' }, { key: 'X-Access-Purpose', value: 'Postman integration check of unmasked pull' }],
        pre: onlyIn('integration'),
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
const canonical = JSON.parse(pm.collectionVariables.get('canonical_fields'));
pm.test('view full', () => pm.expect(b.view).to.eql('full'));
pm.test('145 fields', () => b.items.forEach((i) => pm.expect(Object.keys(i.record)).to.eql(canonical)));
const it = b.items.find((i) => i.record.internal_record_id === pm.collectionVariables.get('record_id'));
pm.test('Stored NIN returned', () => pm.expect(it && it.record.nin).to.eql('99000001035'));`,
      }),
    ]),
    folder('09 NSR webhook', 'Outbound OpenG2P NSR webhook. Pushes two synthetic test households (PM-HH-<timestamp>-A with 2 members, -B with 1), previews them and, only where the environment sets nsr_submit_allowed = "true" (the Local NSR Mock environment), submits them. Submit requests are skipped everywhere else, so this folder never sends to a real NSR.', [
      req('NSR config', {
        p: '/api/v1/nsr/config',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const c = pm.response.json();
pm.test('Partner and IDs from the specification', () => { pm.expect(c.partner_id).to.eql('CCT_DATABRIDGE'); pm.expect(c.data_model).to.eql('CCT_DATABRIDGE_INTAKE'); pm.expect(c.register_id).to.eql('${NSR_IDS.register}'); pm.expect(c.intake_form_id).to.eql('${NSR_IDS.form}'); });
pm.test('Endpoint carries the three query parameters', () => pm.expect(c.endpoint).to.include('/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=${NSR_IDS.register}&intake_form_id=${NSR_IDS.form}'));
pm.test('Secrets are reported as present or absent, never shown', () => { pm.expect(c.signature_configured).to.be.a('boolean'); pm.expect(c).to.not.have.property('signature'); pm.expect(c).to.not.have.property('submit_key'); });
pm.collectionVariables.set('nsr_enabled', String(c.enabled));
pm.collectionVariables.set('nsr_allow_synthetic', String(c.allow_synthetic));`,
      }),
      req('NSR - no key (401)', {
        p: '/api/v1/nsr/households', noauth: true,
        test: `pm.test('Status 401', () => { pm.response.to.have.status(401); pm.expect(pm.response.json().error.code).to.eql('UNAUTHORISED'); });`,
      }),
      req('NSR - wrong key (401)', {
        method: 'POST', p: '/api/v1/nsr/preview', noauth: true, headers: [{ key: 'X-API-Key', value: 'not-the-key' }], body: '{"household_serials":["X"]}',
        test: `pm.test('Status 401', () => pm.response.to.have.status(401));`,
      }),
      ...[['A', 1, 2], ['A', 2, 2], ['B', 1, 1]].map(([hh, m, count]) => req(`NSR - push test household ${hh}, member ${m}`, {
        method: 'POST', p: '/api/v1/records', body: '{{nsr_body}}',
        pre: `
${hh === 'A' && m === 1 ? "pm.collectionVariables.set('nsr_run', String(Date.now()));" : ''}
const run = pm.collectionVariables.get('nsr_run');
const serial = 'PM-HH-' + run + '-${hh}';
pm.collectionVariables.set('nsr_hh_${hh.toLowerCase()}', serial);
const r = JSON.parse(pm.collectionVariables.get('sample_record'));
Object.assign(r, { internal_record_id: serial + '-M${m}', nsr_household_serial: serial, member_count: ${count}, nin: '99' + run.slice(-8) + '${hh === 'A' ? m : 3}' });
${m === 1 ? "Object.assign(r, { relationship_to_head: '1', is_household_head: true });" : "Object.assign(r, { given_name: 'Funke', relationship_to_head: '3', is_household_head: false, marital_status: '5', birth_date: '2012-04-18', phone_number: '+2348010040001' }); delete r.bvn; delete r.account_number; delete r.account_name; delete r.bank_name;"}
pm.variables.set('nsr_body', JSON.stringify(r));`,
        test: `pm.test('Created (201)', () => pm.response.to.have.status(201));`,
      })),
      req('NSR households', {
        p: '/api/v1/nsr/households',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
const a = b.items.find((h) => h.household_serial === pm.collectionVariables.get('nsr_hh_a'));
pm.test('Test household A listed with 2 members', () => { pm.expect(a).to.be.an('object'); pm.expect(a.members).to.eql(2); });
pm.test('Every household has a status', () => b.items.forEach((h) => pm.expect(['READY', 'VALIDATION_FAILED']).to.include(h.status)));
pm.test('No personal values in the list', () => pm.expect(pm.response.text()).to.not.match(/99\\d{9}|\\+234\\d/));`,
      }),
      req('NSR preview - household A', {
        method: 'POST', p: '/api/v1/nsr/preview', body: '{"household_serials":["{{nsr_hh_a}}"]}',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
const h = b.households[0];
const synthOk = pm.collectionVariables.get('nsr_allow_synthetic') === 'true';
pm.test(synthOk ? 'READY' : 'Blocked: synthetic records not allowed here', () => synthOk ? pm.expect(h.status).to.eql('READY') : pm.expect(h.errors.map((e) => e.code)).to.include('SYNTHETIC_NOT_ALLOWED'));
pm.test('Exact endpoint and Content-Type', () => { pm.expect(b.request.url).to.include('/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=${NSR_IDS.register}&intake_form_id=${NSR_IDS.form}'); pm.expect(b.request.headers).to.eql({ 'Content-Type': 'application/json' }); });
const env = b.request.body;
pm.test('Envelope: header, signature, message', () => { pm.expect(Object.keys(env)).to.eql(['header', 'signature', 'message']); pm.expect(env.header.sender_id).to.eql('CCT_DATABRIDGE'); pm.expect(env.header.timestamp).to.match(/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$/); });
pm.test('Signature value is never shown', () => pm.expect(env.signature).to.include('not shown'));
const m = env.message;
pm.test('Single household object', () => { pm.expect(b.request.format).to.eql('single'); pm.expect(m.individual_sn).to.eql(pm.collectionVariables.get('nsr_hh_a')); });
pm.test('Household fields once, members in household_members', () => { pm.expect(m.total_heads).to.eql(2); pm.expect(m.household_members.length).to.eql(2); pm.expect(m.household_members.map((x) => x.relationship)).to.eql(['HEAD', 'CHILD']); });
pm.test('Consent sent explicitly as YES', () => pm.expect(m.consent).to.eql('YES'));
pm.test('Aliases: surname, firstname, sex, maritalstatus, validnin', () => { const x = m.household_members[0]; pm.expect(x.surname).to.eql('Eze'); pm.expect(x.firstname).to.eql('Chinedu'); pm.expect(x.sex).to.eql('MALE'); pm.expect(x.maritalstatus).to.eql('MARRIED'); pm.expect(x.validnin).to.eql('YES'); });
pm.test('Values NSR would default are reported, not invented', () => { pm.expect(m).to.not.have.property('sponsor'); pm.expect(h.warnings.map((w) => w.field)).to.include('sponsor'); });`,
      }),
      req('NSR preview - batch A and B, array format', {
        method: 'POST', p: '/api/v1/nsr/preview', body: '{"household_serials":["{{nsr_hh_a}}","{{nsr_hh_b}}"],"batch_format":"array"}',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('Message is an array of two households', () => { pm.expect(b.request.format).to.eql('array'); pm.expect(b.request.body.message).to.be.an('array').with.lengthOf(2); });`,
      }),
      req('NSR preview - batch, records format', {
        method: 'POST', p: '/api/v1/nsr/preview', body: '{"household_serials":["{{nsr_hh_a}}","{{nsr_hh_b}}"]}',
        test: `pm.test('message.records holds two households', () => pm.expect(pm.response.json().request.body.message.records).to.have.lengthOf(2));`,
      }),
      req('NSR preview - unknown household', {
        method: 'POST', p: '/api/v1/nsr/preview', body: '{"household_serials":["PM-HH-DOES-NOT-EXIST"]}',
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('VALIDATION_FAILED: HOUSEHOLD_NOT_FOUND', () => { pm.expect(b.status).to.eql('VALIDATION_FAILED'); pm.expect(b.households[0].errors[0].code).to.eql('HOUSEHOLD_NOT_FOUND'); });`,
      }),
      req('NSR preview - invalid request (400)', {
        method: 'POST', p: '/api/v1/nsr/preview', body: '{"household_serials":"not-a-list"}',
        test: `pm.test('400 INVALID_REQUEST', () => { pm.response.to.have.status(400); pm.expect(pm.response.json().error.code).to.eql('INVALID_REQUEST'); });`,
      }),
      req('NSR submit - webhook disabled (503)', {
        method: 'POST', p: '/api/v1/nsr/submit', body: '{"household_serial":"{{nsr_hh_a}}","confirm":true}',
        pre: `if (pm.collectionVariables.get('nsr_enabled') !== 'false') pm.execution.skipRequest(); // only where the webhook is off`,
        test: `pm.test('503 NSR_WEBHOOK_DISABLED, nothing sent', () => { pm.response.to.have.status(503); pm.expect(pm.response.json().error.code).to.eql('NSR_WEBHOOK_DISABLED'); });`,
      }),
      req('NSR submit - standard key refused (403)', {
        method: 'POST', p: '/api/v1/nsr/submit', body: '{"household_serial":"{{nsr_hh_a}}","confirm":true}', headers: [{ key: 'X-Operator-Id', value: '{{nsr_operator}}' }],
        pre: `if (pm.collectionVariables.get('nsr_enabled') !== 'true') pm.execution.skipRequest();`,
        test: `pm.test('403 NSR_SUBMIT_FORBIDDEN', () => { pm.response.to.have.status(403); pm.expect(pm.response.json().error.code).to.eql('NSR_SUBMIT_FORBIDDEN'); });`,
      }),
      ...[
        ['NSR submit - single household', '/api/v1/nsr/submit', '{"household_serial":"{{nsr_hh_a}}","confirm":true}', `
pm.test('201', () => pm.response.to.have.status(201));
const d = pm.response.json();
pm.test('ACCEPTED, with the NSR correlation ID', () => { pm.expect(d.status).to.eql('ACCEPTED'); pm.expect(d.correlation_id).to.be.a('string').and.not.empty; pm.expect(d.ack.ack_status).to.eql('ACK'); });
pm.test('An ACK is not registry creation', () => pm.expect(d.registry_commit).to.eql('NOT_CONFIRMED'));
pm.test('Operator recorded', () => pm.expect(d.created_by).to.eql(pm.environment.get('nsr_operator')));
pm.collectionVariables.set('nsr_delivery_id', d.id);`],
        ['NSR submit - duplicate refused (409)', '/api/v1/nsr/submit', '{"household_serial":"{{nsr_hh_a}}","confirm":true}', `
pm.test('409 DUPLICATE_SUBMISSION', () => { pm.response.to.have.status(409); pm.expect(pm.response.json().error.details[0].code).to.eql('ALREADY_ACCEPTED'); });`],
        ['NSR submit - batch (message.records)', '/api/v1/nsr/submit/batch', '{"household_serials":["{{nsr_hh_b}}"],"batch_format":"records","confirm":true}', `
pm.test('201 ACCEPTED, records format', () => { pm.response.to.have.status(201); const d = pm.response.json(); pm.expect(d.status).to.eql('ACCEPTED'); pm.expect(d.format).to.eql('records'); });`],
        ['NSR submit - invalid household (422)', '/api/v1/nsr/submit', '{"household_serial":"PM-HH-DOES-NOT-EXIST","confirm":true}', `
pm.test('422 VALIDATION_FAILED, nothing sent', () => { pm.response.to.have.status(422); pm.expect(pm.response.json().error.details[0].errors[0].code).to.eql('HOUSEHOLD_NOT_FOUND'); });`],
        ['NSR submit - without confirm (400)', '/api/v1/nsr/submit', '{"household_serial":"{{nsr_hh_a}}"}', `
pm.test('400 CONFIRMATION_REQUIRED', () => { pm.response.to.have.status(400); pm.expect(pm.response.json().error.code).to.eql('CONFIRMATION_REQUIRED'); });`],
      ].map(([name, p, body, test]) => req(name, {
        method: 'POST', p, body, noauth: true,
        headers: [{ key: 'X-API-Key', value: '{{nsr_submit_key}}' }, { key: 'X-Operator-Id', value: '{{nsr_operator}}' }],
        pre: `// Never against a real NSR: only where the environment allows it and the webhook is on.
if (pm.environment.get('nsr_submit_allowed') !== 'true' || pm.collectionVariables.get('nsr_enabled') !== 'true') pm.execution.skipRequest();`,
        test,
      })),
      req('NSR deliveries', {
        p: '/api/v1/nsr/deliveries', query: [['household_serial', '{{nsr_hh_a}}']],
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const b = pm.response.json();
pm.test('Paged list', () => { pm.expect(b.items).to.be.an('array'); pm.expect(b.total).to.be.a('number'); });
pm.test('No payloads in the list', () => b.items.forEach((d) => pm.expect(d).to.not.have.property('messages')));
if (pm.environment.get('nsr_submit_allowed') === 'true' && pm.collectionVariables.get('nsr_enabled') === 'true') pm.test('The submitted delivery is listed', () => pm.expect(b.items.map((d) => d.id)).to.include(pm.collectionVariables.get('nsr_delivery_id')));`,
      }),
      req('NSR delivery detail', {
        p: '/api/v1/nsr/deliveries/{{nsr_delivery_id}}',
        pre: `if (!pm.collectionVariables.get('nsr_delivery_id') || pm.environment.get('nsr_submit_allowed') !== 'true') pm.execution.skipRequest();`,
        test: `
pm.test('Status 200', () => pm.response.to.have.status(200));
const d = pm.response.json();
pm.test('Attempts with HTTP status and outcome', () => { pm.expect(d.attempts[0].http_status).to.eql(200); pm.expect(d.attempts[0].outcome).to.eql('ACCEPTED'); });
pm.test('Payload not returned after submission', () => pm.expect(d).to.not.have.property('messages'));`,
      }),
      req('NSR delivery - unknown (404)', {
        p: '/api/v1/nsr/deliveries/dlv-does-not-exist',
        test: `pm.test('404 NOT_FOUND', () => { pm.response.to.have.status(404); pm.expect(pm.response.json().error.code).to.eql('NOT_FOUND'); });`,
      }),
    ]),
  ],
};

const env = (name, base, view, extra) => ({
  name,
  values: [
    { key: 'base_url', value: base, type: 'default', enabled: true },
    { key: 'api_key', value: '', type: 'secret', enabled: true },
    { key: 'expected_view', value: view, type: 'default', enabled: true },
    // NSR submit: the key is entered by hand; submissions run only where nsr_submit_allowed is "true".
    { key: 'nsr_submit_key', value: '', type: 'secret', enabled: true },
    { key: 'nsr_operator', value: 'postman.tester', type: 'default', enabled: true },
    { key: 'nsr_submit_allowed', value: '', type: 'default', enabled: true },
    ...(extra || []),
  ],
  _postman_variable_scope: 'environment',
});

const out = path.join(root, 'postman');
fs.mkdirSync(out, { recursive: true });
const write = (f, v) => fs.writeFileSync(path.join(out, f), JSON.stringify(v, null, 2) + '\n');
write('CCT-DataBridge.postman_collection.json', collection);
write('CCT-DataBridge-Live.postman_environment.json', env('CCT DataBridge - Live', 'https://databridge.openg2p.dpiforall.com', 'full'));
write('CCT-DataBridge-Local.postman_environment.json', env('CCT DataBridge - Local Docker', 'http://127.0.0.1:8080', 'full'));
write('CCT-DataBridge-Local-NSR-Mock.postman_environment.json', {
  ...env('CCT DataBridge - Local NSR Mock', 'http://127.0.0.1:8080', 'full'),
  values: env('', 'http://127.0.0.1:8080', 'full').values.map((v) => (v.key === 'nsr_submit_allowed' ? { ...v, value: 'true' } : v)),
});
write('CCT-DataBridge-Local-Integration.postman_environment.json', env('CCT DataBridge - Local Integration', 'http://127.0.0.1:18081', 'masked',
  [{ key: 'full_access_key', value: '', type: 'secret', enabled: true }]));
const n = (items) => items.reduce((a, i) => a + (i.item ? n(i.item) : 1), 0);
console.log(`postman/: ${n(collection.item)} requests, ${canonical.length} canonical fields`);
