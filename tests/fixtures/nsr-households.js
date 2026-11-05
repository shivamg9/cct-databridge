// Synthetic NSR test households (NINs start with 99). Built from the push sample so every record passes
// DataBridge push validation; FULL_HEAD fills every household section and member category.
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const SAMPLE = JSON.parse(fs.readFileSync(path.join(__dirname, '../../docs/samples/openg2p-push-record.json'), 'utf8'));
const ASSETS = ['radio', 'touchlight', 'kerosenestove', 'television', 'mobilephone', 'landphone', 'housecurrent', 'houseelsewhere', 'landforhousing', 'farmland', 'bird', 'goat', 'cattle', 'bicycle', 'motocycle', 'car', 'canoe', 'boat', 'video_dvd', 'generator', 'iron_electric', 'iron_charcoal', 'fan', 'air_conditioner', 'refrigerator', 'freezer', 'furniture_sofa', 'furniture_table', 'hifi', 'mattress', 'bed', 'computer', 'wash_machine'];

// Household-level values shared by every member of the "full" household.
const FULL_HOUSEHOLD = {
  survey_sponsor: '7', survey_sponsor_other: 'Community trust', enumerator_id: 'ENUM-OYO-01',
  main_livelihood: '1', main_livelihood_other: 'Petty trading', shock_affected: true, shock_types: ['1', '2'], shock_other: 'Pest attack',
  shock_year: '2', coping_mechanisms: ['1', '6'], coping_other: 'Borrowed seed', coping_year: '3',
  health_insurance_covered: '1', health_insurance_type: '2', health_insurance_other: 'Mutual aid',
  crops_grown: ['3', '10', '20'], crops_other_specify: 'Pepper',
  floor_material: '4', lighting_source: '5', cooking_fuel: '1', drinking_water_source: '4', toilet_type: '7', toilet_device_type: '1',
  ...Object.fromEntries(ASSETS.map((a, i) => [`asset_${a}`, i % 3])), // 0, 1, 2 repeating: mixes "NO" and "YES"
};

// Member-level values for the full head.
const FULL_MEMBER = {
  additional_name: 'Ade', birth_certificate: '1', nin_surname: 'Eze', nin_firstname: 'Chinedu', nin_othername: 'Ade',
  bank_name_other: 'Microfinance', employment_status: '4', work_sector: '1', work_subsector: '5', work_other_specify: 'Seasonal',
  educational_qualification: '5', currently_enrolled: false, last_grade_completed: '12', month_left_school: '6', year_left_school: '2019',
  school_travel_time: '1', uses_health_facility: true, health_centre_travel_time: '2', muac: 24.5, nutrition_programmes: ['2', '3'],
  has_severe_disability: true, difficulty_seeing: '2', difficulty_hearing: '1', difficulty_walking: '3', difficulty_remembering: '1',
  difficulty_self_care: '1', difficulty_communicating: '4', chronically_ill: true, chronic_illness_types: ['2', '8'], chronic_illness_other: 'Asthma',
  member_cooperative: true, member_religious_group: false, member_business_group: false, member_age_group: true, member_other_group: true,
  other_group_specify: 'Farmers union',
};

// n members; member 1 is the head. Each member gets its own ID, name and synthetic NIN.
function household(serial, n, opts) {
  opts = opts || {};
  const base = { ...SAMPLE, nsr_household_serial: serial, member_count: n, household_name: `${SAMPLE.given_name} ${SAMPLE.family_name}`, ...(opts.household || {}) };
  delete base.internal_record_id;
  return Array.from({ length: n }, (_, i) => {
    const head = i === 0;
    const r = {
      ...base,
      internal_record_id: `${serial}-M${i + 1}`,
      given_name: head ? SAMPLE.given_name : ['Funke', 'Tobi', 'Ada', 'Musa', 'Kemi'][i % 5],
      nin: `99${String(Number(serial.replace(/\D/g, '')) % 1e6).padStart(6, '0')}${String(i + 1).padStart(3, '0')}`,
      birth_date: head ? SAMPLE.birth_date : `20${String(10 + i).padStart(2, '0')}-0${(i % 9) + 1}-1${i % 9}`,
      relationship_to_head: head ? '1' : '3', is_household_head: head, marital_status: head ? '1' : '5',
      ...(head ? opts.head || {} : opts.member || {}),
    };
    if (!head) { delete r.account_number; delete r.account_name; delete r.bvn; delete r.bank_name; r.phone_number = `+23480100${String(40000 + i).slice(-5)}`; }
    return r;
  });
}
const fullHousehold = (serial, n) => household(serial, n || 2, { household: FULL_HOUSEHOLD, head: FULL_MEMBER });

module.exports = { SAMPLE, ASSETS, FULL_HOUSEHOLD, FULL_MEMBER, household, fullHousehold };
