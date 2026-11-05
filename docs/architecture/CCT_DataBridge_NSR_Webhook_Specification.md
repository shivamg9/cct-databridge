# OpenG2P National Social Registry (NSR) — Webhook Integration Specification for CCT DataBridge

**Document Version:** 1.1  
**Environment:** Production / Staging (`https://staff-nsr.openg2p.dpiforall.com`)  
**Partner Mnemonic:** `CCT_DATABRIDGE`  
**Data Model:** `CCT_DATABRIDGE_INTAKE`  
**Target Register:** `Household` (`a0000000-0000-4000-8000-000000000002`)  
**Target Intake Form:** `household_intake_form` (`c1000000-0000-4000-8000-000000000002`)  
**Transformation Template:** `cct_databridge_to_nsr.json.j2` (All 8 Sections, 190+ Fields, Unlimited Household Members)

---

## 1. Webhook Endpoint & Query Parameters

- **HTTP Method:** `POST`
- **Full Endpoint URL:**
  ```text
  https://staff-nsr.openg2p.dpiforall.com/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=a0000000-0000-4000-8000-000000000002&intake_form_id=c1000000-0000-4000-8000-000000000002
  ```

| Query Parameter | Required | Value | Description |
| :--- | :--- | :--- | :--- |
| `data_model` | **Yes** | `CCT_DATABRIDGE_INTAKE` | Selects the CCT DataBridge inbound data model and Jinja2 transformation template |
| `register_id` | **Yes** | `a0000000-0000-4000-8000-000000000002` | Routes the submission to the **Household** Register |
| `intake_form_id` | **Yes** | `c1000000-0000-4000-8000-000000000002` | Routes the submission to the **Household Intake Form** (`household_intake_form`) |

---

## 2. Required HTTP Headers

| Header Name | Required | Value |
| :--- | :--- | :--- |
| `Content-Type` | **Yes** | `application/json` |

---

## 3. Request Envelope Structure (Single & Batch)

Every webhook request uses the standard OpenG2P envelope (`header`, `signature`, `message`):

| JSON Path | Required | Value / Type | Description |
| :--- | :--- | :--- | :--- |
| `$.header.message_id` | **Yes** | `string` | Unique message ID per webhook delivery (e.g. `"MSG-SINGLE-1793806587"`) |
| `$.header.sender_id` | **Yes** | `"CCT_DATABRIDGE"` | **Must be `"CCT_DATABRIDGE"`** |
| `$.header.timestamp` | **Yes** | `string (ISO-8601)` | Timestamp of message generation (e.g. `"2026-11-04T15:36:27Z"`) |
| `$.signature` | **Yes** | `string` | Non-empty signature string (e.g. `"CCT_DATABRIDGE"`) |
| `$.message` | **Yes** | `object` **or** `array` |<ul><li>**Single Record:** `$.message` is a single household object `{ ... }`</li><li>**Batch of Records:** `$.message` is `{ "records": [ { ... }, { ... } ] }` or `[ { ... }, { ... } ]` (no limit on records per batch; each record is split into its own independent `ingest_id`)</li></ul> |

---

## 4. Complete Field Mapping Reference (All 8 Sections — 190+ Fields)

There is **no limit** on the fields or number of household members DataBridge can send. Every field in the NSR `household_intake_form` is mapped in `cct_databridge_to_nsr.json.j2`, with automatic fallbacks for both **NSR form field names** and **DataBridge flat API field names**.

### Section 1: Survey & Consent (`survey_consent`)

| NSR Intake Field | Accepted DataBridge Key(s) in `$.message` | Default / Fallback | Description / Allowed Values |
| :--- | :--- | :--- | :--- |
| `sponsor` | `sponsor` | `"FEDERAL_GOVERNMENT"` | Survey sponsor (`FEDERAL_GOVERNMENT`, `STATE_GOVERNMENT`, `DEVELOPMENT_PARTNER`, `OTHER`) |
| `other_sponsor` | `other_sponsor` | `""` | Specify if `sponsor` is `OTHER` |
| `consent` | `consent` or `consent_to_share_data` (`true`/`false`) | `"YES"` | `"YES"` or `"NO"` |
| `enumerator` | `enumerator` or `coordinate_source` | `"CCT_DATABRIDGE"` | Enumerator name/code |
| `unlisted_enum` | `unlisted_enum` | `""` | Unlisted enumerator name |
| `community` | `community` or `ward` | `"Community"` | Community / Ward name |
| `individual_sn` | `individual_sn` or `nsr_household_serial` or `internal_record_id` | `""` | Household / NSR serial number |
| `hhaddress` | `hhaddress` or `household_address` | `""` | Street / physical address of household |
| `gps` | `gps` OR (`latitude`, `longitude`, `accuracy_m`) | `"0.0 0.0 0.0 0.0"` | `"lat lon alt acc"` string, or automatically formatted from `latitude`, `longitude`, `accuracy_m` |

### Section 2: Composition & Headship (`composition_and_headship`)

| NSR Intake Field | Accepted DataBridge Key(s) in `$.message` | Default / Fallback | Description / Allowed Values |
| :--- | :--- | :--- | :--- |
| `total_heads` | `total_heads` or `member_count` | `1` | Integer count of household members/heads |
| `disroster` | `disroster` | `"YES"` | `"YES"` or `"NO"` |

### Section 3: Dwelling & Services (`dwelling_and_services`)

| NSR Intake Field | Accepted DataBridge Key(s) in `$.message` | Default / Fallback | Description / Allowed Values |
| :--- | :--- | :--- | :--- |
| `roof_dwelling` | `roof_dwelling` or `roof_material` | `"1"` | Roof material code/value |
| `floor_dwelling` | `floor_dwelling` or `floor_material` | `""` | Floor material (e.g. `"CEMENT"`, `"EARTH_SAND"`, `"TILES"`) |
| `num_room` | `num_room` or `rooms_occupied` | `1` | Integer number of rooms occupied |
| `drink_dwelling` | `drink_dwelling` or `water_source` | `""` | Drinking water source (e.g. `"TUBEWELL_BOREHOLE"`, `"PIPED_WATER"`) |
| `toilet_dwelling` | `toilet_dwelling` or `sanitation_type` | `""` | Toilet facility type (e.g. `"FLUSH_TOILET"`, `"PIT_LATRINE"`) |
| `devicetype_dwelling` | `devicetype_dwelling` | `""` | Handwashing/sanitation device type |
| `light_dwelling` | `light_dwelling` or `lighting_source` | `""` | Main lighting source (e.g. `"ELECTRICITY"`, `"SOLAR"`, `"KEROSENE"`) |
| `cook_dwelling` | `cook_dwelling` or `cooking_fuel` | `""` | Main cooking fuel (e.g. `"FIREWOOD"`, `"LPG_GAS"`, `"KEROSENE"`, `"CHARCOAL"`) |

### Section 4: Vulnerability, Shocks & Coping (`vulnerability_shocks_and_coping`)

| NSR Intake Field | Accepted DataBridge Key(s) in `$.message` | Default / Fallback |
| :--- | :--- | :--- |
| `livelihoods` | `livelihoods` or `primary_livelihood` | `""` (e.g. `"CROP_FARMING"`, `"LIVESTOCK"`, `"TRADING"`) |
| `other_specify_livelihoods` | `other_specify_livelihoods` | `""` |
| `anyshocks` | `anyshocks` | `"NO"` (`"YES"` / `"NO"`) |
| `shock_type` | `shock_type` | `""` |
| `other_specify_shock` | `other_specify_shock` | `""` |
| `shock_year` | `shock_year` | `""` |
| `mechanism_type` | `mechanism_type` | `""` |
| `other_specify_mechanism` | `other_specify_mechanism` | `""` |
| `mechanism_year` | `mechanism_year` | `""` |

### Section 5: Household Health Insurance (`household_health_insurance`)

| NSR Intake Field | Accepted DataBridge Key(s) in `$.message` | Default / Fallback |
| :--- | :--- | :--- |
| `health_insurance` | `health_insurance` | `"NO"` (`"YES"` / `"NO"`) |
| `health_insurance_type` | `health_insurance_type` | `""` |
| `otherhealth_insurance_type` | `otherhealth_insurance_type` | `""` |

### Section 6: Household Assets Inventory (`household_assets_inventory` — All 68 Fields)

Every asset supports both a `"YES"`/`"NO"` ownership flag and a quantity/count field in `$.message`:

| Asset Item | Ownership Flag Key (`"YES"`/`"NO"`) | Quantity / Count Key |
| :--- | :--- | :--- |
| Master Asset Flag | `hh_items_list` | — |
| Radio | `radio` | `radio_num` |
| Television | `television` | `television_num` |
| Generator | `generator` | `generator_num` |
| Mobile Phone | `mobilephone` | `mobilephone_num` |
| Torchlight | `touchlight` | `touchlight_num` |
| Kerosene Stove | `kerosenestove` | `kerosenestove_num` |
| Landline Phone | `landphone` | `landphone_num` |
| Current House Owned | `housecurrent` | `housecurrent_num` |
| House Elsewhere | `houseelsewhere` | `houseelsewhere_num` |
| Land for Housing | `landforhousing` | `landforhousing_num` |
| Farmland | `farmland` | `farmland_num` |
| Poultry / Birds | `bird` | `birdn` |
| Goats / Sheep | `goat` | `goatn` |
| Cattle | `cattle` | `cattlen` |
| Bicycle | `bicycle` | `bicycle_num` |
| Motorcycle | `motocycle` | `motocycle_num` |
| Car / Vehicle | `car` | `car_num` |
| Canoe | `canoe` | `canoe_num` |
| Boat | `boat` | `boat_num` |
| Video / DVD Player | `video_dvd` | `video_dvdn` |
| Electric Iron | `iron_electric` | `iron_electricn` |
| Charcoal Iron | `iron_charcoal` | `iron_charcoaln` |
| Fan | `fan` | `fan_num` |
| Air Conditioner | `air_conditioner` | `air_conditionern` |
| Refrigerator | `refrigerator` | `refrigerator_num` |
| Freezer | `freezer` | `freezer_num` |
| Sofa / Lounge Furniture | `furniture_sofa` | `furniture_sofan` |
| Table / Chairs | `furniture_table` | `furniture_tablen` |
| Hi-Fi / Sound System | `hifi` | `hifi_num` |
| Mattress | `mattress` | `mattress_num` |
| Bed | `bed` | `bed_num` |
| Computer / Laptop | `computer` | `computer_num` |
| Washing Machine | `wash_machine` | `wash_machinen` |

### Section 7: Household Crops Grown (`household_crops_grown` — All 23 Fields)

| NSR Crop Field | Accepted DataBridge Key(s) in `$.message` | Default |
| :--- | :--- | :--- |
| `hh_crops_options` | `hh_crops_options` | `"NO"` |
| `Beans (Cowpea)` | `"Beans (Cowpea)"` or `crop_beans` | `"NO"` |
| `Cashew` | `"Cashew"` or `crop_cashew` | `"NO"` |
| `Cassava` | `"Cassava"` or `crop_cassava` | `"NO"` |
| `Cocoa` | `"Cocoa"` or `crop_cocoa` | `"NO"` |
| `Cocoyam` | `"Cocoyam"` or `crop_cocoyam` | `"NO"` |
| `Cottons` | `"Cottons"` or `crop_cottons` | `"NO"` |
| `Groundnut` | `"Groundnut"` or `crop_groundnut` | `"NO"` |
| `Guinea corn` | `"Guinea corn"` or `crop_guinea_corn` | `"NO"` |
| `Kolanut` | `"Kolanut"` or `crop_kolanut` | `"NO"` |
| `Maize (Corn)` | `"Maize (Corn)"` or `crop_maize` | `"NO"` |
| `Millet` | `"Millet"` or `crop_millet` | `"NO"` |
| `Oil Palm` | `"Oil Palm"` or `crop_oil_palm` | `"NO"` |
| `Potatoes` | `"Potatoes"` or `crop_potatoes` | `"NO"` |
| `Rice` | `"Rice"` or `crop_rice` | `"NO"` |
| `Rubber` | `"Rubber"` or `crop_rubber` | `"NO"` |
| `Sesame (Beniseed)` | `"Sesame (Beniseed)"` or `crop_sesame` | `"NO"` |
| `Soybeans` | `"Soybeans"` or `crop_soybeans` | `"NO"` |
| `Sugarcane` | `"Sugarcane"` or `crop_sugarcane` | `"NO"` |
| `Tobacco` | `"Tobacco"` or `crop_tobacco` | `"NO"` |
| `Yam` | `"Yam"` or `crop_yam` | `"NO"` |
| `other_crop` | `other_crop` | `"NO"` |
| `other_crop_specify` | `other_crop_specify` | `""` |

### Section 8: Household Members Roster (`household_members` — Array of Unlimited Members, 81 Fields per Member)

Pass `household_members` as a JSON array `[ { ... }, { ... } ]` inside `$.message` (or if a flat single-person record is sent without `household_members`, top-level fields on `$.message` are automatically mapped into a 1-member array):

| Category | Accepted Member Fields (per object in `household_members`) |
| :--- | :--- |
| **Demographics & Civil Status** | `surname` (or `family_name`), `firstname` (or `given_name`), `othername` (or `middle_name`), `relationship` (or `relationship_to_head` — `"HEAD"`/`"1"`, `"SPOUSE"`, `"CHILD"`, `"OTHER"`), `sex` (or `gender` — `"MALE"`/`"1"`, `"FEMALE"`/`"2"`), `year`, `month`, `day`, `age`, `maritalstatus` (or `marital_status` — `"MARRIED"`/`"1"`, `"SEPARATED"`/`"2"`, `"DIVORCED"`/`"3"`, `"WIDOWED"`/`"4"`, `"NEVER_MARRIED"`), `birthcertificate` (`"YES"`/`"NO"`) |
| **National ID (NIN) & Contact** | `validnin` (or `has_valid_nin`), `validnintype` (or `nin_type` — `"NIN"` / `"TRACKING_NUMBER"`), `nin`, `connin`, `ninsurname`, `ninfirstname`, `ninothername`, `trackid`, `contrackid`, `contactno` (or `phone_number`), `confrim_contactno` |
| **Financial & Banking** | `bank_name`, `other_bank_name`, `accountname` (or `account_name`), `accountno` (or `account_number`), `caccountno`, `bvn`, `cbvn` |
| **Labour & Economic Sector (ISIC)** | `b5labour`, `b6labour`, `agriculture`, `mining`, `manufacturing`, `electricity`, `water`, `construction`, `wholesale`, `transportation`, `accommodation`, `information`, `financial`, `real`, `professional`, `administrative`, `public`, `education`, `human`, `arts`, `b6_other` |
| **Education** | `educationalqualification`, `currentlyenrolledinschl` (`"YES"`/`"NO"`), `grade`, `outofschoolgrade`, `monthstopschool`, `yearstopschool`, `howfarisschoolenrolled` |
| **Maternal, Child Health & Nutrition** | `pregnant` (`"YES"`/`"NO"`), `lactating` (`"YES"`/`"NO"`), `benefitfromhealthcare` (`"YES"`/`"NO"`), `howfarishealthcentre`, `muac` (number or `null`), `food_nutrition` |
| **Disability (Washington Group) & Chronic Illness** | `disability` (`"YES"`/`"NO"`), `health_problem_label`, `seeing`, `hearing`, `walking`, `remembering`, `selfcare`, `communication`, `chronicallyill` (`"YES"`/`"NO"`), `chronicallyilltype`, `otherchronicallyilltype` |
| **Social Networks & Groups** | `socialnetwork_label` (`"YES"`/`"NO"`), `cooperative`, `religiousgroup`, `businessgroup`, `agegroup`, `other_social_group`, `othergroup` |

---

## 5. Complete Payload Examples

### 5.1 Single 8-Section Household Webhook Payload

```json
{
  "header": {
    "message_id": "MSG-SINGLE-1793806587",
    "sender_id": "CCT_DATABRIDGE",
    "timestamp": "2026-11-04T15:36:27Z"
  },
  "signature": "CCT_DATABRIDGE",
  "message": {
    "internal_record_id": "REC-SINGLE-0001",
    "nsr_household_serial": "HH-SINGLE-0001",
    "sponsor": "FEDERAL_GOVERNMENT",
    "consent": "YES",
    "enumerator": "ENUM-OYO-01",
    "state_name": "Oyo",
    "lga_name": "Ibadan North",
    "ward": "Ward 9",
    "community": "Ward 9 Community",
    "hhaddress": "Plot 42 Unity Road, Ibadan",
    "latitude": 7.44637,
    "longitude": 3.96521,
    "accuracy_m": 5.0,
    "total_heads": 2,
    "disroster": "YES",
    "roof_dwelling": "1",
    "floor_dwelling": "CEMENT",
    "num_room": 3,
    "drink_dwelling": "TUBEWELL_BOREHOLE",
    "toilet_dwelling": "FLUSH_TOILET",
    "light_dwelling": "ELECTRICITY",
    "cook_dwelling": "FIREWOOD",
    "livelihoods": "CROP_FARMING",
    "anyshocks": "NO",
    "health_insurance": "NO",
    "hh_items_list": "YES",
    "radio": "YES",
    "radio_num": "1",
    "mobilephone": "YES",
    "mobilephone_num": "2",
    "farmland": "YES",
    "farmland_num": "1",
    "hh_crops_options": "YES",
    "Cassava": "YES",
    "Maize (Corn)": "YES",
    "household_members": [
      {
        "surname": "Babatunde",
        "firstname": "Femi",
        "othername": "Ade",
        "relationship": "HEAD",
        "sex": "MALE",
        "year": 1988,
        "month": 5,
        "day": 12,
        "age": 38,
        "maritalstatus": "MARRIED",
        "birthcertificate": "YES",
        "validnin": "YES",
        "validnintype": "NIN",
        "nin": "99380658701",
        "contactno": "+2348023456789",
        "bank_name": "ACCESS_BANK",
        "accountname": "Femi Babatunde",
        "accountno": "2000017595",
        "bvn": "22123456789",
        "educationalqualification": "SECONDARY",
        "currentlyenrolledinschl": "NO",
        "disability": "NO",
        "chronicallyill": "NO"
      },
      {
        "surname": "Babatunde",
        "firstname": "Funke",
        "relationship": "SPOUSE",
        "sex": "FEMALE",
        "year": 1992,
        "month": 8,
        "day": 21,
        "age": 34,
        "maritalstatus": "MARRIED",
        "birthcertificate": "YES",
        "validnin": "YES",
        "validnintype": "NIN",
        "nin": "99380658702",
        "contactno": "+2348098765432",
        "pregnant": "NO",
        "lactating": "NO",
        "disability": "NO",
        "chronicallyill": "NO"
      }
    ]
  }
}
```

---

### 5.2 Batch Household Webhook Payload (`message.records`)

```json
{
  "header": {
    "message_id": "MSG-BATCH-1793806587",
    "sender_id": "CCT_DATABRIDGE",
    "timestamp": "2026-11-04T15:36:27Z"
  },
  "signature": "CCT_DATABRIDGE",
  "message": {
    "records": [
      {
        "internal_record_id": "REC-BATCH-1",
        "nsr_household_serial": "HH-BATCH-1",
        "state_name": "Kano",
        "lga_name": "Nassarawa",
        "community": "Nassarawa Ward",
        "hhaddress": "14 Emir Road, Kano",
        "roof_dwelling": "1",
        "floor_dwelling": "CEMENT",
        "num_room": 2,
        "household_members": [
          {
            "surname": "Bello",
            "firstname": "Musa",
            "relationship": "HEAD",
            "sex": "MALE",
            "year": 1985,
            "age": 41,
            "maritalstatus": "MARRIED",
            "validnin": "YES",
            "validnintype": "NIN",
            "nin": "99138065871"
          }
        ]
      },
      {
        "internal_record_id": "REC-BATCH-2",
        "nsr_household_serial": "HH-BATCH-2",
        "state_name": "Lagos",
        "lga_name": "Ikeja",
        "community": "Alausa",
        "hhaddress": "8 Obafemi Awolowo Way, Ikeja",
        "roof_dwelling": "1",
        "floor_dwelling": "CEMENT",
        "num_room": 4,
        "household_members": [
          {
            "surname": "Adeyemi",
            "firstname": "Ngozi",
            "relationship": "HEAD",
            "sex": "FEMALE",
            "year": 1992,
            "age": 34,
            "maritalstatus": "MARRIED",
            "validnin": "YES",
            "validnintype": "NIN",
            "nin": "99238065872"
          }
        ]
      }
    ]
  }
}
```

---

## 6. Expected HTTP Response

### 6.1 Success (`HTTP 200 OK`)

```json
{
  "signature": "unsigned-stub-signature",
  "header": {
    "version": "1.0.0",
    "message_id": "res-msg-id",
    "message_ts": "2026-11-04T15:36:25.123456",
    "action": "on-ingest",
    "status": "succ",
    "status_reason_code": null,
    "status_reason_message": null
  },
  "message": {
    "ack_status": "ACK",
    "timestamp": "2026-11-04T15:36:25.123456",
    "error": null,
    "correlation_id": "02de528d45974727af21069c1a4ee429"
  }
}
```

---

## 7. Quick `curl` Verification Command

```bash
curl -X POST "https://staff-nsr.openg2p.dpiforall.com/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=a0000000-0000-4000-8000-000000000002&intake_form_id=c1000000-0000-4000-8000-000000000002" \
  -H "Content-Type: application/json" \
  -d '{
    "header": {
      "message_id": "MSG-TEST-001",
      "sender_id": "CCT_DATABRIDGE",
      "timestamp": "2026-11-04T15:36:27Z"
    },
    "signature": "CCT_DATABRIDGE",
    "message": {
      "internal_record_id": "REC-TEST-001",
      "nsr_household_serial": "HH-TEST-001",
      "state_name": "Oyo",
      "lga_name": "Ibadan North",
      "ward": "Ward 9",
      "community": "Ward 9 Community",
      "hhaddress": "Plot 42 Unity Road, Ibadan",
      "roof_dwelling": "1",
      "floor_dwelling": "CEMENT",
      "num_room": 3,
      "drink_dwelling": "TUBEWELL_BOREHOLE",
      "toilet_dwelling": "FLUSH_TOILET",
      "light_dwelling": "ELECTRICITY",
      "cook_dwelling": "FIREWOOD",
      "livelihoods": "CROP_FARMING",
      "anyshocks": "NO",
      "health_insurance": "NO",
      "hh_items_list": "YES",
      "radio": "YES",
      "mobilephone": "YES",
      "farmland": "YES",
      "household_members": [
        {
          "surname": "Babatunde",
          "firstname": "Femi",
          "relationship": "HEAD",
          "sex": "MALE",
          "year": 1988,
          "month": 5,
          "day": 12,
          "age": 38,
          "maritalstatus": "MARRIED",
          "validnin": "YES",
          "validnintype": "NIN",
          "nin": "99380658701",
          "contactno": "+2348023456789",
          "bank_name": "ACCESS_BANK",
          "accountno": "2000017595"
        }
      ]
    }
  }'
```
