# OpenG2P NSR webhook integration (outbound)

CCT DataBridge sends households to the OpenG2P National Social Registry (NSR) Household Register through the NSR partner ingestion endpoint. This is the reference for developers and the NSR integration team. Field-level detail is in [nsr-field-mapping.md](nsr-field-mapping.md); day-to-day operation is in [../operations/nsr-delivery-operations.md](../operations/nsr-delivery-operations.md); rollout is in [../operations/nsr-deployment-runbook.md](../operations/nsr-deployment-runbook.md).

> **Status (backend 0.7.0).** Implemented and tested against a mock of the NSR endpoint only. **Not yet sent to the real NSR.** The webhook is off by default (`NSR_WEBHOOK_ENABLED=false`) and stays off until the NSR team answers the open questions below.

## 1. What is sent where

| | |
|---|---|
| Method and URL | `POST https://staff-nsr.openg2p.dpiforall.com/partner/ingest_data?data_model=CCT_DATABRIDGE_INTAKE&register_id=a0000000-0000-4000-8000-000000000002&intake_form_id=c1000000-0000-4000-8000-000000000002` |
| Header | `Content-Type: application/json` (no other header: the specification defines no authentication) |
| Partner (sender) | `CCT_DATABRIDGE` |
| Register / form | Household (`a0000000-…-0002`) / `household_intake_form` (`c1000000-…-0002`), confirmed in the NSR repository's `g2p_intake_form_definitions.sql` |
| NSR transformation | `cct_databridge_to_nsr.json.j2` (on the NSR side) |

Envelope:

```json
{
  "header": { "message_id": "CCTDB-1793862266000-3f9a1c2b7d10", "sender_id": "CCT_DATABRIDGE", "timestamp": "2026-11-05T10:00:00Z" },
  "signature": "<NSR_WEBHOOK_SIGNATURE>",
  "message": { "...one household..." }
}
```

`message` takes one of three shapes:

| Format (`batch_format`) | `message` | Used for |
|---|---|---|
| `single` | one household object | `POST /api/v1/nsr/submit` |
| `records` (default for batches) | `{ "records": [household, ...] }` | `POST /api/v1/nsr/submit/batch` |
| `array` | `[household, ...]` | `POST /api/v1/nsr/submit/batch` with `"batch_format": "array"` |

Each household object holds the household-level keys once and the members in `household_members` (head first). Keys use the NSR form names (for example `hhaddress`, `num_room`, `surname`, `contactno`); see the mapping document for all 202.

## 2. Architecture and data flow

```
 stored member records (JSON store, unchanged)
        │ group by nsr_household_serial
        ▼
 household-mapper.js ── mapping.json (one entry per NSR field) ──► household object + errors + warnings
        │
 POST /api/v1/nsr/preview ──► operator reviews (masked unless demo unmasked pull)
        │ "confirm": true, NSR submit key, X-Operator-Id
 POST /api/v1/nsr/submit[/batch]
        │ delivery written to disk (PENDING, in flight) ── audit line
        ▼
 client.js ── HTTPS POST /partner/ingest_data ──► NSR
        │ classify the answer
        ▼
 ACCEPTED / REJECTED / RETRY_SCHEDULED / CONFIRMATION_PENDING / DELIVERY_FAILED ── audit line, log line
        ▲
 retry timer (every 5 s): resends due RETRY_SCHEDULED deliveries only
```

Code: `server/integrations/nsr/`

| File | Role |
|---|---|
| `config.js` | Settings from the environment; refuses unsafe combinations at startup |
| `mapping.json` | Machine-readable mapping: 126 household entries (121 from the specification + 5 context keys), 81 member entries, and the 21 canonical fields that are not sent |
| `household-mapper.js` | Groups records into households, checks them, interprets `mapping.json`, masks previews |
| `payload-builder.js` | The OpenG2P envelope, message IDs, timestamps |
| `client.js` | HTTPS client (Node built-ins) and response classification |
| `delivery-store.js` | Durable delivery state (JSON file, atomic rename) and the JSONL audit trail |
| `delivery-service.js` | Preview, submit, dispatch, retry, reconcile, recovery after restart, retry timer |

Nothing is sent automatically: not at startup, not when demo records are seeded, not on push or pull. Only `submit` requests from an operator create deliveries. The timer only resends deliveries that were already submitted and are due for a retry.

## 3. DataBridge API

All endpoints need `X-API-Key`. Submit, retry and reconcile need the **NSR submit key** (`DATABRIDGE_NSR_SUBMIT_KEY`, a separate key held only by operators) and an `X-Operator-Id` header (who is acting, 3-64 characters; written to the audit trail). The standard key gets `403 NSR_SUBMIT_FORBIDDEN` on these. While the webhook is off, they all return `503 NSR_WEBHOOK_DISABLED` and nothing is stored or sent.

| Method | Path | Key | Purpose |
|---|---|---|---|
| `GET` | `/api/v1/nsr/config` | API | Settings and limits, without secrets (`signature_configured: true/false`) |
| `GET` | `/api/v1/nsr/households[?status=READY]` | API | Households with status, member count, area, blocking reasons (codes) and latest delivery. No personal values |
| `POST` | `/api/v1/nsr/preview` | API | `{ "household_serials": [...], "batch_format"? }`: validation results and the exact request NSR would receive. Never sends |
| `POST` | `/api/v1/nsr/submit` | submit | `{ "household_serial": "...", "confirm": true, "resubmit"? }` |
| `POST` | `/api/v1/nsr/submit/batch` | submit | `{ "household_serials": [...], "batch_format"?: "records" \| "array", "confirm": true, "resubmit"? }` |
| `GET` | `/api/v1/nsr/deliveries[?status=&household_serial=&page=&page_size=]` | API | Delivery list, newest first |
| `GET` | `/api/v1/nsr/deliveries/{id}` | API | One delivery with every attempt. The payload is not returned |
| `POST` | `/api/v1/nsr/deliveries/{id}/retry` | submit | Send again now. For `CONFIRMATION_PENDING`, needs `{ "confirm_not_received": true }` |
| `POST` | `/api/v1/nsr/deliveries/{id}/reconcile` | submit | For `CONFIRMATION_PENDING`: `{ "outcome": "ACCEPTED" \| "NOT_RECEIVED", "note": "...", "correlation_id"? }` |

Optional header on submit: `Idempotency-Key` (8-100 characters). A repeat with the same key returns the original delivery (`200`) instead of creating a new one.

### Preview response

```json
{
  "status": "READY",
  "webhook_enabled": false,
  "view": "masked",
  "households": [{ "household_serial": "NSR-HH-000153", "status": "READY", "members": 1, "record_ids": ["SR1-0000007"],
                   "errors": [], "warnings": [{ "code": "NSR_DEFAULT_APPLIES", "field": "sponsor", "message": "not sent; NSR will record \"FEDERAL_GOVERNMENT\"" }],
                   "content_hash": "…", "deliveries": [] }],
  "request": { "method": "POST", "url": "https://staff-nsr…/partner/ingest_data?…", "headers": { "Content-Type": "application/json" }, "format": "single",
               "body": { "header": { "message_id": "(assigned at submission)", "sender_id": "CCT_DATABRIDGE", "timestamp": "…" }, "signature": "(NSR_WEBHOOK_SIGNATURE, not shown)", "message": { "…": "…" } } },
  "body_bytes": 852
}
```

Values follow the pull rules: masked by the build sheet's sensitivity, except with `DATABRIDGE_UNMASKED_PULL=true` (demo only) or the full-access key with `X-Access-Purpose` (logged). The signature is never shown.

**Blocking errors** (the household cannot be sent): `CONSENT_NOT_GIVEN`, `CONSENT_MISSING`, `NO_HEAD`, `MULTIPLE_HEADS`, `HEAD_CONFLICT`, `MEMBER_COUNT_MISMATCH`, `MEMBER_COUNT_MISSING`, `DUPLICATE_MEMBER`, `HOUSEHOLD_FIELD_CONFLICT`, `MIXED_SYNTHETIC`, `SYNTHETIC_NOT_ALLOWED`, `TOO_MANY_MEMBERS`, `HOUSEHOLD_NOT_FOUND`.

**Warnings** (sent, but the operator and the NSR team should know): `NSR_DEFAULT_APPLIES` (NSR will fill a default for a value DataBridge does not have), `VALUE_FORMAT_UNCONFIRMED` (codes whose NSR vocabulary is not confirmed), `VALUE_GENERALISED` (for example a grandchild sent as relationship `OTHER`), `VALUE_NOT_SENT`.

### Submit errors

| Status | Code | Meaning |
|---|---|---|
| `400` | `CONFIRMATION_REQUIRED`, `INVALID_REQUEST`, `OPERATOR_REQUIRED` | Missing `"confirm": true`, bad body, or no `X-Operator-Id` |
| `401` | `UNAUTHORISED` | No or wrong `X-API-Key` |
| `403` | `NSR_SUBMIT_FORBIDDEN` | Not the NSR submit key |
| `409` | `DUPLICATE_SUBMISSION` | `details[].code`: `DELIVERY_IN_PROGRESS`, `ALREADY_ACCEPTED` (same content), `ACCEPTED_BEFORE_CHANGED` (needs `"resubmit": true`) |
| `409` | `IDEMPOTENCY_KEY_REUSED` | The key was used for other households |
| `413` | `BATCH_TOO_LARGE` | More households than `NSR_WEBHOOK_MAX_BATCH_HOUSEHOLDS`, or the message larger than `NSR_WEBHOOK_MAX_BODY_BYTES`. Nothing is truncated; split the batch |
| `422` | `VALIDATION_FAILED` | At least one household is blocked; `details` lists each household's errors. Nothing is sent |
| `503` | `NSR_WEBHOOK_DISABLED` | The webhook is off |

A successful submit returns `201` with the delivery after its first attempt (status `ACCEPTED`, `REJECTED`, `RETRY_SCHEDULED`, `CONFIRMATION_PENDING` or `DELIVERY_FAILED`).

## 4. Acknowledgements: what "ACCEPTED" means

NSR ingestion is asynchronous. The NSR answer (specification §6) is recorded in `ack`: `action`, `status`, `status_reason_code`, `status_reason_message`, `ack_status`, `correlation_id`, plus NSR's response `message_id`.

- `ACCEPTED` means NSR returned `ack_status: "ACK"` (and `header.status: "succ"`): it accepted the message for processing. It is **not** proof the household is in the register. Every delivery carries `registry_commit: "NOT_CONFIRMED"`; DataBridge cannot change that until NSR offers a status check (open question 4).
- Batches: the specification says each record gets its own `ingest_id`, but the acknowledgement has one `correlation_id`. DataBridge records that one ID for the whole delivery.
- Reason texts from NSR are stored with long digit runs removed (`[redacted]`) and cut to 300 characters; they are never logged.

## 5. Retry and idempotency

| NSR outcome | Delivery status | Automatic retry |
|---|---|---|
| `200` + `ACK` | `ACCEPTED` | — |
| `200` + `NACK`/`ERR` or `status` not `succ`; `400`, `409`, `413`, `422` and other 4xx | `REJECTED` | No. Fix the data, then submit again |
| `401`, `403`, `404`; TLS/certificate errors | `DELIVERY_FAILED` | No. Configuration or registration problem |
| Connection refused, DNS failure, host unreachable; `408`, `429`, `502`, `503` | `RETRY_SCHEDULED` | Yes |
| `500`, `504`, timeout after the request was sent, connection dropped mid-request, `2xx` without a readable acknowledgement, DataBridge stopped while sending | `CONFIRMATION_PENDING` | **No** |

- **Why uncertain outcomes are not resent automatically**: the household may already be in NSR. A blind resend could create it twice, and the specification gives no way to deduplicate. An operator checks NSR and reconciles (`ACCEPTED`, or `NOT_RECEIVED` then retry).
- **Backoff**: exponential with jitter. Attempt *n* waits between half and all of `min(NSR_WEBHOOK_RETRY_MAX_MS, NSR_WEBHOOK_RETRY_BASE_MS × 2^(n-1))` (defaults: 30 s base, 30 min cap). After `NSR_WEBHOOK_MAX_RETRIES` (default 5) automatic retries, the delivery becomes `DELIVERY_FAILED` (the dead-letter state, `last_reason` says "retries used up"). A manual retry gives it a fresh allowance.
- **Same message ID on retries**: every attempt of one delivery reuses its `message_id` and timestamp, so NSR can recognise a repeat if it deduplicates (open question 5). A new submission gets a new ID.
- **Duplicate protection**: a household with a delivery in `PENDING`, `RETRY_SCHEDULED` or `CONFIRMATION_PENDING` cannot be submitted again. An `ACCEPTED` household with the same content cannot be resubmitted; with changed content it needs `"resubmit": true`. `Idempotency-Key` makes a client's own retries safe.
- **Durability**: the delivery is written to disk, marked in flight, before each send. After a crash or restart, an in-flight delivery becomes `CONFIRMATION_PENDING`; `RETRY_SCHEDULED` deliveries resume. The store is one JSON file on the same volume as the records, which suits the single-replica deployment (the backend must stay at 1 replica).

## 6. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `NSR_WEBHOOK_ENABLED` | `false` | Master switch. Off: preview only |
| `NSR_WEBHOOK_BASE_URL` | `https://staff-nsr.openg2p.dpiforall.com` | Scheme and host only. Must be `https` (plain `http` only for loopback or with `NSR_WEBHOOK_INSECURE_TEST_ENDPOINT=true`, for the mock) |
| `NSR_WEBHOOK_DATA_MODEL` | `CCT_DATABRIDGE_INTAKE` | `data_model` query parameter |
| `NSR_WEBHOOK_REGISTER_ID` | `a0000000-0000-4000-8000-000000000002` | `register_id` |
| `NSR_WEBHOOK_INTAKE_FORM_ID` | `c1000000-0000-4000-8000-000000000002` | `intake_form_id` |
| `NSR_WEBHOOK_PARTNER_ID` | `CCT_DATABRIDGE` | `header.sender_id` |
| `NSR_WEBHOOK_SIGNATURE` | — (**secret**) | `signature`. Required when enabled |
| `DATABRIDGE_NSR_SUBMIT_KEY` | — (**secret**) | Key that may submit, retry and reconcile. Required when enabled; must differ from the other keys |
| `NSR_WEBHOOK_ALLOW_SYNTHETIC` | `false` | Allow `synthetic: true` households. Only for an approved test in staging |
| `NSR_WEBHOOK_TIMEOUT_MS` | `20000` | Per request. Keep below the frontend proxy's 30 s read timeout |
| `NSR_WEBHOOK_MAX_RETRIES` | `5` | Automatic retries before `DELIVERY_FAILED` |
| `NSR_WEBHOOK_RETRY_BASE_MS` / `_MAX_MS` | `30000` / `1800000` | Backoff base and cap |
| `NSR_WEBHOOK_WORKER_INTERVAL_MS` | `5000` | How often due retries are checked |
| `NSR_WEBHOOK_MAX_BATCH_HOUSEHOLDS` | `50` | Households per message |
| `NSR_WEBHOOK_MAX_MEMBERS` | `50` | Members per household |
| `NSR_WEBHOOK_MAX_BODY_BYTES` | `2097152` (2 MiB) | Message size |
| `NSR_WEBHOOK_DELIVERY_FILE` | `<data dir>/<mode>-nsr-deliveries.json` | Delivery state; the audit trail is `<file>.audit.jsonl` |
| `NSR_WEBHOOK_INSECURE_TEST_ENDPOINT` | `false` | Allows `http` for a local mock. Never for the real NSR |

The specification says there is no limit per batch. The limits above are DataBridge's own operational limits (memory, request time, the 30 s proxy timeout). They are not NSR limits and need NSR's agreement (open question 13). Anything over a limit is refused, never truncated.

Startup refuses: an enabled webhook without signature or submit key, a non-https URL, credentials in the URL, a submit key equal to another key, and out-of-range numbers.

## 7. Security

- **Who can send**: only holders of the NSR submit key, with an operator name, after a preview, with `"confirm": true`. The console adds a role check (`nsr.submit`: Transfer operator and Platform admin; `nsr.preview`: also Data quality analyst and Auditor), but the server key is the real control.
- **Secrets**: `NSR_WEBHOOK_SIGNATURE` and `DATABRIDGE_NSR_SUBMIT_KEY` come only from the environment (Kubernetes Secret `databridge-nsr-secrets`). They are never logged, never returned by the API, never in Postman files or Git.
- **Logs** (`nsr delivery <id> attempt <n> <outcome> -> <status> http=<code> ms=<n> correlation=<id>`) and the audit trail hold IDs, statuses and household serials only, never field values. Tests check this.
- **Consent** is never assumed. Health, disability, religion, assets and crops are never answered "NO" on the household's behalf.
- **Synthetic data**: blocked unless `NSR_WEBHOOK_ALLOW_SYNTHETIC=true`. The demo deployment holds synthetic records only, so with that flag off it cannot send anything.
- **Signature**: provisional. The specification requires a non-empty string and shows `"CCT_DATABRIDGE"` as an example, but defines no algorithm, key or verification. DataBridge sends a configured secret value as-is. **This is not a cryptographic signature and gives no security on its own.**
- **Authentication**: the specification defines none (only `Content-Type`). DataBridge does not invent an `Authorization` header. Whatever protects the NSR endpoint (network allowlist, gateway, mTLS) must be confirmed by the NSR team.

## 8. Open questions for the NSR team

The webhook stays off until 1-5 are answered and a synthetic test is accepted.

1. **Signature**: algorithm, key exchange and verification? Is a shared secret string acceptable for staging, and what is required for production?
2. **Authentication and network**: the specification has no auth header. How is `/partner/ingest_data` protected? Must the DataBridge egress IP be allowlisted? Is mTLS or a gateway token required?
3. **Partner registration**: is partner `CCT_DATABRIDGE` active, with data model `CCT_DATABRIDGE_INTAKE` and template `cct_databridge_to_nsr.json.j2` deployed, in the environment we will test against? Is `staff-nsr` staging or production?
4. **Commit status**: how can DataBridge confirm that a `correlation_id` (or each per-record `ingest_id`) was committed to the register? Is there a status endpoint or callback? How are per-record failures in a batch reported?
5. **Duplicates**: does NSR deduplicate on `message_id`, `individual_sn` / `nsr_household_serial`, or member NIN? What happens when the same household is sent twice: a second household, an update, or a rejection?
6. **Defaults**: can the template leave absent keys empty instead of filling `consent: YES`, `gps: "0.0 0.0 0.0 0.0"`, `anyshocks/health_insurance/crops: NO`, `disroster: YES`, `sponsor: FEDERAL_GOVERNMENT`, `enumerator: CCT_DATABRIDGE`, `total_heads: 1`, `num_room: 1`, `roof_dwelling: "1"`?
7. **Code values**: for `floor_dwelling`, `drink_dwelling`, `toilet_dwelling`, `devicetype_dwelling`, `light_dwelling`, `cook_dwelling`, `livelihoods`, `health_insurance_type`, `bank_name`, `b5labour`, `b6labour`, subsectors, `educationalqualification`, `grade`, `outofschoolgrade`, `monthstopschool`, `yearstopschool`, the travel-time fields and the six Washington Group fields: does the template accept the build-sheet codes DataBridge sends, or only the symbolic values in the examples (`CEMENT`, `TUBEWELL_BOREHOLE`, `ACCESS_BANK`, `SECONDARY`, …)?
8. **Multi-select format** for `shock_type`, `mechanism_type`, `food_nutrition`, `chronicallyilltype`: DataBridge sends space-separated codes. Correct?
9. **Value mappings**: relationship (only HEAD/SPOUSE/CHILD/OTHER listed; DataBridge has 11 values), birth certificate (seen / not seen), sponsor (DataBridge has UNICEF, GIZ, NG CARES, State, AfDB, WFP, Others).
10. **Fields DataBridge does not have**: `disroster` (meaning?), `unlisted_enum`, `health_problem_label`, and the confirmation fields `connin`, `contrackid`, `confrim_contactno`, `caccountno`, `cbvn`. Are any required by the form?
11. **Specification counts**: section 6 says 68 fields; its table lists 67 (33 assets × 2 + `hh_items_list`). Is one missing?
12. **Coordinates**: DataBridge has no altitude, so it sends `latitude`, `longitude`, `accuracy_m` rather than a `gps` string. Is that right?
13. **Limits**: are 50 households and 2 MiB per message, and a 20 s timeout, acceptable? Will NSR send `429`/`503` (with `Retry-After`) when overloaded?
14. **Error responses**: what do NACKs and HTTP errors look like (codes, body shape)?
15. **Test data**: how should synthetic test households be marked in staging, and who removes them afterwards?
16. **Envelope details**: are `message_id` length and format, and a timestamp without milliseconds (`2026-11-05T10:00:00Z`), acceptable?

## 9. Testing

- `tests/nsr.test.js` (28 tests, synthetic data, in-process mock NSR): the specification's every field and accepted key (parsed from the specification itself), all 145 canonical fields accounted for, all 8 sections, every asset and crop, code conversions, grouping, blocking rules, defaults reporting, masking, envelope shapes, acknowledgement classification, configuration safety, authentication, the disabled state, no automatic sending, preview, single and batch submission, duplicates and idempotency keys, every delivery outcome (ACK, NACK, 400, 401, 403, 404, 422, 429, 500, 503, 504, timeout, dropped connection, connection refused), retries and exhaustion, reconciliation, persistence and crash recovery, and logs and audit without personal values or secrets.
- `tests/ui-flow.test.js`: the console's Send to NSR flow (needs jsdom).
- `scripts/nsr-mock-server.js`: the mock, also used by `docker-compose.nsr-mock.yml`.
- Postman folder `09 NSR webhook`.
