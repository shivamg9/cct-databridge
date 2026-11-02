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
  assert.deepEqual(u.nav(), ['Home', 'Add Records', 'Transfers'], 'opens as Transfer operator');
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
