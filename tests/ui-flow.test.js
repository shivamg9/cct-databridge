// Run: node --test tests/
// UI regression tests for the simplified console. They drive the real prototype in jsdom.
// jsdom is not bundled with this project: install it (npm i jsdom) or point NODE_PATH at a copy.
// Without it these tests are reported as skipped, never as passed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

let JSDOM = null;
try { ({ JSDOM } = require('jsdom')); } catch (_) { /* skipped below */ }
const skip = JSDOM ? false : 'jsdom not installed';
const ROOT = path.join(__dirname, '../prototype');
const CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script src="[^"]+"><\/script>/g, '');
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${src}</body></html>`, { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/index.html' });
  const w = dom.window;
  const errors = [];
  w.console.error = (...a) => errors.push(a.join(' '));
  w.scrollTo = () => {};
  for (const f of ['schema.js', 'engine.js', 'ui-terms.js', 'app.js']) w.eval(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  const d = w.document;
  const $ = (sel) => d.querySelector(sel);
  const $$ = (sel) => [...d.querySelectorAll(sel)];
  const click = (sel) => { const el = typeof sel === 'string' ? $(sel) : sel; assert.ok(el, `missing ${sel}`); el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); };
  const role = (v) => { const el = $('#role'); el.value = v; el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const text = () => $('main.content').textContent.replace(/\s+/g, ' ');
  const nav = () => $$('.nav-btn').map((b) => b.firstChild.textContent.trim());
  const button = (label) => $$('main button').find((b) => b.textContent.trim().startsWith(label));
  const failed = () => /failed to render/.test(text());
  async function until(fn, ms) { const end = Date.now() + (ms || 15000); while (Date.now() < end) { if (fn()) return; await sleep(100); } assert.fail('timed out'); }
  return { w, d, $, $$, click, role, text, nav, button, failed, until, errors };
}

test('operators see four plain sections at most, and no Settings', { skip }, () => {
  const u = boot();
  assert.deepEqual(u.nav(), ['Home', 'Add Records', 'Transfers'], 'opens as Operator');
  assert.equal(u.$('h1').textContent, 'Home');
  assert.deepEqual(u.$$('.kpis-3 .kpi .k').map((k) => k.textContent), ['Records received', 'Records transferred', 'Needs Attention']);
  assert.match(u.text(), /need(s)? attention\./, 'Home shows a plain attention alert');
  assert.ok(u.button('Add Records'), 'one clear primary action');
  assert.doesNotMatch(u.text(), CODE, 'no raw codes on Home');
  // Asking for an admin page directly still lands on Home.
  u.d.body.insertAdjacentHTML('beforeend', '<button id="sneak" data-act="nav" data-arg="sources"></button>');
  u.click('#sneak');
  assert.equal(u.$('h1').textContent, 'Home');
  u.role('PLATFORM_ADMIN');
  assert.deepEqual(u.nav(), ['Home', 'Add Records', 'Transfers', 'Settings']);
  u.role('READ_ONLY');
  assert.ok(!u.nav().includes('Settings'));
  assert.ok(u.button('Add Records').disabled, 'read-only cannot start transfers');
  assert.deepEqual(u.errors, []);
});

test('a file transfer takes three steps: source, upload, review and submit', { skip }, async () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="ingest"]');
  assert.equal(u.$$('.step-chip').length, 3);
  u.click('[data-act="wiz-source"][data-arg="SRC-LGA-UPLOAD"]');
  assert.match(u.$('.step-chip[aria-current="step"]').textContent, /Upload or Receive/, 'single-method source skips the method choice');
  u.click('[data-act="wiz-sample"][data-arg="good"]');
  assert.match(u.$('.step-chip[aria-current="step"]').textContent, /Review and Submit/, 'checks run automatically');
  assert.match(u.text(), /20 records checked\. 20 valid\./);
  u.click(u.button('Submit 20 Records'));
  await u.until(() => /Transfer (completed|processing)/.test(u.text()));
  assert.match(u.text(), /20 records transferred\./);
  assert.ok(u.button('Done'));
  u.click(u.button('Done'));
  assert.equal(u.$('h1').textContent, 'Home');
  assert.doesNotMatch(u.text(), CODE);
  assert.deepEqual(u.errors, []);
});

test('records needing correction are summarised, and submitting the rest needs a tick', { skip }, async () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="ingest"]');
  u.click('[data-act="wiz-source"][data-arg="SRC-LGA-UPLOAD"]');
  u.click('[data-act="wiz-sample"][data-arg="duplicates"]');
  const m = /(\d+) records checked\. (\d+) valid\. (\d+) need correction\./.exec(u.text());
  assert.ok(m, u.text().slice(0, 300));
  assert.equal(Number(m[1]), Number(m[2]) + Number(m[3]));
  const submit = u.$('[data-act="wiz-start"]');
  assert.ok(submit.disabled, 'excluded records must be acknowledged first');
  u.click(u.button('View Issues'));
  assert.match(u.text(), /Duplicate in file/);
  const ack = u.$('#wiz-ack'); ack.checked = true; ack.dispatchEvent(new u.w.Event('change', { bubbles: true }));
  assert.ok(!u.$('[data-act="wiz-start"]').disabled);
  u.click('[data-act="wiz-start"]');
  await u.until(() => /Transfer (completed|needs attention|processing)/.test(u.text()));
  assert.ok(u.button('View Issues') || u.button('View Details'));
});

test('unsafe or mismatched files stop with a short reason', { skip }, () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="ingest"]');
  u.click('[data-act="wiz-source"][data-arg="SRC-LGA-UPLOAD"]');
  u.click('[data-act="wiz-sample"][data-arg="malicious"]');
  assert.match(u.text(), /File not accepted/);
  assert.match(u.$('.step-chip[aria-current="step"]').textContent, /Upload or Receive/, 'a quarantined file is never checked or sent');
  u.click('[data-act="wiz-sample"][data-arg="drift"]');
  assert.match(u.text(), /Schema mismatch/);
  assert.ok(!u.$('[data-act="wiz-start"]'), 'nothing to submit');
  assert.ok(u.button('Try Again'));
});

test('an API source offers Upload or Receive, then reviews before submit', { skip }, () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="ingest"]');
  u.click('[data-act="wiz-source"][data-arg="SRC-NSR-NASSCO"]');
  assert.ok(u.$('[data-act="wiz-mode"][data-arg="API"]') && u.$('[data-act="wiz-mode"][data-arg="IMPORT"]'));
  u.click('[data-act="wiz-mode"][data-arg="API"]');
  u.click(u.button('Receive Records'));
  assert.match(u.text(), /records checked/);
  assert.ok(u.$('[data-act="wiz-start"]'));
});

test('Transfers combines history and attention with four plain statuses', { skip }, () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="runs"]');
  const heads = u.$$('main thead th').map((t) => t.textContent.trim());
  assert.deepEqual(heads, ['Date', 'Source', 'Records', 'Status', '']);
  const statuses = new Set(u.$$('main tbody .pill').map((p) => p.textContent.trim()));
  for (const s of statuses) assert.ok(['Completed', 'Processing', 'Needs Attention', 'Failed'].includes(s), s);
  u.click('[data-act="tview"][data-arg="attention"]');
  assert.ok(u.$$('main [data-act="grp-toggle"]').length > 0, 'issues are listed');
  u.click(u.$$('main [data-act="grp-toggle"]')[0]);
  assert.ok(u.$('tr.expand'));
  assert.doesNotMatch(u.text(), CODE, 'no raw codes for operators');
  assert.ok(!u.$('details.tech'), 'technical details hidden from operators');
  assert.deepEqual(u.errors, []);
});

test('transfer details: a short summary for operators, Advanced Details for authorised roles', { skip }, () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="runs"]');
  u.click(u.$('[data-act="run"]'));
  assert.ok(u.$('.callout.result'));
  assert.ok(!/Advanced Details/.test(u.text()));
  u.role('PLATFORM_ADMIN');
  const adv = u.$$('details.tech').find((x) => /Advanced Details/.test(x.querySelector('summary').textContent));
  assert.ok(adv, 'admins can open Advanced Details');
  adv.open = true; adv.dispatchEvent(new u.w.Event('toggle'));
  u.click(u.$('[data-act="tab"][data-arg="events"]'));
  const again = u.$$('details.tech').find((x) => /Advanced Details/.test(x.querySelector('summary').textContent));
  assert.ok(again.open, 'stays open after switching tabs');
  assert.ok(!u.failed());
  assert.deepEqual(u.errors, []);
});

test('every Settings page still renders for administrators', { skip }, () => {
  const u = boot();
  u.role('PLATFORM_ADMIN');
  u.click('[data-act="nav"][data-arg="settings"]');
  const items = u.$$('main .choice [data-act="nav"]').map((b) => b.dataset.arg);
  assert.deepEqual(items, ['sources', 'mapping', 'destinations', 'audit', 'security', 'recon', 'errors', 'quality', 'lineage', 'architecture']);
  for (const k of items) {
    u.click('[data-act="nav"][data-arg="settings"]');
    u.click(`main .choice [data-act="nav"][data-arg="${k}"]`);
    assert.ok(!u.failed(), `${k} failed to render`);
    assert.equal(u.$('.nav-btn[aria-current="page"]').firstChild.textContent.trim(), 'Settings');
  }
  u.role('INGESTION_OPERATOR');
  assert.equal(u.$('h1').textContent, 'Home', 'leaving an admin role leaves admin pages');
  assert.deepEqual(u.errors, []);
});

test('Send to NSIPA Registry: permitted roles only; check, review and send through the API with keys kept in page memory', { skip }, async () => {
  const u = boot();
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const households = [
    { household_serial: 'HH-UI-0001', status: 'READY', members: 2, state_name: 'Oyo', lga_name: 'Ibadan North', errors: [], warnings: 3, latest_delivery: null },
    { household_serial: 'HH-UI-0002', status: 'VALIDATION_FAILED', members: 2, state_name: 'Kano', lga_name: 'Dala', errors: ['CONSENT_NOT_GIVEN'], warnings: 0, latest_delivery: null },
  ];
  const delivery = { id: 'dlv-1', status: 'ACCEPTED', correlation_id: '02de528d45974727af21069c1a4ee429', attempt_count: 1, created_at: new Date().toISOString(), households: [{ household_serial: 'HH-UI-0001' }], registry_commit: 'NOT_CONFIRMED' };
  let sent = false;
  u.w.fetch = async (url, opts) => {
    calls.push({ url, method: opts.method, headers: opts.headers, body: opts.body });
    if (url.endsWith('/config')) return reply(200, { enabled: true });
    if (url.endsWith('/households')) return reply(200, { items: households });
    if (url.includes('/deliveries')) return reply(200, { items: sent ? [delivery] : [] });
    if (url.endsWith('/preview')) return reply(200, { status: 'READY', view: 'masked', households: [{ household_serial: 'HH-UI-0001', status: 'READY', members: 2, errors: [], warnings: [{ code: 'NSR_DEFAULT_APPLIES', field: 'sponsor', message: 'not sent; NSR will record "FEDERAL_GOVERNMENT"' }] }], request: { method: 'POST', url: 'https://nsr.example/partner/ingest_data', format: 'single', body: { header: { sender_id: 'CCT_DATABRIDGE' }, message: { individual_sn: 'HH-UI-0001' } } } });
    if (url.endsWith('/submit')) { sent = true; return reply(201, delivery); }
    return reply(404, { error: { code: 'NOT_FOUND' } });
  };
  const type = (sel, v) => { const el = u.$(sel); el.value = v; el.dispatchEvent(new u.w.Event('input', { bubbles: true })); };
  u.click('[data-act="nav"][data-arg="runs"]');
  u.role('READ_ONLY');
  assert.ok(!u.$('[data-act="tview"][data-arg="nsr"]'), 'read-only users do not see it');
  u.role('INGESTION_OPERATOR');
  u.click('[data-act="tview"][data-arg="nsr"]');
  type('#nsr-key', 'standard-key-ui');
  await u.until(() => !u.button('Connect').disabled);
  u.click(u.button('Connect'));
  await u.until(() => /HH-UI-0001/.test(u.text()));
  assert.match(u.text(), /Consent to share data was not given\./, 'blocked households say why, in plain words');
  assert.ok(u.$('[data-act="nsr-toggle"][data-arg="HH-UI-0002"]').disabled);
  u.click('[data-act="nsr-toggle"][data-arg="HH-UI-0001"]');
  u.click(u.button('Check Selected'));
  await u.until(() => /2\. Review/.test(u.text()));
  assert.ok(u.$$('details.more summary').some((s) => /Show the request the NSIPA Registry will receive/.test(s.textContent)), 'payload behind an expandable section');
  assert.ok(u.$('[data-act="nsr-submit"]').disabled, 'needs the submit key, a name and the confirmation tick');
  type('#nsr-submit-key', 'submit-key-ui');
  type('#nsr-operator', 'operator.ui');
  await new Promise((r) => setTimeout(r, 250));
  const tick = u.$('#nsr-confirm'); tick.checked = true; tick.dispatchEvent(new u.w.Event('change', { bubbles: true }));
  assert.ok(!u.$('[data-act="nsr-submit"]').disabled);
  u.click(u.$('[data-act="nsr-submit"]'));
  await u.until(() => /Sent\. The NSIPA Registry received the message\./.test(u.text()));
  assert.match(u.text(), /02de528d45974727af21069c1a4ee429/);
  assert.match(u.text(), /confirm them in the registry/, 'an ACK is not presented as registry creation');
  const submit = calls.find((c) => c.url.endsWith('/submit'));
  assert.deepEqual([submit.headers['X-API-Key'], submit.headers['X-Operator-Id'], JSON.parse(submit.body)], ['submit-key-ui', 'operator.ui', { household_serial: 'HH-UI-0001', confirm: true }]);
  assert.ok(calls.filter((c) => !c.url.endsWith('/submit')).every((c) => c.headers['X-API-Key'] === 'standard-key-ui'), 'reads use the standard key');
  const stored = JSON.stringify({ ...u.w.localStorage }) + JSON.stringify({ ...u.w.sessionStorage });
  assert.doesNotMatch(stored, /submit-key-ui|standard-key-ui/, 'keys are never stored');
  assert.deepEqual(u.$$('#role option').map((o) => o.textContent), ['Platform Admin', 'Operator', 'Read-only'], 'three roles to switch between');
  assert.ok(!u.failed());
  assert.deepEqual(u.errors, []);
});

test('after a transfer, Save to Server pushes each record, then Send to NSIPA Registry opens on the server list', { skip }, async () => {
  const u = boot();
  const pushed = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  let keyOk = false;
  u.w.fetch = async (url, opts) => {
    if (url === '/api/v1/records') {
      if (!keyOk) return reply(401, { error: { code: 'UNAUTHORISED', message: 'no' } });
      pushed.push(JSON.parse(opts.body));
      return reply(201, { status: 'CREATED' });
    }
    if (url.endsWith('/config')) return reply(200, { enabled: true });
    if (url.endsWith('/households')) return reply(200, { items: [{ household_serial: pushed[0].nsr_household_serial, status: 'READY', members: 1, errors: [], warnings: 0, latest_delivery: null }] });
    return reply(200, { items: [] });
  };
  u.click('[data-act="nav"][data-arg="ingest"]');
  u.click('[data-act="wiz-source"][data-arg="SRC-LGA-UPLOAD"]');
  u.click(u.$('[data-act="wiz-sample"]'));
  await u.until(() => u.$('[data-act="wiz-start"]'));
  const ack = u.$('#wiz-ack');
  if (ack) { ack.checked = true; ack.dispatchEvent(new u.w.Event('change', { bubbles: true })); }
  u.click('[data-act="wiz-start"]');
  await u.until(() => u.$('[data-act="wiz-save"]'), 30000);
  assert.ok(u.$('[data-act="wiz-save"]').disabled, 'needs the API key');
  const key = u.$('#wiz-api-key'); key.value = 'wrong-key'; key.dispatchEvent(new u.w.Event('input', { bubbles: true }));
  await u.until(() => !u.$('[data-act="wiz-save"]').disabled);
  u.click('[data-act="wiz-save"]');
  await u.until(() => /The API key was not accepted\./.test(u.text()));
  assert.equal(pushed.length, 0);
  keyOk = true;
  u.click('[data-act="wiz-save"]');
  await u.until(() => /records saved\./.test(u.text()));
  assert.ok(pushed.length > 0);
  assert.ok(pushed.every((r) => /^UPL-/.test(r.internal_record_id) && r.synthetic === true), 'stable IDs, never the browser master sequence');
  u.click('[data-act="wiz-open-nsr"]');
  await u.until(() => new RegExp(pushed[0].nsr_household_serial).test(u.text()));
  assert.ok(!u.failed());
  assert.deepEqual(u.errors, []);
});

test('leaving a finished transfer without saving does not lose it: Connect on Send to NSIPA Registry saves it first', { skip }, async () => {
  const u = boot();
  const order = [];
  const pushed = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  u.w.fetch = async (url, opts) => {
    order.push(url);
    if (url === '/api/v1/records') { pushed.push(JSON.parse(opts.body)); return reply(201, { status: 'CREATED' }); }
    if (url.endsWith('/config')) return reply(200, { enabled: true });
    if (url.endsWith('/households')) return reply(200, { items: [{ household_serial: pushed[0].nsr_household_serial, status: 'READY', members: 1, errors: [], warnings: 0, latest_delivery: null }] });
    return reply(200, { items: [] });
  };
  const type = (sel, v) => { const el = u.$(sel); el.value = v; el.dispatchEvent(new u.w.Event('input', { bubbles: true })); };
  u.click('[data-act="nav"][data-arg="ingest"]');
  u.click('[data-act="wiz-source"][data-arg="SRC-LGA-UPLOAD"]');
  u.click(u.$('[data-act="wiz-sample"]'));
  await u.until(() => u.$('[data-act="wiz-start"]'));
  const ack = u.$('#wiz-ack');
  if (ack) { ack.checked = true; ack.dispatchEvent(new u.w.Event('change', { bubbles: true })); }
  u.click('[data-act="wiz-start"]');
  await u.until(() => u.$('[data-act="wiz-save"]'), 30000);
  u.click('[data-act="wiz-done"]');
  assert.equal(pushed.length, 0, 'nothing is saved without a key');
  u.click('[data-act="nav"][data-arg="runs"]');
  u.click('[data-act="tview"][data-arg="nsr"]');
  assert.match(u.text(), /uploaded records are not on the server yet/, 'the screen says so before Connect');
  type('#nsr-key', 'standard-key-ui');
  await u.until(() => !u.button('Connect').disabled);
  u.click(u.button('Connect'));
  await u.until(() => new RegExp(pushed.length ? pushed[0].nsr_household_serial : 'never').test(u.text()));
  assert.ok(order.indexOf('/api/v1/records') < order.findIndex((x) => x.endsWith('/households')), 'saved before the list is read');
  assert.match(u.text(), /records saved\./);
  assert.doesNotMatch(u.text(), /not on the server yet/);
  const count = pushed.length;
  u.click(u.button('Refresh'));
  await sleep(300);
  assert.equal(pushed.length, count, 'a saved transfer is not sent again');
  assert.ok(!u.failed());
  assert.deepEqual(u.errors, []);
});

test('with the keys entered on the review step, submitting saves and queues the transfer, and Send History records it', { skip }, async () => {
  const u = boot();
  const calls = [];
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const at = new Date().toISOString();
  u.w.fetch = async (url, opts) => {
    calls.push({ url, headers: opts.headers, body: opts.body && JSON.parse(opts.body) });
    if (url === '/api/v1/records') return reply(201, { status: 'CREATED' });
    if (url.endsWith('/submit/auto')) return reply(202, { queued_households: 2, deliveries: [{ id: 'dlv-1' }], skipped: [{ household_serial: 'HH-SKIP', codes: ['ALREADY_ACCEPTED'] }] });
    if (url.endsWith('/config')) return reply(200, { enabled: true, auto_send: true });
    if (url.endsWith('/households')) return reply(200, { items: [] });
    if (url.includes('/deliveries')) return reply(200, { items: [{ id: 'dlv-1', status: 'ACCEPTED', origin: 'auto', source: 'Test source', created_by: 'operator.ui', created_at: at, first_attempt_at: at, last_attempt_at: at, record_count: 1, attempt_count: 1, correlation_id: 'ref-123', message_id: 'm-1', households: [{ household_serial: 'HH-A', record_ids: ['REC-A1'] }] }] });
    return reply(404, { error: { code: 'NOT_FOUND' } });
  };
  const type = (sel, v) => { const el = u.$(sel); el.value = v; el.dispatchEvent(new u.w.Event('input', { bubbles: true })); };
  u.click('[data-act="nav"][data-arg="ingest"]');
  u.click('[data-act="wiz-source"][data-arg="SRC-LGA-UPLOAD"]');
  u.click(u.$('[data-act="wiz-sample"]'));
  await u.until(() => u.$('[data-act="wiz-start"]'));
  type('#wiz-send-key', 'standard-key-ui');
  await sleep(150);
  type('#wiz-send-submit-key', 'submit-key-ui');
  await sleep(150);
  type('#wiz-send-operator', 'operator.ui');
  await sleep(150);
  const ack = u.$('#wiz-ack');
  if (ack) { ack.checked = true; ack.dispatchEvent(new u.w.Event('change', { bubbles: true })); }
  u.click('[data-act="wiz-start"]');
  await u.until(() => /queued for the NSIPA Registry/.test(u.text()), 30000);
  const records = calls.filter((c) => c.url === '/api/v1/records');
  const auto = calls.find((c) => c.url.endsWith('/submit/auto'));
  assert.ok(records.length > 0 && calls.indexOf(auto) > calls.indexOf(records[records.length - 1]), 'saved first, then queued');
  assert.equal(records[0].headers['X-API-Key'], 'standard-key-ui');
  assert.equal(auto.headers['X-API-Key'], 'submit-key-ui');
  assert.equal(auto.headers['X-Operator-Id'], 'operator.ui');
  assert.equal(new Set(auto.body.household_serials).size, auto.body.household_serials.length);
  assert.match(u.text(), /you can close this page/);
  assert.match(u.text(), /HH-SKIP: Already sent and received by the NSIPA Registry\./, 'skipped households say why');
  u.click('[data-act="wiz-open-nsr"]');
  await u.until(() => /Send History/.test(u.text()) && /ref-123/.test(u.text()));
  assert.match(u.text(), /Automatic/);
  assert.match(u.text(), /operator\.ui/);
  assert.match(u.text(), /REC-A1/, 'each record can be traced');
  u.click('[data-act="nsr-history-csv"]');
  assert.ok(!u.failed());
  assert.deepEqual(u.errors, []);
});

// Every list on every page: at most 8 rows, a pager with "Showing a-b of n" when there are more,
// fixed column widths. The demo seed holds 450 records in 17 transfers.
function tablesOk(u, where) {
  for (const t of u.$$('main table.t')) {
    const rows = [...t.tBodies[0].rows].filter((r) => !r.classList.contains('expand'));
    assert.ok(rows.length <= 8, `${where}: a table shows ${rows.length} rows`);
    assert.ok(t.closest('.tbl-wrap'), `${where}: a table is not in .tbl-wrap`);
    assert.ok(t.querySelector('colgroup'), `${where}: a table has no fixed column widths`);
  }
  for (const p of u.$$('main .pager')) assert.match(p.querySelector('.pager-info').textContent, /^Showing \d+-\d+ of \d+$/, where);
}

test('every page keeps every list to 8 rows a page, with a pager', { skip }, () => {
  const u = boot();
  u.role('PLATFORM_ADMIN');
  const open = () => u.$$('main details').forEach((d) => { d.open = true; d.dispatchEvent(new u.w.Event('toggle')); });
  const visit = (page) => { u.click(`[data-act="nav"][data-arg="${page}"]`); };
  for (const page of ['home', 'ingest']) { visit(page); open(); tablesOk(u, page); }
  visit('runs');
  assert.match(u.$('main .pager-info').textContent, /^Showing 1-8 of 17$/);
  for (const v of ['list', 'attention', 'nsr']) { u.click(`[data-act="tview"][data-arg="${v}"]`); open(); tablesOk(u, `runs/${v}`); }
  u.click('[data-act="tview"][data-arg="list"]');
  u.click(u.$('[data-act="run"]'));
  open();
  for (const tab of ['records', 'errors', 'recon', 'attempts', 'events', 'mapping', 'audit']) { u.click(`[data-act="tab"][data-arg="${tab}"]`); open(); tablesOk(u, `run/${tab}`); }
  for (const page of ['sources', 'destinations', 'recon', 'quality', 'lineage', 'audit', 'security', 'architecture']) {
    u.click('[data-act="nav"][data-arg="settings"]');
    u.click(`main [data-act="nav"][data-arg="${page}"]`);
    open(); tablesOk(u, page);
    assert.ok(!u.failed(), `${page} failed to render`);
  }
  u.click('[data-act="nav"][data-arg="settings"]');
  u.click('main [data-act="nav"][data-arg="errors"]');
  for (const tab of ['action', 'info', 'dead', 'done', 'types']) { u.click(`[data-act="errtab"][data-arg="${tab}"]`); open(); tablesOk(u, `errors/${tab}`); }
  u.click('[data-act="nav"][data-arg="settings"]');
  u.click('main [data-act="nav"][data-arg="mapping"]');
  for (const tab of ['mapping', 'history', 'schema']) { u.click(`[data-act="maptab"][data-arg="${tab}"]`); open(); tablesOk(u, `mapping/${tab}`); }
  assert.match(u.$('main .pager-info').textContent, /^Showing 1-8 of 145$/, 'the schema pages its fields');
  assert.ok(!u.failed());
  assert.deepEqual(u.errors, []);
});

test('the pager moves between pages, keeps its place, and returns to page 1 when the filter changes', { skip }, () => {
  const u = boot();
  u.click('[data-act="nav"][data-arg="runs"]');
  const info = () => (u.$('main .pager-info') || { textContent: '' }).textContent;
  const pageBtn = (label) => u.$$('main .pager button').find((b) => b.textContent.trim() === label);
  const firstDate = () => u.$('main table.t tbody td').textContent;
  assert.equal(info(), 'Showing 1-8 of 17');
  assert.equal(u.$('main .pager [aria-current="page"]').textContent.trim(), '1');
  assert.ok(pageBtn('Prev').disabled);
  const top = firstDate();
  u.click(pageBtn('Next'));
  assert.equal(info(), 'Showing 9-16 of 17');
  u.click(pageBtn('3'));
  assert.equal(info(), 'Showing 17-17 of 17');
  assert.ok(pageBtn('Next').disabled);
  assert.equal(u.$$('main table.t tbody tr').length, 1);
  u.click('[data-act="nav"][data-arg="home"]');
  u.click('[data-act="nav"][data-arg="runs"]');
  assert.equal(info(), 'Showing 17-17 of 17', 'the list keeps its page');
  const status = (v) => { const sel = u.$('select[data-key="tstatus"]'); sel.value = v; sel.dispatchEvent(new u.w.Event('change', { bubbles: true })); };
  status('Completed');
  assert.ok(!u.$('main .pager') || /^Showing 1-/.test(info()), 'a filter change returns to page 1');
  status('');
  assert.equal(info(), 'Showing 1-8 of 17');
  assert.equal(firstDate(), top, 'newest first');
  assert.deepEqual(u.errors, []);
});

test('Send History folds long household lists to two and "+N more", and expands them in place', { skip }, async () => {
  const u = boot();
  const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
  const at = (m) => new Date(Date.UTC(2026, 10, 1, 10, m)).toISOString();
  const d = (i, n) => ({ id: `dlv-${i}`, status: 'ACCEPTED', origin: 'auto', source: 'Test', created_by: 'op', created_at: at(i), first_attempt_at: at(i), last_attempt_at: at(i), record_count: n, attempt_count: 1, correlation_id: `ref-${i}`, households: Array.from({ length: n }, (_, k) => ({ household_serial: `HH-2702${i}${k}`, record_ids: [`R-${i}-${k}-a`, `R-${i}-${k}-b`, `R-${i}-${k}-c`] })) });
  const deliveries = [d(1, 5)].concat(Array.from({ length: 10 }, (_, i) => d(i + 2, 1)));
  u.w.fetch = async (url) => {
    if (url.endsWith('/config')) return reply(200, { enabled: true });
    if (url.endsWith('/households')) return reply(200, { items: [] });
    if (url.includes('/deliveries')) return reply(200, { items: deliveries });
    return reply(404, { error: { code: 'NOT_FOUND' } });
  };
  u.click('[data-act="nav"][data-arg="runs"]');
  u.click('[data-act="tview"][data-arg="nsr"]');
  const key = u.$('#nsr-key'); key.value = 'k'; key.dispatchEvent(new u.w.Event('input', { bubbles: true }));
  await u.until(() => !u.button('Connect').disabled);
  u.click(u.button('Connect'));
  await u.until(() => /Send History/.test(u.text()));
  assert.match(u.text(), /Showing 1-8 of 11/, 'Send History pages');
  assert.ok(!u.$('[data-act="cell-toggle"][data-arg="hist:dlv-1"]'), 'newest first: the oldest send is on page 2');
  u.click(u.$$('main .pager button').find((b) => b.textContent.trim() === 'Next'));
  const cell = () => u.$('[data-act="cell-toggle"][data-arg="hist:dlv-1"]');
  assert.equal(cell().textContent, 'HH-270210, HH-270211 ... +3 more');
  assert.equal(cell().getAttribute('aria-expanded'), 'false');
  u.click(cell());
  assert.equal(cell().textContent, 'HH-270210, HH-270211, HH-270212, HH-270213, HH-270214');
  assert.ok(cell().closest('td').classList.contains('open'));
  u.click(cell());
  assert.equal(cell().textContent, 'HH-270210, HH-270211 ... +3 more', 'a second click folds it back');
  assert.ok(u.$('[data-act="cell-toggle"][data-arg^="hist-rec:"]'), 'record IDs fold the same way');
  assert.match(u.text(), /NSIPA Registry reference/);
  assert.doesNotMatch(u.text(), /(?<![\w-])NSR(?![\w-])/);
  assert.deepEqual(u.errors, []);
});

test('wording: NSIPA Registry, Sample Files, NASSCO National Social Registry first, no screen IDs or demo footers', { skip }, () => {
  const u = boot();
  for (const role of ['INGESTION_OPERATOR', 'PLATFORM_ADMIN']) {
    u.role(role);
    for (const page of ['home', 'ingest', 'runs']) {
      u.click(`[data-act="nav"][data-arg="${page}"]`);
      assert.doesNotMatch(u.$('#app').textContent, /NG2P-CDB|Prototype v0\.5|Synthetic data|Demo · synthetic data/, page);
      assert.doesNotMatch(u.$('#app').textContent, /(?<![\w-])NSR(?![\w-])|by hand|Demo Files/, page);
    }
  }
  assert.ok(u.$('[data-act="tview"][data-arg="nsr"]').textContent.includes('Send to NSIPA Registry'));
  // Branding: "DataBridge" only; the clock shows the time without demo controls.
  for (const page of ['home', 'ingest', 'runs', 'settings', 'sources']) {
    if (page === 'sources') { u.click('main [data-act="nav"][data-arg="sources"]'); u.click('main [data-act="source"][data-arg="SRC-LEGACY-PILOT"]'); } else u.click(`[data-act="nav"][data-arg="${page}"]`);
    const shown = u.$('#app').textContent + u.$$('#app [title]').map((e) => e.title).join(' ');
    assert.doesNotMatch(shown, /NigeriaG2P|(?<![\w-])CCT(?![\w-])|Staff services|Demo clock/, page);
  }
  assert.match(u.text(), /Legacy Pilot List/, 'configured names are shown without CCT');
  assert.equal(u.$('.brand').textContent.trim(), 'DataBridge');
  assert.equal(u.$('.module-name').textContent, 'DataBridge');
  assert.match(u.$('.clock').textContent.trim(), /^\d{1,2} [A-Z][a-z]{2} \d\d:\d\d$/);
  assert.ok(!u.$('[data-act="clock"]') && !u.$('[data-act="auto"]'), 'no +30 s, +3 min or Play');
  assert.equal(u.d.title || 'DataBridge', 'DataBridge');
  u.click('[data-act="nav"][data-arg="ingest"]');
  const picks = u.$$('[data-act="wiz-source"]');
  assert.equal(picks[0].dataset.arg, 'SRC-LGA-UPLOAD');
  assert.match(picks[0].textContent, /NASSCO National Social Registry/);
  assert.deepEqual(picks.slice(1).map((b) => b.dataset.arg), ['SRC-NSR-NASSCO', 'SRC-STATE-JOSH', 'SRC-LEGACY-PILOT'], 'the rest keep their configured order');
  u.click(picks[0]);
  assert.ok(u.$$('details.more summary').some((s) => s.textContent === 'Sample Files'));
  u.click('[data-act="nav"][data-arg="settings"]');
  u.click('main [data-act="nav"][data-arg="mapping"]');
  u.click('[data-act="maptab"][data-arg="schema"]');
  assert.doesNotMatch(u.$('#app').textContent, /(?<![\w-])NSR(?![\w-])/, 'schema labels are reworded at display time');
  assert.deepEqual(u.errors, []);
});
