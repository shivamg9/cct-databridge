// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const SCHEMA = require('../prototype/schema.js');
const DB = require('../prototype/engine.js');

const NOW = Date.parse('2026-10-27T10:00:00Z');
const fresh = () => DB.createEngine(SCHEMA, { seed: 7, now: NOW });
const scenario = (id) => DB.SCENARIOS.find((s) => s.id === id);
function runScenario(e, id) {
  const sc = scenario(id);
  const opts = { mode: sc.mode, scenarioId: id, sim: { ...(sc.sim || {}) } };
  if (sc.file) opts.file = e.sampleFile(sc.file, sc.source);
  const run = e.startRun(sc.source, opts);
  if (run.blocked) return run;
  return e.runToCompletion(run);
}
const checksHold = (e, runs) => e.reconcileSummary(runs).checks.slice(0, 3).every((c) => c.ok);

test('canonical schema has exactly 145 fields from the build sheet', () => {
  assert.equal(SCHEMA.fields.length, 145);
  assert.equal(SCHEMA.fieldCount, 145);
  const by = (o) => SCHEMA.fields.filter((f) => f.object === o).length;
  assert.deepEqual([by('System'), by('Household'), by('Individual')], [5, 82, 58]);
  assert.equal(new Set(SCHEMA.fields.map((f) => f.name)).size, 145, 'field names are unique');
});

test('successful API ingestion writes to SR1 and confirms SR2', () => {
  const e = fresh();
  const run = runScenario(e, 'S01');
  e.advanceClock(10000);
  const rc = e.reconcileSummary([run]);
  assert.equal(rc.received, 30);
  assert.equal(rc.primaryWritten, 30);
  assert.equal(rc.replicaConfirmed, 30);
  assert.equal(e.runStatus(run), 'COMPLETED');
  assert.ok(rc.balanced);
});

test('file import validates template and delivers', () => {
  const e = fresh();
  const run = runScenario(e, 'S02');
  e.advanceClock(10000);
  assert.equal(e.runStatus(run), 'COMPLETED');
  assert.match(run.file.checksum, /^[0-9a-f]{64}$/);
});

test('missing required and invalid formats are rejected before delivery with field reasons', () => {
  const e = fresh();
  const r3 = runScenario(e, 'S03');
  assert.equal(e.reconcileSummary([r3]).invalid, 4);
  const r4 = runScenario(e, 'S04');
  const inv = r4.records.filter((r) => r.validation.status === 'INVALID');
  assert.equal(inv.length, 5);
  inv.forEach((r) => {
    assert.equal(r.primary.status, 'NOT_ATTEMPTED');
    assert.ok(r.validation.issues.every((i) => i.field));
  });
  assert.ok(checksHold(e, [r3, r4]));
});

test('schema change stops the run and nothing is delivered', () => {
  const e = fresh();
  const run = runScenario(e, 'S05');
  assert.equal(e.runStatus(run), 'FAILED');
  assert.equal(run.fatal.stage, 'SCHEMA_CHECK');
  assert.equal(e.state.master.records.size, 0);
});

test('in-file duplicates are held back and formula cells are rejected', () => {
  const e = fresh();
  const run = runScenario(e, 'S06');
  const rc = e.reconcileSummary([run]);
  assert.equal(rc.duplicates, 3);
  assert.ok(run.records.some((r) => r.validation.issues.some((i) => /formula/.test(i.message))));
});

test('cross-source NIN match is held for review and only delivered after approval', () => {
  const e = fresh();
  runScenario(e, 'S01');
  const run = runScenario(e, 'S07');
  const held = run.records.filter((r) => r.dedup.status === 'MATCH_REVIEW');
  assert.equal(held.length, 3);
  held.forEach((r) => assert.equal(r.primary.status, 'NOT_ATTEMPTED'));
  e.resolveReview(held[0].id, 'APPROVE_NEW', 'Different people, same NIN typo at source');
  assert.equal(held[0].primary.status, 'WRITTEN');
  e.resolveReview(held[1].id, 'REJECT', 'Same person');
  assert.equal(held[1].primary.status, 'NOT_ATTEMPTED');
  assert.ok(checksHold(e, [run]));
});

test('authentication failure fails the run at AUTHENTICATE and raises an error', () => {
  const e = fresh();
  const run = runScenario(e, 'S08');
  assert.equal(e.runStatus(run), 'FAILED');
  assert.equal(run.fatal.stage, 'AUTHENTICATE');
  assert.ok(e.state.errors.some((x) => x.code === 'AUTHENTICATION_FAILED' && x.runId === run.id));
});

test('rate limit and timeout are retried by the API adapter', () => {
  const e = fresh();
  const run = runScenario(e, 'S09');
  assert.equal(run.apiStats.throttled, 1);
  assert.equal(run.apiStats.timeouts, 1);
  assert.equal(run.records.length, 32);
});

test('transient SR1 failure is retried by the scheduler with backoff and then delivered', () => {
  const e = fresh();
  const run = runScenario(e, 'S10');
  let rc = e.reconcileSummary([run]);
  assert.equal(rc.awaitingRetry, 4);
  assert.equal(e.runStatus(run), 'AWAITING_RETRY');
  run.records.filter((r) => r.primary.status === 'AWAITING_RETRY').forEach((r) => assert.ok(r.primary.nextRetryAt > r.primary.attempts[0].at));
  e.advanceClock(30000);
  rc = e.reconcileSummary([run]);
  assert.equal(rc.awaitingRetry, 0);
  assert.equal(rc.primaryWritten, 30);
  const retried = run.records.filter((r) => r.primary.attempts.length === 2);
  assert.equal(retried.length, 4);
  assert.ok(retried.every((r) => r.primary.attempts[1].by === 'retry-scheduler'));
});

test('backoff is bounded by the exponential ceiling (full jitter)', () => {
  const e = fresh();
  for (let n = 1; n <= 6; n++) {
    for (let i = 0; i < 50; i++) {
      const ms = e.backoffMs(n);
      assert.ok(ms >= 500 && ms <= Math.max(500, Math.min(60000, 2000 * 2 ** (n - 1))), `attempt ${n}: ${ms}`);
    }
  }
});

test('permanent rejection goes to dead letters and manual retry refuses it', () => {
  const e = fresh();
  const run = runScenario(e, 'S11');
  const dead = run.records.filter((r) => r.primary.status === 'DEAD_LETTER');
  assert.equal(dead.length, 2);
  const res = e.retryRecords(run.id, dead.map((r) => r.id));
  assert.equal(res.retried, 0);
  assert.equal(res.skipped.length, 2);
});

test('retry exhaustion moves a record to dead letters after maxAttempts; manual retry later succeeds', () => {
  const e = fresh();
  const run = runScenario(e, 'S15');
  e.advanceClock(120000);
  const ex = run.records.find((r) => r.fault && r.fault.kind === 'exhaust');
  assert.equal(ex.primary.status, 'DEAD_LETTER');
  assert.equal(ex.primary.attempts.length, 5);
  e.retryRecords(run.id, [ex.id]);
  assert.equal(ex.primary.status, 'WRITTEN');
});

test('unknown outcomes: reconcile confirms committed writes and requeues the rest with no duplicates', () => {
  const e = fresh();
  const run = runScenario(e, 'S12');
  let rc = e.reconcileSummary([run]);
  assert.equal(rc.unknown, 4);
  assert.equal(e.runStatus(run), 'NEEDS_RECONCILIATION');
  assert.ok(rc.destinationMismatch, 'SR1 holds 2 records the middleware has not acknowledged');
  assert.equal(rc.destinationCount, rc.primaryWritten + 2);
  const out = e.reconcileRun(run.id);
  assert.deepEqual([out.confirmed, out.requeued], [2, 2]);
  e.advanceClock(10000);
  rc = e.reconcileSummary([run]);
  assert.equal(rc.unknown, 0);
  assert.equal(rc.primaryWritten, 30);
  assert.equal(rc.destinationCount, 30);
  assert.equal(new Set([...e.state.master.records.values()].map((x) => x.idemKey)).size, e.state.master.records.size);
});

test('retrying an unknown outcome without reconciling is safe: idempotency key prevents a second record', () => {
  const e = fresh();
  const run = runScenario(e, 'S12');
  const before = e.state.master.records.size;
  const res = e.retryRecords(run.id);
  assert.equal(res.delivered, 4);
  assert.equal(res.duplicatesPrevented, 2);
  assert.equal(e.state.master.records.size, before + 2);
});

test('delayed replica stays pending, raises lag error, then confirms', () => {
  const e = fresh();
  const run = runScenario(e, 'S13');
  assert.equal(e.runStatus(run), 'REPLICA_PENDING');
  e.advanceClock(70000);
  assert.ok(e.state.errors.some((x) => x.code === 'REPLICA_SYNC_PENDING' && x.runId === run.id));
  e.advanceClock(150000);
  assert.equal(e.reconcileSummary([run]).replicaConfirmed, 30);
  assert.ok(e.state.errors.filter((x) => x.code === 'REPLICA_SYNC_PENDING').every((x) => x.resolution === 'RESOLVED'));
});

test('replica failure is tracked independently and re-sync via reconcile recovers it', () => {
  const e = fresh();
  const run = runScenario(e, 'S14');
  e.advanceClock(10000);
  let rc = e.reconcileSummary([run]);
  assert.equal(rc.primaryWritten, 30);
  assert.equal(rc.replicaFailed, 3);
  assert.equal(e.runStatus(run), 'REPLICA_FAILED');
  e.reconcileRun(run.id);
  e.advanceClock(10000);
  rc = e.reconcileSummary([run]);
  assert.equal(rc.replicaConfirmed, 30);
});

test('mapping configuration error blocks the run in pre-flight', () => {
  const e = fresh();
  const run = runScenario(e, 'S16');
  assert.equal(e.runStatus(run), 'BLOCKED');
  assert.equal(run.records.length, 0);
  assert.ok(e.state.errors.some((x) => x.code === 'FIELD_MAPPING_FAILED'));
});

test('disabled source cannot start ingestion; attempt is audited and no run is created', () => {
  const e = fresh();
  const res = runScenario(e, 'S17');
  assert.equal(res.blocked, true);
  assert.equal(e.state.runs.length, 0);
  assert.ok(e.state.audit.some((a) => a.action === 'RUN_START_BLOCKED'));
});

test('malicious upload is quarantined and never parsed', () => {
  const e = fresh();
  const run = runScenario(e, 'S18');
  assert.equal(e.runStatus(run), 'FAILED');
  assert.equal(run.fatal.stage, 'UPLOAD_SCAN');
  assert.equal(run.records.length, 0);
  const v = e.validateUpload({ name: '../../etc/list.xlsm', size: 100, headBytes: [0x50, 0x4b, 3, 4] });
  assert.equal(v.ok, false);
  assert.equal(v.safeName, 'list.xlsm');
});

test('dry run evaluates records but never writes to SR1', () => {
  const e = fresh();
  const dry = e.dryRun('SRC-NSR-NASSCO', { mode: 'API', sim: { invalid: 2 } });
  assert.equal(dry.records.length, 30);
  assert.equal(e.state.master.records.size, 0);
  assert.equal(e.state.runs.length, 0);
  assert.ok(dry.stages.find((s) => s.key === 'DELIVER_PRIMARY').status === 'SKIPPED');
});

test('RBAC: read-only viewer cannot start runs; denial is audited', () => {
  const e = fresh();
  e.setRole('READ_ONLY');
  assert.throws(() => e.startRun('SRC-NSR-NASSCO', { mode: 'API' }), /permission: run.start/);
  assert.ok(e.state.audit.some((a) => a.action === 'AUTHZ_DENIED'));
  e.setRole('PLATFORM_ADMIN');
  const run = runScenario(e, 'S01');
  e.setRole('INGESTION_OPERATOR');
  assert.throws(() => e.viewRawPayload(run.records[0].id, 'checking a complaint'), /payload.view/);
  e.setRole('PLATFORM_ADMIN');
  assert.throws(() => e.viewRawPayload(run.records[0].id, 'short'), /justification/);
  assert.ok(e.viewRawPayload(run.records[0].id, 'Investigating ticket DQ-1042'));
});

test('RBAC: three roles. Platform Admin has every permission, Operator pushes and sends, Read-only nothing', () => {
  assert.deepEqual(Object.keys(DB.ROLES), ['PLATFORM_ADMIN', 'INGESTION_OPERATOR', 'READ_ONLY']);
  const all = DB.PERMISSIONS.map(([p]) => p);
  const matrix = Object.fromEntries(Object.entries(DB.ROLES).map(([k, r]) => [k, all.filter((p) => r.perms.includes(p))]));
  assert.deepEqual(matrix.PLATFORM_ADMIN, all, 'admin holds every permission, payload.view included');
  assert.deepEqual(matrix.INGESTION_OPERATOR, ['source.test', 'run.start', 'run.retry', 'run.reconcile', 'error.resolve', 'report.download', 'nsr.preview', 'nsr.submit']);
  assert.deepEqual(matrix.READ_ONLY, []);
  for (const p of ['audit.view', 'security.view', 'payload.view', 'source.edit', 'mapping.edit', 'destination.edit']) assert.ok(!matrix.INGESTION_OPERATOR.includes(p), `operator must not have ${p}`);
  for (const r of Object.values(DB.ROLES)) for (const p of r.perms) assert.ok(all.includes(p), `unknown permission ${p}`);
});

test('RBAC: a removed role falls back to Operator; an unknown role is refused', () => {
  const e = fresh();
  for (const old of ['SOURCE_CONFIG_ADMIN', 'DATA_QUALITY_ANALYST', 'AUDITOR']) {
    assert.equal(DB.normalizeRole(old), 'INGESTION_OPERATOR');
    e.setRole(old);
    assert.equal(e.state.role, 'INGESTION_OPERATOR');
    assert.ok(e.can('nsr.submit') && !e.can('audit.view'));
  }
  e.state.role = 'AUDITOR'; // state saved before the change
  assert.ok(e.can('run.start') && !e.can('security.view'), 'old saved state acts as Operator');
  assert.throws(() => e.setRole('SUPERUSER'), /Unknown role/);
  assert.equal(DB.normalizeRole('SUPERUSER'), null);
});

test('source config rejects SSRF targets and plaintext secrets', () => {
  const e = fresh();
  const base = { id: 'SRC-NEW', name: 'New source', type: 'Other', connection: 'API', modes: ['API'], layout: 'JOSH_V2', enabled: true, authRef: 'vault://databridge/sources/new/key' };
  assert.throws(() => e.addSource({ ...base, baseUrl: 'http://registry.mock.invalid' }), /https/);
  assert.throws(() => e.addSource({ ...base, baseUrl: 'https://169.254.169.254' }), /SSRF/);
  assert.throws(() => e.addSource({ ...base, baseUrl: 'https://db.svc' }), /SSRF/);
  assert.throws(() => e.addSource({ ...base, baseUrl: 'https://evil.example.com' }), /allow-list/);
  assert.throws(() => e.addSource({ ...base, baseUrl: 'https://x.mock.invalid', authRef: 'sk_live_abc123' }), /vault/);
  assert.ok(e.addSource({ ...base, baseUrl: 'https://x.mock.invalid' }));
});

test('removing a source keeps history and delivered records', () => {
  const e = fresh();
  const run = runScenario(e, 'S01');
  const dep = e.removeSource('SRC-NSR-NASSCO');
  assert.equal(dep.runs, 1);
  assert.ok(e.getRun(run.id));
  assert.equal(e.state.master.records.size, 30);
  assert.equal(e.metrics({}).sourcesTotal, 3);
});

test('error report neutralises formulas and redacts identifiers', () => {
  const e = fresh();
  const run = runScenario(e, 'S04');
  const rep = e.runReport(run.id);
  assert.ok(!/\b99\d{9}\b/.test(rep.text), 'no NINs in report');
  assert.equal(DB.csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(DB.csvCell('@SUM(A1)'), "'@SUM(A1)");
});

test('seeded demo: KPIs are consistent with the records and reconciliation identities hold', () => {
  const e = DB.createEngine(SCHEMA, { seed: 20261027, now: NOW });
  DB.seedDemo(e);
  const m = e.metrics({});
  const recs = e.state.runs.flatMap((r) => r.records);
  assert.equal(m.fetched, recs.length);
  assert.equal(m.deliveredSR1, recs.filter((r) => r.primary.status === 'WRITTEN' && e.classify(r) === 'ACCEPTED').length);
  assert.equal(m.confirmedSR2, recs.filter((r) => r.replica.status === 'CONFIRMED').length);
  assert.ok(m.unknown > 0 && m.awaitingRetry > 0 && m.replicaPending > 0 && m.deliveryFailures > 0, 'demo starts with failures to inspect');
  for (const run of e.state.runs) assert.ok(checksHold(e, [run]), run.id);
  const a = e.analytics({ range: '7d' });
  assert.equal(a.byDay.reduce((s, d) => s + d.received, 0), m.fetched);
});
