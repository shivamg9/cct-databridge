// Builds one NSR household object from the DataBridge member records that share an nsr_household_serial.
// Every target key comes from mapping.json; this file only interprets its transforms. Nothing is invented:
// a value is sent only when DataBridge holds it, and absent values are reported, not defaulted.
'use strict';
const SCHEMA = require('../../../prototype/schema.js');
const R = require('../../records.js');
const MAPPING = require('./mapping.json');

const FIELDS = new Map(SCHEMA.fields.map((f) => [f.name, f]));
const HOUSEHOLD_FIELDS = SCHEMA.fields.filter((f) => f.object === 'Household').map((f) => f.name);
const ASSET_FIELDS = SCHEMA.fields.filter((f) => f.name.startsWith('asset_')).map((f) => f.name);
const SOCIAL_FIELDS = ['member_cooperative', 'member_religious_group', 'member_business_group', 'member_age_group', 'member_other_group'];
const has = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && !v.length);
const yesNo = (v) => (v === true ? 'YES' : v === false ? 'NO' : undefined);
const anyOf = (rec, names, test) => {
  const vals = names.map((n) => rec[n]);
  if (vals.some((v) => has(v) && test(v))) return 'YES';
  return vals.every(has) ? 'NO' : undefined;
};

// Completed years between birth (YYYY-MM-DD) and the message time.
function ageAt(birth, now) {
  const [y, m, d] = birth.split('-').map(Number);
  const t = new Date(now);
  let age = t.getUTCFullYear() - y;
  if (t.getUTCMonth() + 1 < m || (t.getUTCMonth() + 1 === m && t.getUTCDate() < d)) age--;
  return age >= 0 ? age : undefined;
}

// The Code Lists label for a stored code. A code with no label is reported and not sent.
function labelOf(list, code, entry, ctx) {
  const c = (SCHEMA.codeLists[list] || []).find((x) => x.code === String(code));
  if (!c) ctx.warn('VALUE_NOT_SENT', entry.target, `code ${code} has no label in code list ${list} and is not sent`);
  return c ? c.label : undefined;
}

// Returns the value to send for one mapping entry, or undefined to leave the key out.
function valueFor(entry, rec, ctx) {
  const v = entry.source && !entry.source.includes('*') ? rec[entry.source] : undefined;
  switch (entry.transform) {
    case 'none': return undefined;
    case 'copy': return has(v) ? v : undefined;
    case 'code': return has(v) ? String(v) : undefined;
    case 'yes_no': return yesNo(v);
    case 'code_map': {
      if (!has(v)) return undefined;
      const out = entry.values[String(v)];
      if (out !== undefined) {
        return out;
      }
      if (entry.fallback) { ctx.warn('VALUE_GENERALISED', entry.target, `code ${v} has no NSIPA Registry equivalent and is sent as ${entry.fallback}`); return entry.fallback; }
      ctx.warn('VALUE_NOT_SENT', entry.target, `code ${v} has no NSIPA Registry equivalent and is not sent`);
      return undefined;
    }
    case 'code_label': return has(v) ? labelOf(FIELDS.get(entry.source).codeList, v, entry, ctx) : undefined;
    case 'multi_labels': {
      if (!has(v)) return undefined;
      const labels = v.map((x) => labelOf(FIELDS.get(entry.source).codeList, x, entry, ctx)).filter(has);
      return labels.length ? labels.join(', ') : undefined;
    }
    case 'multi_codes': return has(v) ? v.map(String).join(' ') : undefined;
    case 'count_flag': return Number.isInteger(v) ? (v > 0 ? 'YES' : 'NO') : undefined;
    case 'count_num': return Number.isInteger(v) ? String(v) : undefined;
    case 'assets_any': return anyOf(rec, ASSET_FIELDS, (n) => n > 0);
    case 'crops_any': return has(rec.crops_grown) || has(rec.crops_other_specify) ? 'YES' : undefined;
    case 'crop_flag': return has(rec.crops_grown) ? (rec.crops_grown.includes(entry.crop_code) ? 'YES' : 'NO') : undefined;
    case 'other_crop_flag': return has(rec.crops_other_specify) ? 'YES' : has(rec.crops_grown) ? 'NO' : undefined;
    case 'birth_year': return has(v) ? Number(v.slice(0, 4)) : undefined;
    case 'birth_month': return has(v) ? Number(v.slice(5, 7)) : undefined;
    case 'birth_day': return has(v) ? Number(v.slice(8, 10)) : undefined;
    case 'age': return has(v) ? ageAt(v, ctx.now) : undefined;
    case 'subsector': return has(v) && String(rec.work_sector) === entry.sector_code ? String(v) : undefined;
    case 'subsector_label': return has(v) && String(rec.work_sector) === entry.sector_code ? labelOf(`labor_${entry.target}`, v, entry, ctx) : undefined;
    case 'social_any': return anyOf(rec, SOCIAL_FIELDS, (b) => b === true);
    case 'gps_components': return undefined; // handled in buildHousehold: three keys, not one
    default: throw new Error(`Unknown transform ${entry.transform} for ${entry.target}`);
  }
}

function mapEntries(entries, rec, ctx, out) {
  for (const entry of entries) {
    if (entry.transform === 'gps_components') {
      if (has(rec.latitude) && has(rec.longitude)) {
        out.latitude = rec.latitude; out.longitude = rec.longitude;
        if (has(rec.accuracy_m)) out.accuracy_m = rec.accuracy_m;
      } else if (has(rec.latitude) || has(rec.longitude)) ctx.warn('VALUE_NOT_SENT', 'gps', 'only one of latitude and longitude is present; neither is sent');
      continue;
    }
    const v = valueFor(entry, rec, ctx);
    if (v !== undefined) out[entry.target] = v;
  }
  return out;
}

const isHead = (r) => r.is_household_head === true || String(r.relationship_to_head) === '1';

// records: the stored canonical records of one household (any order).
// opts: { now, maxMembers, allowSynthetic }. Returns { household_serial, status, errors, warnings, record_ids, message, content_hash, synthetic }.
function buildHousehold(serial, records, opts) {
  opts = opts || {};
  const now = opts.now || Date.now();
  const errors = [], warnings = [];
  const err = (code, field, message) => errors.push({ code, field, message });
  const ctx = { now, warn: (code, field, message) => { if (!warnings.some((w) => w.code === code && w.field === field && w.message === message)) warnings.push({ code, field, message }); } };
  const base = { household_serial: serial, record_ids: records.map((r) => r.internal_record_id).sort() };
  if (!records.length) return { ...base, status: 'VALIDATION_FAILED', errors: [{ code: 'HOUSEHOLD_NOT_FOUND', field: 'nsr_household_serial', message: 'No records have this household serial' }], warnings, message: null, content_hash: null, synthetic: null };

  // Head first, then by record ID, so the same records always give the same payload.
  const heads = records.filter(isHead);
  const sorted = [...records].sort((a, b) => (isHead(b) - isHead(a)) || a.internal_record_id.localeCompare(b.internal_record_id));
  if (!heads.length) err('NO_HEAD', 'relationship_to_head', 'No member is marked as household head');
  if (heads.length > 1) err('MULTIPLE_HEADS', 'relationship_to_head', `${heads.length} members are marked as household head`);
  for (const r of records) {
    if (r.is_household_head !== undefined && has(r.relationship_to_head) && r.is_household_head !== (String(r.relationship_to_head) === '1')) {
      err('HEAD_CONFLICT', 'is_household_head', `Record ${r.internal_record_id}: is_household_head and relationship_to_head disagree`);
    }
  }
  if (records.length > (opts.maxMembers || Infinity)) err('TOO_MANY_MEMBERS', 'household_members', `${records.length} members; the configured limit is ${opts.maxMembers}`);

  // Consent is never assumed: every member record must say true.
  if (records.some((r) => r.consent_to_share_data === false)) err('CONSENT_NOT_GIVEN', 'consent_to_share_data', 'At least one member record says consent was not given');
  else if (records.some((r) => r.consent_to_share_data !== true)) err('CONSENT_MISSING', 'consent_to_share_data', 'At least one member record has no consent value');

  const synth = new Set(records.map((r) => r.synthetic));
  if (synth.size > 1) err('MIXED_SYNTHETIC', 'synthetic', 'The household mixes synthetic and real records');
  const synthetic = synth.size === 1 ? [...synth][0] : null;
  if (synthetic === true && opts.allowSynthetic === false) err('SYNTHETIC_NOT_ALLOWED', 'synthetic', 'Synthetic records cannot be sent to NSIPA Registry unless NSR_WEBHOOK_ALLOW_SYNTHETIC=true');

  // Household-level fields: one value per household. Different values across members block the household.
  const hh = {};
  for (const name of HOUSEHOLD_FIELDS) {
    if (name === 'consent_to_share_data') continue;
    const vals = sorted.map((r) => r[name]).filter(has);
    if (!vals.length) continue;
    if (new Set(vals.map((v) => R.stable(v))).size > 1) err('HOUSEHOLD_FIELD_CONFLICT', name, 'Members of this household have different values');
    hh[name] = vals[0];
  }
  hh.internal_record_id = sorted[0].internal_record_id;
  hh.consent_to_share_data = errors.some((e) => e.code.startsWith('CONSENT_')) ? undefined : true;

  if (!has(hh.member_count)) err('MEMBER_COUNT_MISSING', 'member_count', 'member_count is required');
  else if (hh.member_count !== records.length) err('MEMBER_COUNT_MISMATCH', 'member_count', `member_count is ${hh.member_count} but ${records.length} member records were found`);

  const seen = new Map();
  for (const r of sorted) {
    const keys = [has(r.nin) && `nin:${r.nin}`, has(r.given_name) && has(r.family_name) && has(r.birth_date) && `person:${r.given_name.toLowerCase()}|${r.family_name.toLowerCase()}|${r.birth_date}`].filter(Boolean);
    for (const k of keys) {
      if (seen.has(k)) err('DUPLICATE_MEMBER', k.startsWith('nin') ? 'nin' : 'given_name', `Records ${seen.get(k)} and ${r.internal_record_id} look like the same person`);
      else seen.set(k, r.internal_record_id);
    }
  }

  const message = mapEntries(MAPPING.household, hh, ctx, {});
  message.household_members = sorted.map((r) => mapEntries(MAPPING.members, r, ctx, {}));

  // Where NSR fills a default for an absent key, say so: the registry would record a value DataBridge never had.
  // Crops are reported once for the section rather than per crop.
  for (const e of MAPPING.household) {
    if (e.spec_default === null || e.spec_default === '' || e.section === 'household_crops_grown' || e.target === 'consent') continue;
    const key = e.transform === 'gps_components' ? 'latitude' : e.target;
    if (!(key in message)) ctx.warn('NSR_DEFAULT_APPLIES', e.target, `not sent; NSIPA Registry will record ${JSON.stringify(e.spec_default)}`);
  }
  if (!('hh_crops_options' in message)) ctx.warn('NSR_DEFAULT_APPLIES', 'household_crops_grown', 'no crop data; NSIPA Registry will record "NO" for every crop');
  const review = [...MAPPING.household, ...MAPPING.members].filter((e) => e.classification === 'REVIEW_REQUIRED' && e.transform !== 'none')
    .map((e) => e.target).filter((t) => t in message || message.household_members.some((m) => t in m));
  if (review.length) ctx.warn('VALUE_FORMAT_UNCONFIRMED', null, `sent in a format the NSIPA Registry team has not confirmed: ${review.join(', ')}`);

  return {
    ...base,
    status: errors.length ? 'VALIDATION_FAILED' : 'READY',
    errors, warnings,
    message,
    // Hash of the source records, not the payload (the age changes with the date). Same records, same hash.
    content_hash: R.hash(sorted.map((r) => r)),
    synthetic,
  };
}

// Groups stored records by household serial. Records without a serial cannot be sent.
function groupHouseholds(store) {
  const groups = new Map();
  for (const it of Object.values(store.items)) {
    const s = it.record.nsr_household_serial;
    if (!has(s)) continue;
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s).push(it.record);
  }
  return groups;
}

// Masked copy of a household message, using the build sheet's rules for each value's source field.
const MASK_SOURCE = new Map([...MAPPING.household, ...MAPPING.members].filter((e) => e.source && !e.source.includes('*')).map((e) => [e.target, e.source]));
MASK_SOURCE.set('latitude', 'latitude'); MASK_SOURCE.set('longitude', 'longitude'); MASK_SOURCE.set('accuracy_m', 'accuracy_m');
function maskMessage(message) {
  const one = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'household_members') { out[k] = v.map(one); continue; }
      const src = MASK_SOURCE.get(k);
      const rule = src && R.MASK.get(src);
      out[k] = !rule ? v : rule === 'HIDE' ? null : (R.maskValue(rule, FIELDS.get(src), v) ?? null);
    }
    return out;
  };
  return one(message);
}

module.exports = { buildHousehold, groupHouseholds, maskMessage, MAPPING };
