// Run: node --test tests/
// Checks that every engine code, status and audit action has plain-language wording,
// so no raw identifier has to be shown to operators.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const SCHEMA = require('../prototype/schema.js');
const DB = require('../prototype/engine.js');
const T = require('../prototype/ui-terms.js');

const CODE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
const NOW = Date.parse('2026-10-27T10:00:00Z');

function runAllScenarios() {
  const e = DB.createEngine(SCHEMA, { seed: 11, now: NOW });
  const runs = [];
  for (const sc of DB.SCENARIOS) {
    const opts = { mode: sc.mode, scenarioId: sc.id, sim: { ...(sc.sim || {}) } };
    if (sc.file) opts.file = e.sampleFile(sc.file, sc.source);
    const run = e.startRun(sc.source, opts);
    if (!run.blocked) runs.push(e.runToCompletion(run));
  }
  return { e, runs };
}

test('every engine error code has a complete plain-language message', () => {
  for (const code of Object.keys(DB.ERROR_TAXONOMY)) {
    const m = T.ERROR_MESSAGES[code];
    assert.ok(m, `missing message for ${code}`);
    for (const k of ['title', 'explain', 'next', 'action']) assert.ok(m[k] && m[k].length > 3, `${code}.${k} is empty`);
    for (const k of ['title', 'explain', 'impact', 'next', 'action']) {
      assert.equal(typeof m[k], 'string');
      assert.doesNotMatch(m[k], CODE, `${code}.${k} contains a raw code`);
    }
    assert.equal(typeof m.auto, 'boolean');
    assert.equal(typeof m.needsUser, 'boolean');
    assert.notEqual(m.title.toUpperCase(), m.title, `${code} title should be sentence case`);
    assert.ok(m.title.split(/\s+/).length <= 4, `${code} title over 4 words`);
    assert.ok(m.explain.split(/\s+/).length <= 12, `${code} explanation over 12 words`);
    assert.ok(m.action.split(/\s+/).length <= 3, `${code} action over 3 words`);
  }
});

test('standard domain terms are used, keeping distinct failures distinct', () => {
  assert.equal(T.friendlyError('MASTER_WRITE_FAILED').title, 'Write failed');
  assert.equal(T.friendlyError('MASTER_WRITE_OUTCOME_UNKNOWN').title, 'Write outcome unknown');
  assert.equal(T.friendlyError('REPLICA_SYNC_PENDING').title, 'Replication pending');
  assert.equal(T.friendlyError('MATCH_REQUIRES_REVIEW').title, 'Possible duplicate');
  assert.equal(T.friendlyError('FIELD_VALIDATION_FAILED').title, 'Validation failed');
  assert.equal(T.friendlyError('FILE_SCHEMA_MISMATCH').title, 'Schema mismatch');
  assert.equal(T.friendlyError('FIELD_MAPPING_FAILED').title, 'Mapping error');
  assert.match(T.friendlyError('REPLICA_SYNC_PENDING').explain, /Master Registry 1 is updated/);
  const titles = Object.values(T.ERROR_MESSAGES).map((m) => m.title);
  assert.equal(new Set(titles).size, titles.length, 'every code has a distinct title');
  for (const s of ['FAILED', 'REPLICA_FAILED', 'NEEDS_RECONCILIATION']) assert.notEqual(T.runStatus(s).label, 'Action required');
});

test('an unknown code gets a readable fallback, never the code itself', () => {
  const m = T.friendlyError('SOMETHING_NEW_HAPPENED');
  assert.equal(m, T.FALLBACK);
  assert.doesNotMatch(Object.values(m).join(' '), /SOMETHING_NEW_HAPPENED/);
  assert.equal(T.scrub('Failed with SOMETHING_NEW_HAPPENED (ERR-00012)'), 'Failed with exception');
});

test('every run status the engine can produce maps to one of the operator statuses', () => {
  const allowed = new Set(['Completed', 'Completed with errors', 'In progress', 'Retry scheduled', 'Reconciliation pending', 'Replication pending', 'Replication failed', 'Review required', 'Failed', 'Blocked', 'Cancelled', 'Not started']);
  const src = fs.readFileSync(path.join(__dirname, '../prototype/engine.js'), 'utf8');
  const body = src.slice(src.indexOf('function runStatus'), src.indexOf('function classify'));
  const states = [...body.matchAll(/return '([A-Z_]+)'/g)].map((m) => m[1]);
  assert.ok(states.length >= 10, 'found the engine run statuses');
  for (const s of states) {
    assert.ok(T.RUN_STATUS[s], `no operator status for ${s}`);
    assert.ok(allowed.has(T.runStatus(s).label), `${s} maps to unexpected label ${T.runStatus(s).label}`);
  }
  // Unresolved runs are never shown as completed.
  for (const s of ['NEEDS_RECONCILIATION', 'AWAITING_RETRY', 'REPLICA_PENDING', 'REPLICA_FAILED', 'NEEDS_REVIEW', 'FAILED', 'BLOCKED', 'RUNNING']) {
    assert.ok(!/^Completed/.test(T.runStatus(s).label), `${s} must not read as completed`);
  }
});

test('every state reached in the 18 scenarios has a label, and engine text is scrubbed of codes', () => {
  const { e, runs } = runAllScenarios();
  for (const run of runs) {
    for (const r of run.records) {
      for (const [kind, v] of [['primary', r.primary.status], ['replica', r.replica.status], ['validation', r.validation.status], ['dedup', r.dedup.status]]) {
        assert.ok(T.RECORD_STATUS[kind][v], `no label for ${kind} ${v}`);
      }
    }
    for (const st of run.stages) {
      assert.ok(T.STAGE_LABELS[st.key], `no label for stage ${st.key}`);
      assert.ok(T.RECORD_STATUS.stage[st.status], `no label for stage status ${st.status}`);
      assert.doesNotMatch(T.scrub(st.note), CODE, `stage note still has a code: ${st.note}`);
    }
    for (const ev of run.events) assert.doesNotMatch(T.scrub(ev.msg), CODE, `event still has a code: ${ev.msg}`);
    if (run.fatal) assert.doesNotMatch(T.scrub(run.fatal.message), CODE);
  }
  for (const err of e.state.errors) {
    assert.ok(T.ERROR_MESSAGES[err.code], `no message for raised code ${err.code}`);
    assert.ok(T.RECORD_STATUS.resolution[err.resolution], `no label for resolution ${err.resolution}`);
  }
  // The five journey steps cover every engine stage exactly once.
  const covered = T.JOURNEY.flatMap(([, keys]) => keys);
  assert.equal(new Set(covered).size, covered.length);
  for (const k of Object.keys(T.STAGE_LABELS)) assert.ok(covered.includes(k), `stage ${k} missing from journey`);
});

test('every audit action, role, permission and scenario has plain wording', () => {
  const src = fs.readFileSync(path.join(__dirname, '../prototype/engine.js'), 'utf8');
  for (const [, a] of src.matchAll(/audit\('([A-Z_]+)'/g)) assert.ok(T.AUDIT_ACTIONS[a], `no wording for audit action ${a}`);
  for (const k of Object.keys(DB.ROLES)) assert.ok(T.ROLE_LABELS[k], `no label for role ${k}`);
  for (const [p] of DB.PERMISSIONS) assert.ok(T.PERM_LABELS[p], `no wording for permission ${p}`);
  for (const sc of DB.SCENARIOS) {
    assert.ok(T.SCENARIO_TEXT[sc.id], `no text for scenario ${sc.id}`);
    assert.doesNotMatch(T.SCENARIO_TEXT[sc.id].join(' '), CODE);
  }
});

test('scrub replaces destination IDs and known codes in free text', () => {
  assert.equal(T.scrub('MASTER_SR1 is disabled'), 'Master Registry 1 is disabled');
  assert.equal(T.scrub('Written to SR1, pending on SR2'), 'Written to Master Registry 1, pending on Master Registry 2');
  assert.equal(T.scrub('AUTHENTICATION_FAILED: 401 from source'), 'Authentication failed: 401 from source');
  assert.equal(T.hasRawCode(T.scrub('REPLICA_SYNC_FAILED and COMPLETED_WITH_ERRORS')), false);
});

test('validation issues use the build-sheet field label', () => {
  assert.equal(T.issueText({ code: 'REQUIRED_FIELD_MISSING', field: 'gender', message: 'gender is required' }, 'Gender (sex)'), 'Gender (sex): missing');
  assert.equal(T.issueText({ code: 'FIELD_VALIDATION_FAILED', field: 'nin', message: 'nin fails format rule ^\\d{11}$' }, 'NIN'), 'NIN: invalid format');
  assert.doesNotMatch(T.issueText({ code: 'REQUIRED_FIELD_MISSING', field: 'nin_type', message: 'nin_type is required when has_valid_nin = Yes' }, 'NIN type'), /_/);
});

test('engine refusal messages are reworded without jargon', () => {
  assert.doesNotMatch(T.plainMessage('Blocked by SSRF policy: IP literals and internal hostnames are not allowed.'), /SSRF policy|literal/);
  assert.match(T.plainMessage('Credentials must be a vault reference (vault://…). Never paste a secret value here.'), /vault:\/\//);
  assert.equal(T.plainMessage('Source name is required.'), 'Source name is required.');
});

test('simplified console: four sections at most, Settings for administrators only', () => {
  assert.ok(T.NAV.length <= 4);
  for (const [, l] of T.NAV) assert.ok(l.split(/\s+/).length <= 3, `${l} over 3 words`);
  assert.deepEqual(T.NAV.map(([, l]) => l), ['Home', 'Add Records', 'Transfers', 'Settings']);
  for (const r of ['INGESTION_OPERATOR', 'READ_ONLY']) assert.ok(!T.SETTINGS_ROLES.includes(r), `${r} must not see Settings`);
  for (const r of T.SETTINGS_ROLES) assert.ok(DB.ROLES[r], `unknown role ${r}`);
  for (const p of ['sources', 'mapping', 'destinations', 'audit', 'security', 'recon', 'errors', 'quality', 'lineage', 'architecture']) assert.ok(T.SETTINGS_PAGES.includes(p), `${p} is not under Settings`);
  for (const p of ['home', 'ingest', 'runs', 'run']) assert.ok(!T.SETTINGS_PAGES.includes(p), `${p} must stay open to operators`);
});

test('every engine run status maps to one of four operator statuses, never wrongly to Completed', () => {
  const src = fs.readFileSync(path.join(__dirname, '../prototype/engine.js'), 'utf8');
  const body = src.slice(src.indexOf('function runStatus'), src.indexOf('function classify'));
  const states = [...body.matchAll(/return '([A-Z_]+)'/g)].map((m) => m[1]);
  for (const s of states) {
    assert.ok(T.SIMPLE_STATUS[s], `no simple status for ${s}`);
    assert.ok(T.SIMPLE_STATUSES.includes(T.simpleStatus(s).label));
  }
  for (const s of states.filter((x) => x !== 'COMPLETED')) assert.notEqual(T.simpleStatus(s).label, 'Completed', `${s} must not read as completed`);
  for (const s of ['NEEDS_RECONCILIATION', 'REPLICA_FAILED', 'NEEDS_REVIEW', 'COMPLETED_WITH_ERRORS']) assert.equal(T.simpleStatus(s).label, 'Needs Attention');
  assert.equal(T.simpleStatus('SOMETHING_NEW').label, 'Needs Attention', 'unknown states fail safe');
});

test('pager: 8 rows a page, page count and bounds', () => {
  assert.equal(T.PAGE_SIZE, 8);
  assert.deepEqual(T.paginate(83, 1), { page: 1, pages: 11, total: 83, from: 0, to: 8, size: 8 });
  assert.equal(T.pageLabel(T.paginate(83, 1)), 'Showing 1-8 of 83');
  assert.equal(T.pageLabel(T.paginate(83, 11)), 'Showing 81-83 of 83', 'the last page holds the remainder');
  assert.equal(T.paginate(8, 1).pages, 1, 'exactly one page: the pager is hidden');
  assert.equal(T.paginate(9, 1).pages, 2);
  assert.equal(T.paginate(0, 1).pages, 1);
  assert.equal(T.paginate(0, 1).to, 0);
  assert.equal(T.paginate(83, 99).page, 11, 'past the end clamps to the last page');
  assert.equal(T.paginate(83, 0).page, 1, 'before the start clamps to page 1');
  assert.equal(T.paginate(83, -3).page, 1);
  assert.equal(T.paginate(83, 'x').page, 1);
  assert.equal(T.paginate(83, Infinity).page, 11);
});

test('pager: numbers with ... for long ranges', () => {
  assert.deepEqual(T.pageItems(1, 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(T.pageItems(1, 7), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(T.pageItems(1, 11), [1, 2, 3, 4, 5, '...', 11]);
  assert.deepEqual(T.pageItems(6, 11), [1, '...', 5, 6, 7, '...', 11]);
  assert.deepEqual(T.pageItems(11, 11), [1, '...', 7, 8, 9, 10, 11]);
  for (let pages = 1; pages <= 30; pages++) {
    for (let p = 1; p <= pages; p++) {
      const items = T.pageItems(p, pages);
      assert.ok(items.includes(p), `page ${p} of ${pages} is listed`);
      assert.equal(items[0], 1);
      assert.equal(items[items.length - 1], pages);
      assert.ok(items.length <= 7, `at most 7 buttons (${pages} pages)`);
    }
  }
});

test('pager: each list keeps its page, and a filter change returns it to page 1', () => {
  const store = {};
  assert.equal(T.pageState(store, 'runs', 83, '""').page, 1);
  store.runs.page = 4;
  assert.equal(T.pageState(store, 'runs', 83, '""').page, 4, 'same filter keeps the page');
  assert.equal(T.pageState(store, 'audit', 83, '""').page, 1, 'other lists are independent');
  assert.equal(T.pageState(store, 'runs', 30, '"Failed"').page, 1, 'a new filter starts again at page 1');
  store.runs.page = 4;
  assert.equal(T.pageState(store, 'runs', 10, '"Failed"').page, 2, 'a list that shrank clamps to its last page');
  assert.equal(store.runs.page, 2);
});

test('wording: NSR reads as NSIPA Registry and "by hand" as "manually", codes and IDs unchanged', () => {
  assert.equal(T.brand('Send to NSR'), 'Send to NSIPA Registry');
  assert.equal(T.brand('Send it again by hand'), 'Send it again manually');
  assert.equal(T.brand('Send households to the NSR Household Register'), 'Send households to the NSIPA Registry');
  assert.equal(T.brand('NSR household serial no.'), 'NSIPA Registry household serial no.');
  for (const keep of ['NSR_WEBHOOK_ENABLED', 'SRC-NSR-NASSCO', 'NSR-HH-0001', '/api/v1/nsr/submit', 'nsr.preview', 'nsr_household_serial']) assert.equal(T.brand(keep), keep);
  assert.equal(T.scrub('not sent; NSR will record "NO"'), 'not sent; NSIPA Registry will record "NO"');
  for (const v of Object.values(T.PERM_LABELS)) assert.doesNotMatch(v, /\bNSR\b/);
});

test('roles: three labels, and only Platform Admin sees Settings', () => {
  assert.deepEqual(Object.keys(T.ROLE_LABELS).sort(), ['INGESTION_OPERATOR', 'PLATFORM_ADMIN', 'READ_ONLY']);
  assert.equal(T.ROLE_LABELS.PLATFORM_ADMIN, 'Platform Admin');
  assert.equal(T.ROLE_LABELS.INGESTION_OPERATOR, 'Operator');
  assert.equal(T.ROLE_LABELS.READ_ONLY, 'Read-only');
  assert.deepEqual(T.SETTINGS_ROLES, ['PLATFORM_ADMIN']);
});

test('wording: the product reads DataBridge, without NigeriaG2P or CCT; code names unchanged', () => {
  assert.equal(T.orgName('NigeriaG2P · CCT DataBridge'), 'DataBridge');
  assert.equal(T.orgName('CCT DataBridge'), 'DataBridge');
  assert.equal(T.orgName('Legacy CCT Pilot List'), 'Legacy Pilot List');
  assert.equal(T.orgName('CCT template v1 (.csv)'), 'Template v1 (.csv)');
  assert.equal(T.orgName('Lists using the published CCT template.'), 'Lists using the published template.');
  for (const keep of ['CCT_TEMPLATE_V1', 'CCT_DATABRIDGE']) assert.equal(T.orgName(keep), keep);
  assert.equal(T.brand('CCT DataBridge sends to NSR'), 'DataBridge sends to NSIPA Registry');
});
