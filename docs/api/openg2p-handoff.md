# CCT DataBridge ↔ OpenG2P: integration handoff (draft v1)

DataBridge exposes two JSON endpoints. With **push**, OpenG2P sends a record to DataBridge. With **pull**, OpenG2P fetches records DataBridge has ingested from other registries. Field names and codes are those of the *NSR Registry Build Sheet*. Every value in this document is synthetic.

## Access

- **Base URL:** `http://<host>:<port>/api/v1`. We send you the host, the port and the connection method (SSH tunnel, TLS endpoint or private network).
- **Authentication:** send header `X-API-Key: <key>` on every `/records` call. We share the key through a password manager or one-time link. A missing or wrong key returns `401`.
- **Check connectivity:** `GET /health` needs no key. It returns `{"status":"ok","mode":"integration"}`.

## Push: `POST /records`

Send one record per request, with `Content-Type: application/json`, up to 64 KB.

Required fields:

- **Record ID:** `internal_record_id` (your record ID)
- **Household:** `nsr_household_serial`, `household_address`, `consent_to_share_data`
- **Location:** `state_id`, `state_name`, `lga_id`, `lga_name`, `ward`, `community`
- **Person:** `given_name`, `family_name`, `birth_date` (`YYYY-MM-DD`), `gender`, `relationship_to_head`, `has_valid_nin`
- **Data type:** `synthetic` (`true` for test data, `false` for real records)

Required only in some cases:

- `nin_type` when `has_valid_nin` is true
- `nin` when `nin_type` = `"1"`
- `bank_name` and `account_name` when `account_number` is sent

Other rules:

- Codes are strings from the sheet's code lists, for example `gender` `"1"` male, `"0"` female.
- A field name that is not in the sheet is rejected, so leave unknown fields out.
- A `null` or `""` value counts as not sent.

```json
{
  "internal_record_id": "OG2P-IND-000001",
  "nsr_household_serial": "NSR-HH-000151",
  "household_address": "72 Market Road",
  "consent_to_share_data": true,
  "state_id": "NG-OY", "state_name": "Oyo", "lga_id": "OY-LGA-12", "lga_name": "Ibadan North",
  "ward": "Ward 9", "community": "Ward 9 Community",
  "given_name": "Chinedu", "family_name": "Eze", "birth_date": "1990-11-25",
  "gender": "1", "relationship_to_head": "1",
  "has_valid_nin": true, "nin_type": "1", "nin": "99000001035",
  "synthetic": true
}
```

| Outcome | HTTP | Response |
|---|---|---|
| New record | `201` | `{"status":"CREATED","internal_record_id":"OG2P-IND-000001","version":1,"received_at":"…","updated_at":"…","warnings":[]}` |
| Identical repeat (safe to retry) | `200` | `"status":"UNCHANGED"`; nothing is written |
| Same ID, changed content | `200` | `"status":"UPDATED"`; `version` goes up by 1 |
| Breaks a field rule | `422` | `{"error":{"code":"VALIDATION_FAILED","details":[{"field":"family_name","code":"REQUIRED_FIELD_MISSING","message":"family_name is required"}],"traceId":"…"}}` |
| Bad JSON, or a field not in the sheet | `400` | Same error shape |

## Pull: `GET /records`

| Parameter | Use |
|---|---|
| `changed_by=databridge-ingestion` | **Always send this.** You then never read back your own pushes |
| `updated_since=<ISO time>` | Only records changed after this time |
| `page` (from 1), `page_size` (1–200, default 50) | Paging |

```json
{
  "view": "masked",
  "items": [{
    "record": { "internal_record_id": "SR1-0000001", "given_name": "C******", "birth_date": "1990-**-**", "nin": "*******1035", "gender": "1", "…": "…" },
    "meta": { "version": 1, "received_at": "2026-11-01T17:40:40.014Z", "updated_at": "2026-11-01T17:40:40.014Z", "origin": "databridge-ingestion" }
  }],
  "page": 1, "page_size": 50, "total": 31, "has_more": false
}
```

- **Records are masked.**
  - NIN, BVN and account details show the last 4 characters.
  - Names, address, phone and date of birth are partly masked.
  - Health and religion fields are left out.
  - Unmasked access is a separate key that we issue only after the data owner approves it.
- **Sync loop:**
  1. Call with `updated_since=<watermark>`.
  2. Keep paging while `has_more` is true.
  3. Save the largest `meta.updated_at` as the next watermark.
- **Pushing changes back:** keep the pulled `internal_record_id` (for example `SR1-0000001`); a new ID creates a duplicate. Never push masked values (anything containing `***`); they are rejected with `422`.

## Quick test

```bash
BASE=http://<host>:<port>/api/v1
KEY='<key we send you>'
curl -s $BASE/health
curl -s -X POST $BASE/records -H "X-API-Key: $KEY" -H "Content-Type: application/json" --data @openg2p-push-record.json
curl -s "$BASE/records?changed_by=databridge-ingestion&page=1&page_size=50" -H "X-API-Key: $KEY"
```

`openg2p-push-record.json` is the sample payload; we send it with this document. Other codes you may see:

| Code | Meaning |
|---|---|
| `401` | Bad key |
| `404` / `405` | Wrong path or method |
| `413` | Body over 64 KB |
| `415` | `Content-Type` is not JSON |
| `500` | Unexpected error; send us the `traceId` |

## What we need from you

**Before we connect:**

1. **Direction.** Which records will you push, and which will you pull? DataBridge also writes ingested records into OpenG2P through `/partner/ingest_data`, and the same record must not arrive by two routes.
2. **Record ID.** Is `internal_record_id` unique and stable for the life of a record? Can you keep our `SR1-…` ID on records you pull?
3. **Codes.** Do you use the build sheet's code lists (gender, relationship, bank, and so on)? If not, please send your lists so we can map them.
4. **Network.** Where does OpenG2P run (Kubernetes, Docker or VM), and what is its outbound IP or subnet? Can you use an SSH tunnel or a TLS endpoint? Who is the technical contact for the key?

**During integration:**

5. **Derived fields.** Will you send `household_name`, `member_count`, `is_household_head` and `geo_lowest_level_value_id`? Is one record per individual acceptable?
6. **Ordering.** Can you send a version number or "last updated" time, so a late retry never overwrites newer data?
7. **Conditional fields.** When are `nin_tracking_number`, `bvn` and `account_number` required? For example, `nin_tracking_number` when `nin_type` = `"2"`?
8. **Sensitive fields.** Which masked fields do you need unmasked, and for what purpose?

**Later:**

9. **Volume and production auth.** Expected records per day and at peak, whether you need a batch endpoint, and when to move from an API key to OIDC.
