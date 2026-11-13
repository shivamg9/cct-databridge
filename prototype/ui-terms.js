/* CCT DataBridge: operator-facing terms for the console.
 * The engine keeps its internal codes and states. This module is the single place where
 * they become short labels for government staff: standard domain terms (validation,
 * reconciliation, replication, mapping, audit log) rather than long paraphrases.
 * Raw codes appear only in "Technical details", the audit log and exports.
 * UMD so the Node tests can check that every engine code has a translation. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.UiTerms = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // title: 1–4 words. explain: one short sentence. impact: only when it adds something.
  // auto: the system resolves it on its own. needsUser: someone must act.
  const ERROR_MESSAGES = {
    SOURCE_DISABLED: { title: 'Source disabled', explain: 'Transfer requested from a disabled source.', impact: 'Nothing was transferred.', next: 'Enable the source, then restart.', auto: false, needsUser: true, action: 'View source' },
    SOURCE_UNAVAILABLE: { title: 'Source unavailable', explain: 'The source registry did not respond.', impact: '', next: 'Retries automatically.', auto: true, needsUser: false, action: 'View transfer' },
    AUTHENTICATION_FAILED: { title: 'Authentication failed', explain: 'The source rejected the credentials.', impact: 'No records received.', next: 'Contact support to renew credentials.', auto: false, needsUser: true, action: 'Contact support' },
    RATE_LIMIT_EXCEEDED: { title: 'Rate limited', explain: 'The source is limiting requests.', impact: '', next: 'Retries automatically.', auto: true, needsUser: false, action: 'View transfer' },
    SOURCE_TIMEOUT: { title: 'Source timeout', explain: 'The source did not respond in time.', impact: '', next: 'Retries automatically; contact support if it persists.', auto: true, needsUser: false, action: 'View transfer' },
    SOURCE_SCHEMA_MISMATCH: { title: 'Source schema changed', explain: 'Source data no longer matches the registered schema.', impact: 'Transfer stopped; nothing written.', next: 'Update the field mapping.', auto: false, needsUser: true, action: 'Correct mapping' },
    FILE_FORMAT_INVALID: { title: 'Invalid file', explain: 'File type, content or size is not allowed.', impact: 'File quarantined, not read.', next: 'Upload a valid CSV or Excel file.', auto: false, needsUser: true, action: 'Upload file' },
    FILE_SCHEMA_MISMATCH: { title: 'Schema mismatch', explain: 'File columns do not match the template.', impact: 'Transfer stopped; nothing written.', next: 'Use the published template.', auto: false, needsUser: true, action: 'Upload file' },
    REQUIRED_FIELD_MISSING: { title: 'Required field missing', explain: 'Records are missing mandatory fields.', impact: 'Records not written.', next: 'Correct at source and resend.', auto: false, needsUser: true, action: 'View records' },
    FIELD_VALIDATION_FAILED: { title: 'Validation failed', explain: 'Values fail format or code-list rules.', impact: 'Records not written.', next: 'Correct at source and resend.', auto: false, needsUser: true, action: 'View records' },
    FIELD_MAPPING_FAILED: { title: 'Mapping error', explain: 'Required fields are not mapped.', impact: 'Transfer did not start.', next: 'Correct the field mapping and publish.', auto: false, needsUser: true, action: 'Correct mapping' },
    TRANSFORMATION_FAILED: { title: 'Conversion failed', explain: 'A source value could not be converted.', impact: 'Records not written.', next: 'Correct the value or the mapping rule.', auto: false, needsUser: true, action: 'View records' },
    DUPLICATE_RECORD: { title: 'Duplicate in file', explain: 'The same record appears more than once.', impact: 'Only the first copy was processed.', next: 'No action unless both are genuine.', auto: false, needsUser: false, action: 'View records' },
    MATCH_REQUIRES_REVIEW: { title: 'Possible duplicate', explain: 'Records may already exist in the master registry.', impact: 'On hold, not written.', next: 'Review each match.', auto: false, needsUser: true, action: 'Review' },
    MASTER_WRITE_FAILED: { title: 'Write failed', explain: 'Records could not be saved to Master Registry 1.', impact: '', next: 'Retry, or correct at source if rejected.', auto: false, needsUser: true, action: 'Retry' },
    MASTER_WRITE_OUTCOME_UNKNOWN: { title: 'Write outcome unknown', explain: 'Master Registry 1 did not confirm these writes.', impact: 'Not counted as written.', next: 'Reconcile before resending.', auto: false, needsUser: true, action: 'Reconcile' },
    REPLICA_SYNC_PENDING: { title: 'Replication pending', explain: 'Master Registry 1 is updated; Master Registry 2 is catching up.', impact: '', next: 'No action needed.', auto: true, needsUser: false, action: 'View transfer' },
    REPLICA_SYNC_FAILED: { title: 'Replication failed', explain: 'Records are in Master Registry 1 but not Master Registry 2.', impact: '', next: 'Reconcile to request re-sync.', auto: false, needsUser: true, action: 'Reconcile' },
    RECONCILIATION_MISMATCH: { title: 'Reconciliation mismatch', explain: 'Confirmed counts differ from expected totals.', impact: '', next: 'Reconcile the transfer.', auto: false, needsUser: true, action: 'Reconcile' },
  };
  const FALLBACK = { title: 'Unknown exception', explain: 'An unrecognised problem was recorded.', impact: '', next: 'Contact support with the reference.', auto: false, needsUser: true, action: 'Contact support' };
  const friendlyError = (code) => ERROR_MESSAGES[code] || FALLBACK;

  // Engine run status → operator status. Distinct failures keep distinct labels.
  const RUN_STATUS = {
    COMPLETED: { label: 'Completed', tone: 'good', next: '—' },
    COMPLETED_WITH_ERRORS: { label: 'Completed with errors', tone: 'serious', next: 'Review exceptions' },
    RUNNING: { label: 'In progress', tone: 'info run', next: '—' },
    QUEUED: { label: 'Not started', tone: '', next: '—' },
    AWAITING_RETRY: { label: 'Retry scheduled', tone: 'warn', next: 'Automatic retry' },
    NEEDS_RECONCILIATION: { label: 'Reconciliation pending', tone: 'crit', next: 'Reconcile' },
    REPLICA_PENDING: { label: 'Replication pending', tone: 'warn', next: '—' },
    REPLICA_FAILED: { label: 'Replication failed', tone: 'crit', next: 'Reconcile' },
    NEEDS_REVIEW: { label: 'Review required', tone: 'warn', next: 'Review duplicates' },
    FAILED: { label: 'Failed', tone: 'crit', next: 'View details' },
    BLOCKED: { label: 'Blocked', tone: 'crit', next: 'Correct and restart' },
    CANCELLED: { label: 'Cancelled', tone: '', next: '—' },
  };
  const runStatus = (s) => RUN_STATUS[s] || { label: 'Action required', tone: 'crit', next: 'View details' };
  // Status filter options: one per operator label, mapped to the engine states it covers.
  const RUN_STATUS_FILTER = [
    ['In progress', ['RUNNING', 'QUEUED']], ['Completed', ['COMPLETED']], ['Completed with errors', ['COMPLETED_WITH_ERRORS']],
    ['Retry scheduled', ['AWAITING_RETRY']], ['Reconciliation pending', ['NEEDS_RECONCILIATION']], ['Replication pending', ['REPLICA_PENDING']],
    ['Replication failed', ['REPLICA_FAILED']], ['Review required', ['NEEDS_REVIEW']], ['Failed or blocked', ['FAILED', 'BLOCKED']],
  ];

  // Per-record states, by aspect.
  const RECORD_STATUS = {
    primary: { WRITTEN: ['Written', 'good'], ACCEPTED: ['Awaiting commit', 'info'], PENDING: ['Sending', 'info'], AWAITING_RETRY: ['Retry scheduled', 'warn'], UNKNOWN: ['Outcome unknown', 'crit'], DEAD_LETTER: ['Write failed', 'crit'], REJECTED: ['Rejected', 'crit'], NOT_ATTEMPTED: ['Not sent', ''] },
    replica: { CONFIRMED: ['Replicated', 'good'], PENDING: ['Pending', 'warn'], FAILED: ['Failed', 'crit'], NOT_APPLICABLE: ['—', ''] },
    validation: { VALID: ['Valid', 'good'], INVALID: ['Invalid', 'crit'], NOT_RUN: ['Not validated', ''] },
    dedup: { UNIQUE: ['Unique', 'good'], UPDATE: ['Update', 'info'], DUPLICATE_IN_BATCH: ['Duplicate in file', 'serious'], MATCH_REVIEW: ['Possible duplicate', 'warn'], APPROVED_NEW: ['Approved as new', 'good'], REJECTED_REVIEW: ['Rejected duplicate', 'serious'], NOT_RUN: ['Not checked', ''] },
    health: { HEALTHY: ['Healthy', 'good'], FAILING: ['Failing', 'crit'], UNTESTED: ['Untested', 'warn'], DISABLED: ['Disabled', ''], REMOVED: ['Removed', ''], DEGRADED: ['Degraded', 'warn'] },
    resolution: { OPEN: ['Open', 'crit'], RETRYING: ['Retrying', 'warn'], RESOLVED: ['Resolved', 'good'], ACKNOWLEDGED: ['Reviewed', ''] },
    stage: { DONE: ['Done', 'good'], WARN: ['Warning', 'warn'], FAILED: ['Failed', 'crit'], RUNNING: ['Running', 'info run'], PENDING: ['Pending', ''], SKIPPED: ['Skipped', ''] },
    severity: { critical: ['High', 'crit'], serious: ['Medium', 'serious'], warning: ['Low', 'warn'] },
  };
  const recordStatus = (kind, v) => (RECORD_STATUS[kind] && RECORD_STATUS[kind][v]) || ['Unknown', ''];

  const STAGE_LABELS = {
    PREFLIGHT: 'Pre-flight checks', AUTHENTICATE: 'Authentication', EXTRACT: 'Extraction', UPLOAD_SCAN: 'Upload scan', PARSE: 'File parsing',
    SCHEMA_CHECK: 'Schema check', MAP_TRANSFORM: 'Mapping', VALIDATE: 'Validation', DEDUPLICATE: 'Duplicate detection',
    DELIVER_PRIMARY: 'Write to Master Registry 1', CONFIRM_COMMIT: 'Commit confirmation', REPLICA_SYNC: 'Replication check', RECONCILE: 'Reconciliation',
  };
  // The five steps shown on the progress timeline, grouping the engine stages.
  const JOURNEY = [
    ['Receive', ['PREFLIGHT', 'AUTHENTICATE', 'EXTRACT', 'UPLOAD_SCAN', 'PARSE']],
    ['Validate', ['SCHEMA_CHECK', 'MAP_TRANSFORM', 'VALIDATE', 'DEDUPLICATE']],
    ['Write (Registry 1)', ['DELIVER_PRIMARY', 'CONFIRM_COMMIT']],
    ['Replicate (Registry 2)', ['REPLICA_SYNC']],
    ['Reconcile', ['RECONCILE']],
  ];

  // Three roles. The keys stay as the engine defines them; only the labels are for people.
  const ROLE_LABELS = { PLATFORM_ADMIN: 'Platform Admin', INGESTION_OPERATOR: 'Operator', READ_ONLY: 'Read-only' };
  // Verb phrases: used in "Your role cannot …" and the access-control matrix.
  const PERM_LABELS = {
    'source.edit': 'manage sources', 'source.toggle': 'enable or disable sources', 'source.test': 'check connections',
    'mapping.edit': 'edit field mappings', 'destination.edit': 'edit destinations', 'run.start': 'start transfers',
    'run.retry': 'retry records', 'run.reconcile': 'reconcile transfers', 'error.resolve': 'resolve exceptions',
    'payload.view': 'view source payloads', 'report.download': 'download reports', 'audit.view': 'view the audit log', 'security.view': 'view access control',
    'nsr.preview': 'check households for the NSIPA Registry', 'nsr.submit': 'send households to the NSIPA Registry',
  };
  const AUDIT_ACTIONS = {
    AUTHZ_DENIED: 'Access denied', ERROR_ACKNOWLEDGED: 'Exception reviewed', ROLE_SWITCHED: 'Role changed', RUN_STARTED: 'Transfer started', RUN_START_BLOCKED: 'Transfer blocked',
    RECORDS_RETRIED: 'Records retried', RUN_RECONCILED: 'Transfer reconciled', DRY_RUN_EXECUTED: 'Validation run', SOURCE_CREATED: 'Source added', SOURCE_UPDATED: 'Source updated',
    SOURCE_REMOVED: 'Source removed', SOURCE_CONNECTION_TESTED: 'Connection checked',
    MAPPING_PUBLISHED: 'Mapping published', DESTINATION_UPDATED: 'Destination updated', RAW_PAYLOAD_VIEWED: 'Payload viewed', REPORT_DOWNLOADED: 'Report downloaded',
    MATCH_REVIEWED: 'Duplicate reviewed',
  };
  const auditAction = (a) => AUDIT_ACTIONS[a] || sentence(a);
  const OUTCOMES = { SUCCESS: ['Success', 'good'], DENIED: ['Denied', 'crit'], FAILED: ['Failed', 'serious'], BLOCKED: ['Blocked', 'serious'] };

  function sentence(s) {
    const t = String(s || '').replace(/_/g, ' ').toLowerCase();
    return t.charAt(0).toUpperCase() + t.slice(1);
  }

  // Engine free text (stage notes, events, messages) may mention codes or destination IDs.
  // scrub() swaps them for operator labels before they reach ordinary UI text.
  const CODE_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
  // Display wording for text the console does not write itself (schema labels, seed data, server
  // messages). "NSR" on its own becomes "NSIPA Registry"; codes (NSR_...), source IDs (SRC-NSR-...)
  // and household serials (NSR-HH-...) are left exactly as they are.
  const BRAND_RE = /(?<![\w-])NSR(?![\w-])/g;
  // The product is called "DataBridge" on screen: no "NigeriaG2P" and no "CCT" in displayed text.
  // Code names (CCT_TEMPLATE_V1, CCT_DATABRIDGE) are left as they are.
  function orgName(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/\bNigeriaG2P\s*·\s*/g, '')
      .replace(/\s*·\s*NigeriaG2P\b/g, '')
      .replace(/\bNigeriaG2P\s*/g, '')
      .replace(/(?<![\w-])CCT\s+template/g, (m, i, s) => (i === 0 || /[.:(]\s*$/.test(s.slice(0, i)) ? 'Template' : 'template'))
      .replace(/(?<![\w-])CCT\s+(?=\S)/g, '');
  }
  function brand(text) {
    return orgName(text)
      .replace(/\bthe NSR Household Register\b/g, 'the NSIPA Registry')
      .replace(BRAND_RE, 'NSIPA Registry')
      .replace(/\bby hand\b/g, 'manually');
  }
  function scrub(text) {
    return brand(text)
      .replace(/\bMASTER_SR([12])\b/g, 'Master Registry $1')
      .replace(/\bSR([12])\b/g, 'Master Registry $1')
      .replace(/\(ERR-\d+\)/g, '')
      .replace(CODE_RE, (c) => (ERROR_MESSAGES[c] ? ERROR_MESSAGES[c].title : RUN_STATUS[c] ? RUN_STATUS[c].label : 'exception'))
      .replace(/\s{2,}/g, ' ').trim();
  }
  // Engine refusal messages, shortened.
  const MESSAGES = [
    [/SSRF policy/, 'Address not allowed: internal hosts and IP addresses are blocked.'],
    [/not on the egress allow-list/, 'Address not on the allow-list (.gov.ng; .mock.invalid in demo).'],
    [/Only https/, 'Address must use https://.'],
    [/must not embed credentials/, 'Address must not contain credentials.'],
    [/not a valid URL/, 'Invalid address.'],
    [/vault reference/, 'Use a vault reference (vault://…). Never enter a secret.'],
    [/^Source ID must be/, 'Source ID: 3–40 characters, A–Z, 0–9 and hyphens.'],
    [/justification of at least 10/, 'Enter a reason (10+ characters). It is audited.'],
    [/^Mapping has \d+ error/, 'Correct mapping errors before publishing.'],
    [/^Cannot remove/, 'Cannot remove: a transfer is in progress.'],
    [/does not support \w+ mode/, 'Method not supported by this source.'],
    [/not waiting for review/, 'Already reviewed.'],
  ];
  const plainMessage = (m) => { const hit = MESSAGES.find(([re]) => re.test(String(m))); return hit ? hit[1] : scrub(m); };
  const hasRawCode = (text) => { CODE_RE.lastIndex = 0; return CODE_RE.test(String(text)); };

  // Validation issue → "Field label: problem", using the build-sheet label.
  function issueText(issue, fieldLabel) {
    const lbl = fieldLabel || sentence(issue.field || 'Value');
    const m = String(issue.message || '');
    if (issue.code === 'REQUIRED_FIELD_MISSING') return / when | with /.test(m) ? `${lbl}: required for this record` : `${lbl}: missing`;
    if (issue.code === 'TRANSFORMATION_FAILED') return `${lbl}: conversion failed`;
    if (/formula character/.test(m)) return `${lbl}: starts with = + - or @`;
    if (/format rule/.test(m)) return `${lbl}: invalid format`;
    if (/outside range|outside Nigeria/.test(m)) return `${lbl}: out of range`;
    if (/code list/.test(m)) return `${lbl}: not in code list`;
    if (/not a valid date/.test(m)) return `${lbl}: invalid date`;
    if (/in the future/.test(m)) return `${lbl}: future date`;
    if (/age over 120/.test(m)) return `${lbl}: age over 120`;
    if (/longer than/.test(m)) return `${lbl}: too long`;
    if (/Consent = No/.test(m)) return 'Consent: No (written with sharing restricted)';
    return `${lbl}: ${scrub(m).replace(/_/g, ' ')}`;
  }

  const TERMS = {
    runs: 'Transfer history', newRun: 'New transfer', api: 'API', import: 'File upload', destination: 'Destination',
    primary: 'Master Registry 1', replica: 'Master Registry 2', reconcile: 'Reconciliation', exceptions: 'Exceptions',
    retry: 'Retry', mapping: 'Field mapping', validation: 'Validation', dedup: 'Duplicate detection', lineage: 'Data lineage', audit: 'Audit log', rbac: 'Access control',
  };
  // Demonstration scenarios. The engine keeps its own technical descriptions.
  const SCENARIO_TEXT = {
    S01: ['API transfer', 'All records written and replicated.'],
    S02: ['File upload', 'Template file validated; all rows written.'],
    S03: ['Required fields missing', '4 records fail validation.'],
    S04: ['Invalid formats', 'Bad NIN, phone, date and account values rejected.'],
    S05: ['Source schema changed', 'Stops at schema check; nothing written.'],
    S06: ['Duplicates in file', 'Duplicates held back; formula cell rejected.'],
    S07: ['Cross-source duplicates', '3 possible duplicates held for review.'],
    S08: ['Authentication failure', 'Source rejects credentials; nothing received.'],
    S09: ['Timeout and rate limit', 'Retried automatically; transfer completes.'],
    S10: ['Temporary write failure', '4 records retry, then succeed.'],
    S11: ['Write rejected', '2 records rejected by Master Registry 1.'],
    S12: ['Write outcome unknown', 'Reconcile finds 2 written; resends 2 safely.'],
    S13: ['Replication delayed', 'Master Registry 2 catches up after ~3 min.'],
    S14: ['Replication failure', '3 written records never reach Master Registry 2.'],
    S15: ['Partial success', 'Mixed outcomes; one record exhausts 5 retries.'],
    S16: ['Mapping error', 'Blocked: required field gender unmapped.'],
    S17: ['Disabled source', 'Start refused and audited.'],
    S18: ['Malicious upload', 'Disguised file quarantined, never parsed.'],
  };

  const modeLabel = (m) => (m === 'API' ? TERMS.api : m === 'IMPORT' ? TERMS.import : sentence(m));

  // ---- Simplified operator UI ------------------------------------------------
  // Four sections. Settings is shown only to SETTINGS_ROLES; regular operators never see it.
  const NAV = [['home', 'Home'], ['ingest', 'Add Records'], ['runs', 'Transfers'], ['settings', 'Settings']];
  const SETTINGS_ROLES = ['PLATFORM_ADMIN'];
  const SETTINGS_GROUPS = [
    ['Configuration', [['sources', 'Sources'], ['mapping', 'Field Mapping'], ['destinations', 'Destinations']]],
    ['Governance', [['audit', 'Audit Log'], ['security', 'Access Control']]],
    ['Advanced', [['recon', 'Reconciliation'], ['errors', 'Exception Log'], ['quality', 'Data Quality'], ['lineage', 'Data Lineage'], ['architecture', 'System Details']]],
  ];
  const SETTINGS_PAGES = ['settings'].concat(SETTINGS_GROUPS.flatMap(([, items]) => items.map(([k]) => k)));
  // Four transfer statuses for operators. The precise status stays available in details.
  const SIMPLE_STATUS = {
    COMPLETED: ['Completed', 'good'],
    RUNNING: ['Processing', 'info run'], QUEUED: ['Processing', 'info run'], AWAITING_RETRY: ['Processing', 'info run'], REPLICA_PENDING: ['Processing', 'info run'],
    COMPLETED_WITH_ERRORS: ['Needs Attention', 'warn'], NEEDS_RECONCILIATION: ['Needs Attention', 'warn'], REPLICA_FAILED: ['Needs Attention', 'warn'], NEEDS_REVIEW: ['Needs Attention', 'warn'],
    FAILED: ['Failed', 'crit'], BLOCKED: ['Failed', 'crit'], CANCELLED: ['Failed', 'crit'],
  };
  const SIMPLE_STATUSES = ['Completed', 'Processing', 'Needs Attention', 'Failed'];
  const simpleStatus = (s) => { const [label, tone] = SIMPLE_STATUS[s] || ['Needs Attention', 'warn']; return { label, tone }; };

  // ---- Pagination: one rule for every list in the console --------------------
  const PAGE_SIZE = 8;
  // The page to show for `total` rows, clamped to the pages that exist.
  function paginate(total, page, size) {
    const n = size || PAGE_SIZE;
    const pages = Math.max(1, Math.ceil(Math.max(0, total) / n));
    const p = Math.min(Math.max(1, Math.floor(Number(page)) || 1), pages);
    const from = (p - 1) * n;
    return { page: p, pages, total, from, to: Math.min(total, from + n), size: n };
  }
  // Each list keeps its page in `store[key]`. A different filter signature starts it again at page 1.
  function pageState(store, key, total, sig) {
    const s = store[key] || (store[key] = { page: 1, sig });
    if (s.sig !== sig) { s.page = 1; s.sig = sig; }
    const pg = paginate(total, s.page);
    s.page = pg.page;
    return pg;
  }
  // Page buttons: all of them up to 7 pages, otherwise first, last, the neighbours of the current one and '...'.
  function pageItems(page, pages) {
    if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
    const out = [1];
    const lo = Math.max(2, Math.min(page - 1, pages - 4)), hi = Math.min(pages - 1, Math.max(page + 1, 5));
    if (lo > 2) out.push('...');
    for (let i = lo; i <= hi; i++) out.push(i);
    if (hi < pages - 1) out.push('...');
    out.push(pages);
    return out;
  }
  const pageLabel = (pg) => `Showing ${pg.total ? pg.from + 1 : 0}-${pg.to} of ${pg.total}`;

  return { PAGE_SIZE, paginate, pageState, pageItems, pageLabel, brand, orgName, NAV, SETTINGS_ROLES, SETTINGS_GROUPS, SETTINGS_PAGES, SIMPLE_STATUS, SIMPLE_STATUSES, simpleStatus, SCENARIO_TEXT, ERROR_MESSAGES, FALLBACK, friendlyError, RUN_STATUS, RUN_STATUS_FILTER, runStatus, RECORD_STATUS, recordStatus, STAGE_LABELS, JOURNEY, ROLE_LABELS, PERM_LABELS, AUDIT_ACTIONS, auditAction, OUTCOMES, TERMS, modeLabel, scrub, plainMessage, hasRawCode, issueText, sentence };
});
