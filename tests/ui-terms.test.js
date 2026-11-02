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
