# Proposed DataBridge API (v1)

These are the contracts the FastAPI service should expose. They are **proposals**, not existing OpenG2P endpoints. The prototype engine's public functions map one-to-one onto them (shown in brackets).

The two endpoints OpenG2P calls directly (`POST` and `GET /api/v1/records`) are implemented in `server/` and documented in [openg2p-integration.md](openg2p-integration.md).

Authentication is an OIDC bearer token on every call. Every mutating call is authorised server-side, writes an audit event, and returns `X-Trace-Id`.

## Sources

| Method | Path | Permission | Engine |
|---|---|---|---|
| GET | `/v1/sources` | any | `state.sources` |
| POST | `/v1/sources` | source.edit | `addSource` |
| PATCH | `/v1/sources/{id}` | source.edit | `updateSource` |
| POST | `/v1/sources/{id}:enable` / `:disable` | source.toggle | `setSourceEnabled` |
| POST | `/v1/sources/{id}:test` | source.test | `testConnection` |
| DELETE | `/v1/sources/{id}` | source.edit | `removeSource` (soft delete, returns dependency report) |
| GET / PUT | `/v1/sources/{id}/mapping` | mapping.edit for PUT | `validateMapping`, `publishMapping` |
| POST | `/v1/sources/{id}/mapping:test` | any | `testMapping` |

Source body (credentials are references only):

```json
{
  "id": "SRC-STATE-JOSH", "name": "Josh State Registry", "type": "State Registry",
  "connection": "API", "modes": ["API"], "env": "Testing",
  "baseUrl": "https://josh-registry.mock.invalid", "endpoint": "/api/v2/beneficiaries", "method": "POST",
  "authRef": "vault://databridge/sources/josh/api-key",
  "pagination": "offset/limit 10", "incremental": "lastUpdated > watermark",
  "layout": "JOSH_V2", "schemaVersion": "josh-v2 / v3", "frequency": "Every 6 hours", "enabled": true
}
```

## Uploads and runs

| Method | Path | Permission | Notes |
|---|---|---|---|
| POST | `/v1/uploads` | run.start | Returns a pre-signed URL into the quarantine zone and an `uploadId` |
| GET | `/v1/uploads/{id}` | run.start | Scan checks, header check, preview of masked rows (`validateUpload`, `checkHeaders`) |
| POST | `/v1/runs:dryRun` | run.start | `{sourceId, mode, uploadId?}` → stage counts, issues; nothing delivered (`dryRun`) |
| POST | `/v1/runs` | run.start | `{sourceId, mode, uploadId?, dryRunRef, approvedBy}` → `202` + run (`startRun`). `409 SOURCE_DISABLED` if the source is disabled |
| GET | `/v1/runs?source=&mode=&status=&from=&to=` | any | List with derived status (`filterRuns`, `runStatus`) |
| GET | `/v1/runs/{id}` | any + scope | Stages, counts, reconciliation |
| GET | `/v1/runs/{id}/records?bucket=` | any + scope | Masked records |
| POST | `/v1/runs/{id}:retry` | run.retry | `{recordIds?}` → retried, delivered, duplicatesPrevented, skipped (`retryRecords`) |
| POST | `/v1/runs/{id}:reconcile` | run.reconcile | → confirmed, requeued, replicaResync (`reconcileRun`) |
| GET | `/v1/runs/{id}/report.csv` | report.download | Redacted, formula-safe (`runReport`) |

## Records, errors, metrics

| Method | Path | Permission | Notes |
|---|---|---|---|
| GET | `/v1/records/{id}/lineage` | any + scope | Provenance + stage timeline (`lineage`) |
| POST | `/v1/records/{id}/payload` | payload.view | Body `{justification}` (≥ 10 chars); audited (`viewRawPayload`) |
| POST | `/v1/records/{id}:review` | error.resolve | `{decision: APPROVE_NEW \| REJECT, note}` (`resolveReview`) |
| GET | `/v1/errors?code=&status=&source=` | any | Error queue |
| POST | `/v1/errors/{id}:acknowledge` | error.resolve | `resolveError` |
| GET | `/v1/metrics?range=&source=&mode=&status=` | any | KPIs (`metrics`) |
| GET | `/v1/analytics?…` | any | Chart series (`analytics`) |
| GET | `/v1/reconciliation?runId=\|range=` | any | Buckets, identities, record IDs (`reconcileSummary`) |
| GET | `/v1/audit?…` | audit.view | Append-only; no DELETE route exists |

## Error envelope

```json
{ "error": { "code": "MASTER_WRITE_OUTCOME_UNKNOWN", "message": "Write timed out; MASTER_SR1 may or may not have committed it",
  "stage": "DELIVER_PRIMARY", "retryable": true, "traceId": "tr-3f9a…/12", "action": "Reconcile first (query by idempotency key)." } }
```

Messages never contain personal values.

## Required change on the OpenG2P side (MASTER_SR1)

`POST /partner/ingest_data` should accept an `Idempotency-Key` header (or a body field). It should persist that key next to `incoming_raw_data.ingest_id` with a unique index, and return the existing `ingest_id` and `internal_record_id` for a repeated key. It also needs a lookup `GET /partner/ingest_status?idempotency_key=` returning the status and the `internal_record_id`. Without these two changes, unknown outcomes cannot be reconciled safely.
