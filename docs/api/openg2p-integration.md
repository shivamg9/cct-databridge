# OpenG2P integration: push and pull record API (v1, draft reference)

Two REST endpoints let OpenG2P send records to CCT DataBridge (push) and fetch records from it (pull). This is the full reference; the short version for the OpenG2P developer is [openg2p-handoff.md](openg2p-handoff.md).

> **Prototype status.** A local Node service with a JSON-file store. It is not connected to any OpenG2P deployment. Field rules come from `NSR_Registry_Build_Sheet.xlsx`, whose mandatory flags are still proposals.

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/records` | Push one record (create, or update by `internal_record_id`) |
| `GET` | `/api/v1/records` | Pull records, paged; masked unless full access is granted |
| `GET` | `/api/v1/health` | Liveness check and current mode (no key needed) |

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `DATABRIDGE_MODE` | `demo` | `demo` accepts synthetic records only. `integration` also accepts real records (see below) |
| `HOST` | `127.0.0.1` | Listen address. `0.0.0.0` listens on all interfaces; refused unless `DATABRIDGE_API_KEY` is set |
| `PORT` | `8080` | Port |
| `DATABRIDGE_API_KEY` | not set | Standard key: push and masked pull. Required in integration mode |
| `DATABRIDGE_FULL_ACCESS_KEY` | not set | Optional second key: unmasked pull. If not set, nobody can pull unmasked data |
| `DATABRIDGE_DATA_FILE` | `server/data/<mode>-records.json` | Record store. Demo and integration use separate files |
| `DATABRIDGE_ACCESS_LOG` | `<data file>.access-log.jsonl` | One line per unmasked pull |

Keys are read only from the environment. Never commit them or put them in documents; share them through a password manager or one-time secret link. To rotate a key, restart the service with a new value.

## 1. Synthetic data and real records

The service refuses unsafe settings at startup:

| | `demo` (default) | `integration` |
|---|---|---|
| `"synthetic": false` | Rejected (`422`) | Accepted |
| `synthetic` left out | Defaults to `true` | Rejected (`422`): the caller must say `true` or `false`, so a real record can never be stored labelled as test data, or the reverse |
| API key | Optional (local only) | Required, or the service will not start |
| `nin` not starting with `99` (the project's synthetic NIN prefix) | Rejected (`422`) | Accepted |
| Store already holds a record with `synthetic = false` | Service refuses to start | Allowed |
| `--seed-demo` | Allowed | Refused, so synthetic records never mix into the integration store |
| Default store | `server/data/demo-records.json` | `server/data/integration-records.json` |

Switching to real records is a deliberate operator action: set `DATABRIDGE_MODE=integration`.

Demo mode cannot prove a record is synthetic. It relies on the `synthetic` flag and the `99` NIN prefix, and it listens on `127.0.0.1` unless a key is set. A real record without a NIN and labelled `synthetic: true` would still be accepted. **Never point an OpenG2P instance that holds real data at a demo-mode service.**

Before the first real record is sent, all of these must be true:

1. The connection is encrypted. Use the SSH tunnel or TLS proxy described in §4, not plain HTTP across a network.
2. The host is approved to hold personal data. The JSON store is **not encrypted** (see §5).
3. The data owner has approved, in writing, which fields OpenG2P sends, and who holds the full-access key.

## 2. Sensitive fields

Pull applies the sheet's own *Sensitivity* and *Masking* columns, so no new policy is invented:

| Sheet sensitivity | Fields | In a masked pull |
|---|---|---|
| High (health), High (religion): 16 fields, marked "purpose-based access only" | `pregnant`, `lactating`, `muac`, the disability, chronic-illness and nutrition fields, `member_religious_group` | **Left out** |
| High: 5 fields, "last 4 visible" | `nin`, `nin_tracking_number`, `bvn`, `account_number`, `account_name` | `"*******1035"` |
| Medium: 14 fields, "partially masked" | names, `household_name`, `household_address`, `phone_number`, `email`, `birth_date`, coordinates | Strings show only the first character (`"C******"`, `"+*************"`). Dates show the year (`"1990-**-**"`). Numbers (`latitude`, `longitude`, `accuracy_m`) are left out |
| Low: 110 fields | codes, locations, household facts | Unchanged |

Access has two levels:

- **Standard key** (`DATABRIDGE_API_KEY`): can push, and always receives the masked view. The response says `"view": "masked"`.
- **Full-access key** (`DATABRIDGE_FULL_ACCESS_KEY`): unmasked pull. It exists only when the operator sets it, and that act is the explicit decision.
  - Every unmasked pull must send `X-Access-Purpose: <reason, at least 10 characters>`. Without it the request gets `400 PURPOSE_REQUIRED`.
  - Each unmasked pull appends a line to the access log: time, trace ID, purpose, query and record IDs. Values are never logged.
  - The response says `"view": "full"`.

Masking is applied on the way out only; the store keeps the real values. If a masked value is pushed back (any string containing `***`), it is rejected with `422 MASKED_VALUE`. A masked pull can therefore never overwrite real data.

## 3. Direction: telling the two flows apart and preventing loops

Every stored record carries two markers:

- `meta.origin` is who **created** it:
  - `openg2p-push` for a record that arrived through `POST /api/v1/records`
  - `databridge-ingestion` for a record that came through the source-registry pipeline (NASSCO, state registries, uploads)
  - It never changes, and pull returns it.
- `last_changed_by` is who changed it **last**. It uses the same two values and is used by the `changed_by` pull filter.

A push that updates an ingested record keeps that record's `data_source`, `record_status`, `country_code` and `synthetic` values unless the push sends new ones.

Three rules prevent push-pull loops and duplicate processing:

1. **OpenG2P pulls with `changed_by=databridge-ingestion`.** It then never reads back records it created or last changed itself.
2. **Identical repeats are no-ops.** Pushing a record with the same content returns `200 UNCHANGED` without touching `version` or `updated_at`, so it does not appear in the next incremental pull. A pulled record pushed back unchanged ends the cycle.
3. **Keep the ID.** When OpenG2P stores a pulled record, it must keep the pulled `internal_record_id` (for example `SR1-0000001`) when pushing changes back. A push under a new ID creates a second record. See open question 2.

Separately, DataBridge's own pipeline writes ingested records to OpenG2P (Master Registry 1) through `/partner/ingest_data`. If OpenG2P then pushes those same records here, they arrive as `openg2p-push` changes of new IDs. The direction question (open question 1) has to be settled before both paths run together.

## 4. Access from the OpenG2P environment

By default the service listens on `127.0.0.1` only. To make it reachable from delpyment environment:

```powershell
# On the DataBridge host (Windows PowerShell). Generate a key once:
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

$env:DATABRIDGE_MODE    = 'demo'          # or 'integration' (see §1)
$env:HOST               = '0.0.0.0'       # listen on all interfaces
$env:PORT               = '8080'
$env:DATABRIDGE_API_KEY = '<generated key>'
node server/api.js --seed-demo           # --seed-demo only in demo mode
```

```bash
# Linux / macOS equivalent
DATABRIDGE_MODE=demo HOST=0.0.0.0 PORT=8080 DATABRIDGE_API_KEY='<generated key>' node server/api.js --seed-demo
```

**Network.**

1. Find the host's address on the network deployed env can reach. On Windows, run `(Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' }).IPv4Address.IPAddress`; on Linux, `ip route get 1 | awk '{print $7}'`. Ignore `169.254.x.x` addresses and virtual adapters such as WSL or Hyper-V.
2. Open the port only to deploy's address or subnet, never to "any":

```powershell
New-NetFirewallRule -DisplayName "CCT DataBridge API (test)" -Direction Inbound -Protocol TCP `
  -LocalPort 8080 -RemoteAddress <deploy-IP-or-subnet> -Action Allow
# remove later: Remove-NetFirewallRule -DisplayName "CCT DataBridge API (test)"
```

```bash
sudo ufw allow from <deploy-IP-or-subnet> to any port 8080 proto tcp   # Linux
```

3. From the OpenG2P side, check with `curl http://<databridge-host>:8080/api/v1/health`. It should return `{"status":"ok","mode":"demo"}`.
   - If OpenG2P runs in Kubernetes (the OpenG2P Deploy Kit), the pod or namespace needs egress to `<databridge-host>:8080`.
   - If OpenG2P runs in Docker on the same machine, use `http://host.docker.internal:8080`.

**Encryption.** The service speaks plain HTTP, so the key and the records travel unencrypted. Pick one of these:

| Option | When | How |
|---|---|---|
| **SSH tunnel** (simplest) | Testing; deploy has SSH access to the host | Keep `HOST=127.0.0.1`. deploy runs `ssh -N -L 8080:127.0.0.1:8080 <user>@<databridge-host>` and calls `http://127.0.0.1:8080` |
| **TLS reverse proxy** | Shared integration environment | Keep `HOST=127.0.0.1` and put nginx, Caddy or the cluster ingress in front with a certificate. deploy calls `https://<name>/api/v1/...` |
| Plain HTTP on a private network or VPN | Synthetic demo data only | `HOST=0.0.0.0` with the firewall rule above. Never use this for real records |

Do not expose the port to the public internet.

## 5. Storage: JSON file now, database later

The store is one JSON file, loaded into memory at start and rewritten in full on every change (written to a temporary file, then renamed). That is fine for integration testing. It is not production storage:

| Limitation | Effect |
|---|---|
| Single process only | Two instances on the same file would overwrite each other's changes |
| Whole file rewritten per change | Writes slow down as the store grows; suitable for thousands of records, not millions |
| Everything held in memory | Memory grows with the store |
| No encryption at rest | Personal data sits in plain text on disk; the host's disk encryption is the only protection |
| No history | An update replaces the record; only the version number shows it changed |
| No backup or retention | Deleting the file deletes everything; the sheet's retention policy is not applied |
| Timestamp paging | Records changed in the same millisecond as the watermark could be skipped by `updated_since` |

**To move to a database** (for example the platform's PostgreSQL), replace `createStore` in `server/records.js`. The HTTP contract does not change.

1. Create a table:
   - `internal_record_id` as the primary key
   - `record` (JSONB) for the fields
   - `version`, `content_hash`, `origin`, `last_changed_by`, `received_at`, `updated_at`
   - an index on `(updated_at, internal_record_id)`
2. Push becomes one `INSERT … ON CONFLICT (internal_record_id) DO UPDATE … WHERE content_hash <> excluded.content_hash`. This keeps "identical repeat = no-op" safe under concurrent requests.
3. Pull uses keyset paging, `WHERE (updated_at, internal_record_id) > (:since, :last_id)`, instead of page numbers. This fixes the same-millisecond gap.
4. Encrypt sensitive columns or the volume, move the access log to the audit store, and add a history table if earlier versions must be kept.

## 6. Contract check against the Excel sheet

I checked this against the workbook directly (*Create Fields*, 145 rows), not only against the generated `schema.js`.

| Check | Result |
|---|---|
| Field names | All push and pull field names are sheet names. Any other name is rejected (`400 UNKNOWN_FIELD`). The sample payload has none |
| Types, code lists, formats, ranges | Taken from the sheet: 12 data types, the *Code Lists* tab, and the format rules for phone, email, NIN, BVN and account number |
| Mandatory = Yes (24 fields) | **15 source fields are required on push**: `nsr_household_serial`, `household_address`, `consent_to_share_data`, `state_id`, `state_name`, `lga_id`, `lga_name`, `ward`, `community`, `given_name`, `family_name`, `birth_date`, `gender`, `relationship_to_head`, `has_valid_nin`. **`internal_record_id`** is also required; it is the record key. **4 system fields** are filled by DataBridge when absent: `record_status`, `country_code`, `data_source`, `synthetic` (in integration mode `synthetic` must be sent). **4 derived fields** are **optional for now**, which deviates from the sheet: `household_name`, `member_count`, `is_household_head`, `geo_lowest_level_value_id` (open question 3) |
| Conditional (7 fields) | **Enforced**, the same rules as the ingestion pipeline: `nin_type` when `has_valid_nin` is true; `nin` when `nin_type` = `"1"` (NIN); `bank_name` and `account_name` when `account_number` is sent. **Not enforced**: `nin_tracking_number`, `account_number` and `bvn`. The sheet marks them conditional but states no condition. The obvious candidate, `nin_tracking_number` when `nin_type` = `"2"` (Tracking Number), is open question 6 |
| Warnings (non-blocking) | `CONSENT_NOT_GIVEN` when `consent_to_share_data` is false. Coordinates outside Nigeria's bounds also return a warning |

## Push: `POST /api/v1/records`

One record per request, as a flat JSON object, with header `Content-Type: application/json`. The body limit is 64 KB. A field sent as `null` or `""` is treated as not sent.

| Sheet data type | JSON to send | Example |
|---|---|---|
| string | string, max 200 chars (trimmed) | `"72 Market Road"` |
| enumeration | code from the sheet's code list, as a string (an integer is also accepted) | `"gender": "1"` |
| enumeration (multi) | non-empty array of codes | `"shock_types": ["1", "3"]` |
| boolean | `true` / `false` (also `"yes"`/`"no"`, `1`/`0`, as the sheet allows) | `"has_valid_nin": true` |
| integer | JSON integer | `"member_count": 4` |
| decimal | JSON number | `"latitude": 7.44637` |
| date | a real `"YYYY-MM-DD"` date, not in the future, age ≤ 120 | `"birth_date": "1990-11-25"` |
| json | JSON object | `"geo_code_hierarchy_json": {"country": "NG"}` |

Sample request: [openg2p-push-record.json](../samples/openg2p-push-record.json). The responses:

| Situation | HTTP | `status` |
|---|---|---|
| New `internal_record_id` | `201` | `CREATED`, version 1 |
| Same ID, identical content | `200` | `UNCHANGED`: nothing is written |
| Same ID, different content | `200` | `UPDATED`: the version goes up by 1 |
| Breaks a sheet rule | `422` | `error.details` lists every problem, one per field, without repeating values |

## Pull: `GET /api/v1/records`

| Query parameter | Default | Rule |
|---|---|---|
| `page` | `1` | integer ≥ 1 |
| `page_size` | `50` | integer 1–200 |
| `updated_since` | none | ISO 8601. Returns only records changed after this time |
| `changed_by` | none | `databridge-ingestion` or `openg2p-push` |

The response is `{ view, items: [{ record, meta: { version, received_at, updated_at, origin } }], page, page_size, total, has_more }`, ordered by `updated_at`, oldest first.

For an incremental sync:

1. Call with `updated_since=<watermark>&page=1`.
2. Keep requesting the next page while `has_more` is true.
3. Store the largest `meta.updated_at` as the next watermark.

## Status codes

| Code | When |
|---|---|
| `200` / `201` | Success (`201` = record created) |
| `400` | Invalid JSON, not a single object, a field name not in the sheet, a bad query parameter, or a full-access pull without `X-Access-Purpose` |
| `401` | `X-API-Key` missing or wrong |
| `404` / `405` | Unknown path / method not allowed (see the `Allow` header) |
| `413` / `415` | Body over 64 KB / `Content-Type` is not JSON |
| `422` | The record breaks a sheet rule, a masked value was sent, or `synthetic` is missing in integration mode |
| `500` | Unexpected error; quote `traceId` |

Every error looks like `{"error": {"code", "message", "details": [{"field", "code", "message"}], "traceId"}}`. Every response carries `X-Trace-Id`.
