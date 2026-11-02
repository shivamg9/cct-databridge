// Run: node --test tests/
// Push and pull API for OpenG2P: status codes, validation against the build-sheet
// schema, duplicate handling, paging, persistence and the optional API key.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../server/api.js');
const R = require('../server/records.js');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../docs/samples/openg2p-push-record.json'), 'utf8'));
const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cdb-api-')), 'records.json');

async function withServer(opts, fn) {
  const server = createServer(opts);
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  try { await fn(base, server); } finally { await new Promise((ok) => server.close(ok)); }
}
const push = (base, body, headers) => fetch(`${base}/records`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...(headers || {}) }, body: typeof body === 'string' ? body : JSON.stringify(body),
});
const pull = (base, qs, headers) => fetch(`${base}/records${qs || ''}`, { headers });

test('push creates, repeats safely and updates by internal_record_id; the file store persists it', async () => {
  const file = tmpFile();
  await withServer({ dataFile: file }, async (base) => {
    let res = await push(base, SAMPLE);
    assert.equal(res.status, 201);
    assert.ok(res.headers.get('x-trace-id'));
    let body = await res.json();
    assert.deepEqual([body.status, body.internal_record_id, body.version], ['CREATED', 'OG2P-IND-000001', 1]);

    res = await push(base, SAMPLE);
    body = await res.json();
    assert.equal(res.status, 200);
    assert.deepEqual([body.status, body.version], ['UNCHANGED', 1], 'an identical repeat changes nothing');

    res = await push(base, { ...SAMPLE, phone_number: '+2348010000000' });
    body = await res.json();
    assert.deepEqual([res.status, body.status, body.version], [200, 'UPDATED', 2]);
  });
  const reloaded = R.createStore(file);
  assert.equal(reloaded.items['OG2P-IND-000001'].record.phone_number, '+2348010000000');
  assert.equal(reloaded.items['OG2P-IND-000001'].meta.version, 2);
});

test('push fills system fields DataBridge owns and normalises values to the sheet types', async () => {
  await withServer({}, async (base, server) => {
    const res = await push(base, { ...SAMPLE, has_valid_nin: 'yes', gender: 1, household_address: '  72   Market Road ' });
    assert.equal(res.status, 201);
    const rec = server.store.items[SAMPLE.internal_record_id].record;
    assert.deepEqual([rec.record_status, rec.country_code, rec.data_source, rec.synthetic], ['ACTIVE', 'NG', 'OpenG2P', true]);
    assert.deepEqual([rec.has_valid_nin, rec.gender, rec.household_address], [true, '1', '72 Market Road']);
  });
});

test('push rejects invalid records with 422 and field-level reasons, storing nothing', async () => {
  await withServer({}, async (base, server) => {
    const bad = { ...SAMPLE, gender: '7', birth_date: '25/11/1990', member_count: '4', nin: '123', shock_types: ['99'] };
    delete bad.family_name;
    const res = await push(base, bad);
    assert.equal(res.status, 422);
    const { error } = await res.json();
    assert.equal(error.code, 'VALIDATION_FAILED');
    const got = Object.fromEntries(error.details.map((d) => [d.field, d.code]));
    assert.deepEqual(got, {
      gender: 'FIELD_VALIDATION_FAILED', birth_date: 'INVALID_TYPE', member_count: 'INVALID_TYPE',
      nin: 'FIELD_VALIDATION_FAILED', shock_types: 'INVALID_TYPE', family_name: 'REQUIRED_FIELD_MISSING',
    });
    for (const d of error.details) assert.doesNotMatch(d.message, /99000001035|Chinedu/, 'reasons never echo personal values');
    assert.equal(Object.keys(server.store.items).length, 0);

    const noKey = { ...SAMPLE };
    delete noKey.internal_record_id;
    assert.equal((await (await push(base, noKey)).json()).error.details[0].field, 'internal_record_id');
    assert.equal((await push(base, { ...SAMPLE, synthetic: false })).status, 422, 'test data only');
    assert.equal((await push(base, { ...SAMPLE, nin_type: undefined })).status, 422, 'conditional rule: nin_type needed when has_valid_nin');
    assert.equal((await push(base, { ...SAMPLE, family_name: '=HYPERLINK("x")' })).status, 422, 'formula cells rejected');
  });
});

test('push returns a warning, not an error, when consent is not given', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, { ...SAMPLE, consent_to_share_data: false });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).warnings[0].code, 'CONSENT_NOT_GIVEN');
  });
});

test('push answers malformed requests with 400, 413 and 415', async () => {
  await withServer({}, async (base) => {
    const r1 = await push(base, { ...SAMPLE, favourite_colour: 'blue' });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).error.details[0].code, 'UNKNOWN_FIELD', 'no attributes outside the build sheet');
    assert.equal((await push(base, '{not json')).status, 400);
    assert.equal((await push(base, [SAMPLE])).status, 400, 'one record per request');
    assert.equal((await push(base, { ...SAMPLE, household_address: 'x'.repeat(70000) })).status, 413);
    assert.equal((await push(base, SAMPLE, { 'Content-Type': 'text/plain' })).status, 415);
  });
});

test('pull pages records oldest change first and filters by updated_since', async () => {
  await withServer({}, async (base, server) => {
    for (let i = 1; i <= 5; i++) {
      assert.equal((await push(base, { ...SAMPLE, internal_record_id: `OG2P-IND-00000${i}` })).status, 201);
      await new Promise((ok) => setTimeout(ok, 5));
    }
    let body = await (await pull(base, '?page=1&page_size=2')).json();
    assert.deepEqual([body.total, body.items.length, body.has_more, body.page, body.page_size], [5, 2, true, 1, 2]);
    assert.deepEqual(body.items.map((x) => x.record.internal_record_id), ['OG2P-IND-000001', 'OG2P-IND-000002']);
    assert.deepEqual(Object.keys(body.items[0].meta).sort(), ['origin', 'received_at', 'updated_at', 'version']);
    for (const k of Object.keys(body.items[0].record)) assert.ok(R.FIELDS.has(k), `${k} is a build-sheet attribute`);

    body = await (await pull(base, '?page=3&page_size=2')).json();
    assert.deepEqual([body.items.length, body.has_more], [1, false]);

    const since = server.store.items['OG2P-IND-000003'].meta.updated_at;
    body = await (await pull(base, `?updated_since=${encodeURIComponent(since)}`)).json();
    assert.deepEqual(body.items.map((x) => x.record.internal_record_id), ['OG2P-IND-000004', 'OG2P-IND-000005']);

    for (const qs of ['?page=0', '?page_size=500', '?updated_since=yesterday']) assert.equal((await pull(base, qs)).status, 400, qs);
  });
});

test('an API key, when configured, is required on push and pull', async () => {
  await withServer({ apiKey: 'test-only-key' }, async (base) => {
    assert.equal((await push(base, SAMPLE)).status, 401);
    assert.equal((await pull(base)).status, 401);
    assert.equal((await pull(base, '', { 'X-API-Key': 'wrong-key-000' })).status, 401);
    assert.equal((await push(base, SAMPLE, { 'X-API-Key': 'test-only-key' })).status, 201);
    assert.equal((await pull(base, '', { 'X-API-Key': 'test-only-key' })).status, 200);
    assert.equal((await fetch(`${base}/health`)).status, 200, 'health needs no key');
  });
});

test('unknown routes give 404 and unsupported methods give 405', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/nothing`)).status, 404);
    const res = await fetch(`${base}/records`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'GET, POST');
  });
});

test('records from the existing ingestion pipeline pass the same push validation', () => {
  const store = R.createStore(null);
  assert.equal(R.seedFromIngestion(store), 30);
  assert.equal(R.seedFromIngestion(store), 0, 'seeding twice adds nothing');
  for (const it of Object.values(store.items)) {
    assert.equal(it.meta.origin, 'databridge-ingestion');
    assert.match(it.record.internal_record_id, /^SR1-\d{7}$/);
    assert.equal(it.record.synthetic, true);
    assert.deepEqual(R.validateRecord(it.record).errors, []);
  }
});

// ---- Safety controls: run mode, masking, access, direction ----------------------
const { configFromEnv } = require('../server/api.js');
const FULL = { apiKey: 'standard-test-key', fullAccessKey: 'full-test-key-0' };
const H = (key, more) => ({ 'X-API-Key': key, ...(more || {}) });

test('demo mode is the default and integration mode refuses unsafe settings', () => {
  const demo = configFromEnv({}, []);
  assert.deepEqual([demo.mode, demo.host, demo.apiKey], ['demo', '127.0.0.1', null]);
  assert.match(demo.dataFile, /demo-records\.json$/);
  assert.throws(() => configFromEnv({ DATABRIDGE_MODE: 'integration' }), /needs DATABRIDGE_API_KEY/);
  assert.throws(() => configFromEnv({ HOST: '0.0.0.0' }), /non-local address/);
  assert.throws(() => configFromEnv({ DATABRIDGE_MODE: 'integration', DATABRIDGE_API_KEY: 'k' }, ['--seed-demo']), /demo mode only/);
  assert.throws(() => configFromEnv({ DATABRIDGE_API_KEY: 'same', DATABRIDGE_FULL_ACCESS_KEY: 'same' }), /must differ/);
  assert.throws(() => configFromEnv({ DATABRIDGE_MODE: 'production' }), /DATABRIDGE_MODE/);
  const integ = configFromEnv({ DATABRIDGE_MODE: 'integration', DATABRIDGE_API_KEY: 'k', HOST: '0.0.0.0' });
  assert.match(integ.dataFile, /integration-records\.json$/, 'integration data is kept apart from demo data');
});

test('integration mode accepts real records but needs synthetic stated explicitly', async () => {
  await withServer({ mode: 'integration', apiKey: 'k-integration' }, async (base, server) => {
    const noFlag = { ...SAMPLE };
    delete noFlag.synthetic;
    const r1 = await push(base, noFlag, H('k-integration'));
    assert.equal(r1.status, 422);
    assert.equal((await r1.json()).error.details[0].field, 'synthetic');
    assert.equal((await push(base, { ...SAMPLE, synthetic: false }, H('k-integration'))).status, 201);
    assert.equal(server.store.items[SAMPLE.internal_record_id].record.synthetic, false);
    assert.equal((await (await fetch(`${base}/health`)).json()).mode, 'integration');
  });
});

test('pull masks sensitive fields by default, following the sheet', async () => {
  await withServer({}, async (base, server) => {
    await push(base, { ...SAMPLE, pregnant: false, member_religious_group: '1' });
    const body = await (await pull(base)).json();
    assert.equal(body.view, 'masked');
    const rec = body.items[0].record;
    assert.equal(rec.nin, '*******1035');
    assert.equal(rec.bvn, '*******3455');
    assert.equal(rec.account_number, '******7595');
    assert.equal(rec.given_name, 'C******');
    assert.equal(rec.phone_number[0], '+');
    assert.doesNotMatch(rec.phone_number, /\d/);
    assert.equal(rec.birth_date, '1990-**-**');
    for (const k of ['latitude', 'longitude', 'pregnant', 'member_religious_group']) assert.ok(!(k in rec), `${k} withheld`);
    assert.equal(rec.gender, '1', 'low-sensitivity fields are unchanged');
    assert.equal(server.store.items[SAMPLE.internal_record_id].record.nin, '99000001035', 'masking is applied on the way out only');
    for (const [name, rule] of R.MASK) if (rule === 'HIDE') assert.ok(R.FIELDS.get(name).sensitivePersonal);
  });
});

test('unmasked pull needs the separate full-access key and a stated purpose, and is logged', async () => {
  const accessLog = tmpFile() + '.access-log.jsonl';
  await withServer({ ...FULL, accessLog }, async (base) => {
    await push(base, SAMPLE, H(FULL.apiKey));
    let body = await (await pull(base, '', H(FULL.apiKey, { 'X-Access-Purpose': 'trying to get everything' }))).json();
    assert.equal(body.view, 'masked', 'the standard key never sees unmasked data');
    const r = await pull(base, '', H(FULL.fullAccessKey));
    assert.equal(r.status, 400);
    assert.equal((await r.json()).error.code, 'PURPOSE_REQUIRED');
    assert.ok(!fs.existsSync(accessLog));
    body = await (await pull(base, '', H(FULL.fullAccessKey, { 'X-Access-Purpose': 'OpenG2P integration test INT-42' }))).json();
    assert.equal(body.view, 'full');
    assert.equal(body.items[0].record.nin, '99000001035');
    const lines = fs.readFileSync(accessLog, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual([lines[0].purpose, lines[0].count, lines[0].ids], ['OpenG2P integration test INT-42', 1, ['OG2P-IND-000001']]);
    assert.doesNotMatch(JSON.stringify(lines), /99000001035|Chinedu/, 'the log holds IDs, never values');
  });
});

test('a masked value pushed back is rejected, so masking can never overwrite real data', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, { ...SAMPLE, given_name: 'C******' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.details[0].code, 'MASKED_VALUE');
  });
});

test('origin and changed_by separate the two directions and stop push-pull loops', async () => {
  const store = R.createStore(null);
  R.seedFromIngestion(store);
  await withServer({ store }, async (base) => {
    const ingested = { ...store.items['SR1-0000001'].record };
    // OpenG2P echoes an ingested record back unchanged: nothing changes, so nothing new to pull.
    let body = await (await push(base, ingested)).json();
    assert.deepEqual([body.status, body.version], ['UNCHANGED', 1]);
    // OpenG2P edits it: the creator stays, the record is now "changed by OpenG2P" and keeps its data_source.
    const edited = { ...ingested, phone_number: '+2348010000000' };
    delete edited.data_source;
    body = await (await push(base, edited)).json();
    assert.equal(body.status, 'UPDATED');
    const it = store.items['SR1-0000001'];
    assert.deepEqual([it.meta.origin, it.meta.last_changed_by, it.record.data_source], ['databridge-ingestion', 'openg2p-push', 'NASSCO National Social Registry']);
    await push(base, SAMPLE);

    const ids = async (qs) => (await (await pull(base, qs)).json()).items.map((x) => x.record.internal_record_id);
    const fromDataBridge = await ids('?changed_by=databridge-ingestion&page_size=200');
    assert.equal(fromDataBridge.length, 29);
    assert.ok(!fromDataBridge.includes('SR1-0000001') && !fromDataBridge.includes('OG2P-IND-000001'), 'OpenG2P does not read back its own changes');
    assert.deepEqual((await ids('?changed_by=openg2p-push')).sort(), ['OG2P-IND-000001', 'SR1-0000001']);
    const all = (await (await pull(base, '?page_size=200')).json()).items;
    assert.equal(all.find((x) => x.record.internal_record_id === 'OG2P-IND-000001').meta.origin, 'openg2p-push');
    assert.equal((await pull(base, '?changed_by=someone')).status, 400);
  });
});

// ---- Review fixes -----------------------------------------------------------------

test('demo storage refuses real records: non-synthetic NINs, and stores that already hold real records', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, { ...SAMPLE, nin: '12345678901' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.details[0].field, 'nin');
  });
  const store = R.createStore(null);
  assert.equal(R.pushRecord(store, { ...SAMPLE, synthetic: false, nin: '12345678901' }, { mode: 'integration' }).status, 'CREATED');
  assert.throws(() => createServer({ store }), /holds real records/);
  assert.doesNotThrow(() => createServer({ store, mode: 'integration', apiKey: 'k' }));
});

test('record IDs that clash with object built-ins are stored as plain keys', async () => {
  await withServer({}, async (base, server) => {
    for (const id of ['__proto__', 'toString', 'constructor']) {
      const res = await push(base, { ...SAMPLE, internal_record_id: id });
      assert.equal(res.status, 201, id);
    }
    assert.equal((await push(base, { ...SAMPLE, internal_record_id: 'toString' })).status, 200);
    assert.equal(Object.keys(server.store.items).length, 3);
    assert.equal(({}).polluted, undefined);
    assert.equal((await (await pull(base)).json()).total, 3);
  });
});

test('impossible calendar dates are rejected', async () => {
  await withServer({}, async (base) => {
    const res = await push(base, { ...SAMPLE, birth_date: '1990-02-31' });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).error.details[0].field, 'birth_date');
  });
});
