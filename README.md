# CCT DataBridge: NSR ingestion middleware prototype

A clickable prototype of the middleware that ingests data from several source registries (NASSCO NSR, state registries, Excel/CSV uploads) into the master social registry `MASTER_SR1`, verifies replication to `MASTER_SR2`, and reconciles the outcome.

It builds on the team's approach note (`OORU_DataBridge_Approach_Note_v0.1.docx`) and uses the NSR field list in `NSR_Registry_Build_Sheet.xlsx` as the canonical schema.

The UI follows the client's **NigeriaG2P UX/UI design baseline v1.0** (`NigeriaG2P-UX-UI-Design-Package-v1`):

- the brand palette and Segoe UI type scale
- the 34 px programme strip and the "Staff services" sidebar
- the breadcrumb with screen ID, note band, white 12 px cards and 44 px buttons
- text-labelled status badges and the footer line

Screens are numbered `NG2P-CDB-001…015` using the baseline's naming convention. `CDB` is a proposed module code and is not one of the baseline's 26 areas.

The console is written for government operators. It is concise and uses standard registry terms (validation, reconciliation, replication, mapping, audit log):

- **One terminology module.** Engine error codes, statuses, stages and audit actions get short labels in one place, `prototype/ui-terms.js`. Titles are at most 4 words and explanations at most 12, which the tests check. The engine keeps its internal codes unchanged.
- **Technical details on request.** Raw codes, trace IDs, idempotency keys and delivery responses appear only in collapsed "Technical details" sections. These are shown to administrators, data quality analysts and auditors. Hiding them is a presentation choice, not a security control; the engine's permission checks are what protect actions.
- **Four sections.** Home, Add Records, Transfers and Settings. Operators see the first three; Settings (sources, field mapping, destinations, audit log, access control, and advanced pages such as reconciliation, data quality, lineage and system details) is shown only to administrators, analysts and auditors.
- **Home.** Records received, records transferred, needs attention, and one action: *Add Records*.
- **Add Records in three steps.** Select Source → Upload or Receive → Review and Submit. Mapping, validation and duplicate checks run automatically ("20 records checked. 18 valid. 2 need correction.").
- **Transfers.** One list with four statuses (Completed, Processing, Needs Attention, Failed) and a Needs Attention view. Each transfer opens as a short summary; the full diagnostics are under *Advanced Details* for authorised roles.
- The console opens as the Transfer operator. Switch roles with *Acting as*.

> **Everything external is simulated.** No NASSCO, state registry or OpenG2P system is contacted. All people and identifiers are synthetic: NINs start with `99`, and every record carries `synthetic = true`. The browser engine stands in for the backend.

## Run it

No build step and no install. Two options:

```bash
# Option 1: open the file directly
start prototype/index.html               # Windows; or double-click it

# Option 2: serve it (needed for .xlsx parsing in some browsers)
python -m http.server 8765               # from this folder
# then open http://127.0.0.1:8765/prototype/
```

Rebuild the generated files after changing the build sheet or any diagram:

```bash
python -I scripts/build.py ../NSR_Registry_Build_Sheet.xlsx   # needs openpyxl
node --test                                                  # 26 engine + 11 terminology + 21 API + 28 NSR + 9 UI tests, Node 18+
```

`node --test` with no argument finds `tests/*.test.js` on Node 18–22. Avoid `node --test tests/`: from Node 21 it treats `tests/` as a file and fails. The 9 UI tests need jsdom and are reported as skipped without it.

## Run with Docker Desktop (local demo)

Two containers on one Compose network:

| Container | Image | Role | Reachable at |
|---|---|---|---|
| `frontend` | `nginx:alpine` | Serves `prototype/` and proxies `/api/` to the backend | `http://localhost:8080` (localhost only) |
| `backend` | `node:22-alpine` | `node server/api.js --seed-demo`, demo mode, records on the `databridge-data` volume | Compose network only; no host port |

**Two separate components.** The console's ingestion (*Add Records*, transfers, exceptions) runs entirely in the browser on simulated data and does not call the API. The API is a separate service with its own record store. Records pushed to the API do not appear in the console, and the reverse.

**Prerequisites:** Docker Desktop running (Linux containers), and Node 18+ on the host to generate a key.

**1. Configure `.env`** (once). It is git-ignored and never copied into an image.

```powershell
Copy-Item .env.example .env
$key = node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
(Get-Content .env) -replace '^DATABRIDGE_API_KEY=.*', "DATABRIDGE_API_KEY=$key" | Set-Content .env
```

The stack always runs in **demo mode**: only synthetic records are accepted (`synthetic` must be true, and NINs must start with `99`). Pull returns the stored synthetic values unmasked (`DATABRIDGE_UNMASKED_PULL=true`, the compose default); set `DATABRIDGE_UNMASKED_PULL=false` in `.env` for masked pulls. No full-access key is configured. The mode is fixed in `docker-compose.yml` and cannot be switched from `.env`. Integration mode is a separate, deliberate setup (see [docs/api/openg2p-integration.md](docs/api/openg2p-integration.md)).

**2. Build and start**

```powershell
docker compose up --build -d
docker compose ps          # both services should show (healthy)
```

| What | URL |
|---|---|
| Console | http://localhost:8080 |
| API health | http://localhost:8080/api/v1/health |
| Push / pull | http://localhost:8080/api/v1/records (header `X-API-Key`) |

**3. Test push and pull** (PowerShell; `curl.exe`, not the `curl` alias)

```powershell
$key = (Select-String -Path .env -Pattern '^DATABRIDGE_API_KEY=(.+)$').Matches[0].Groups[1].Value
curl.exe -s http://localhost:8080/api/v1/health
# Push the synthetic sample: 201 CREATED, then 200 UNCHANGED when repeated
curl.exe -s -X POST http://localhost:8080/api/v1/records -H "X-API-Key: $key" -H "Content-Type: application/json" --data "@docs/samples/openg2p-push-record.json"
# Pull: all 145 fields per record, null where nothing is stored; unmasked in the demo ("nin": "99000001035")
curl.exe -s "http://localhost:8080/api/v1/records?page_size=5" -H "X-API-Key: $key"
```

**4. Logs, stop, restart**

```powershell
docker compose logs -f              # all services; or: docker compose logs -f backend
docker compose restart              # restart; records are kept
docker compose down                 # stop and remove containers; the volume (records) is kept
docker compose up -d                # start again with the same records
```

**Reset local data (deliberately).** This deletes every record in the volume. The next start re-seeds 30 synthetic records.

```powershell
docker compose down -v
```

**Limitations of the local demo**

- Plain HTTP on localhost. There is no TLS, and the API key travels unencrypted (acceptable only on this machine).
- One backend process with a JSON-file store, which is not suitable for concurrent instances or large volumes ([storage limits](docs/api/openg2p-integration.md)).
- The console needs internet access for Excel parsing (SheetJS from cdnjs) and for the System Details diagrams (Mermaid). CSV uploads and demo files work offline.
- No OpenG2P, NASSCO or state registry is contacted. Everything is synthetic.

## OpenG2P push and pull API

A small local REST service lets OpenG2P push records to DataBridge and pull records from it. It uses Node built-ins only, with no install.

```bash
node server/api.js --seed-demo      # http://127.0.0.1:8080/api/v1/records
```

- `POST /api/v1/records` takes one record. It creates or updates it by `internal_record_id`, and an identical repeat returns `UNCHANGED`.
- `GET /api/v1/records?page=&page_size=&updated_since=&changed_by=` returns records, paged. Every record lists all 145 build-sheet fields, in sheet order; a field with no stored value is `null`.

Fields are validated against the build-sheet schema (`prototype/schema.js`), using the engine's own `validateCanonical` rules. Records are stored in one JSON file. `--seed-demo` preloads 30 synthetic records produced by the existing ingestion pipeline.

Four safety rules apply:

- **Demo mode (default)** accepts synthetic records only. `DATABRIDGE_MODE=integration` accepts real ones, but requires an API key, an explicit `synthetic` flag and a separate store.
- **Pull is masked by default**, following the sheet's sensitivity and masking columns. Unmasked pull needs a separate full-access key and an `X-Access-Purpose` header, and every unmasked pull is logged. For demos only, `DATABRIDGE_UNMASKED_PULL=true` returns the stored synthetic values to the standard key; the server refuses to start with it in integration mode.
- `meta.origin` and the `changed_by` filter keep OpenG2P pushes apart from DataBridge-ingested records, which prevents push-pull loops.
- The service listens only on `127.0.0.1` unless an API key is set.

See [docs/api/openg2p-handoff.md](docs/api/openg2p-handoff.md) (the short handoff) and [docs/api/openg2p-integration.md](docs/api/openg2p-integration.md) (the full reference, network access and storage limits).

## Sending households to the OpenG2P NSR (outbound webhook)

DataBridge can send households to the NSR Household Register through `POST /partner/ingest_data` (spec: [docs/architecture/CCT_DataBridge_NSR_Webhook_Specification.md](docs/architecture/CCT_DataBridge_NSR_Webhook_Specification.md)). It groups member records by `nsr_household_serial`, checks the household (consent, head, member count, duplicates, conflicting values), maps it to the NSR form fields, and only sends after an operator previews it and confirms.

- **Off by default** (`NSR_WEBHOOK_ENABLED=false`): preview works, nothing is sent. The base `docker-compose.yml` fixes it off; `docker-compose.nsr-mock.yml` turns it on against a local mock only.
- **API**: `/api/v1/nsr/config`, `/households`, `/preview`, `/submit`, `/submit/batch`, `/deliveries[/{id}[/retry|/reconcile]]`. Submitting needs a separate key (`DATABRIDGE_NSR_SUBMIT_KEY`) and an `X-Operator-Id`.
- **Console**: Transfers → Send to NSR. It lists records on the server. Add Records runs in the browser, so finish a transfer with **Save to Server** (needs the API key) before the households appear there. To load a sheet without the console: `node scripts/load-households-csv.js docs/samples/nsr-test-households.csv --url <base url>`.
- **Never sent automatically**: not at startup, not on seed, push or pull. Uncertain outcomes are reconciled by a person, never resent blindly.
- **Real NSR**: a single synthetic household reached the NSR Household intake form on 5 Nov 2026 (`docker-compose.nsr-real.yml` points the local stack at it). Batches are not yet proven there. Open questions for the NSR team (signature, authentication, commit status, code values, defaults) are listed in the integration reference.

Docs: [nsr-webhook-integration.md](docs/api/nsr-webhook-integration.md) (reference and open questions), [nsr-field-mapping.md](docs/api/nsr-field-mapping.md) (all 202 NSR fields, generated from `server/integrations/nsr/mapping.json`), [nsr-delivery-operations.md](docs/operations/nsr-delivery-operations.md), [nsr-deployment-runbook.md](docs/operations/nsr-deployment-runbook.md).

### Testing against the local NSR mock

The mock (`scripts/nsr-mock-server.js`) stands in for NSR on `127.0.0.1:8090`. It answers `ACK` by default, records every request, and can be told to fail. Its signature value `local-mock-signature` is a placeholder for the mock only, not a secret and not used anywhere else.

```bash
# 1. Start the stack with the mock (needs DATABRIDGE_API_KEY and DATABRIDGE_NSR_SUBMIT_KEY in .env)
docker compose -f docker-compose.yml -f docker-compose.nsr-mock.yml up --build -d

# 2. Run the Postman collection (or import both files into Postman and fill in the two keys)
npx newman run postman/CCT-DataBridge.postman_collection.json \
  -e postman/CCT-DataBridge-Local-NSR-Mock.postman_environment.json \
  --env-var api_key="$DATABRIDGE_API_KEY" --env-var nsr_submit_key="$DATABRIDGE_NSR_SUBMIT_KEY"

# 3. See what the mock NSR received: query parameters, Content-Type and the full envelope
curl -s http://127.0.0.1:8090/__mock/received

# 4. Simulate failures: queue answers for the next requests, then submit from the console or API
curl -s -X POST http://127.0.0.1:8090/__mock/responses -H "Content-Type: application/json" \
  -d '[{"status":503},{"status":200}]'   # 503 -> Will retry, then ACCEPTED on the automatic retry (a few seconds with the mock settings)
#   {"status":422,"body":{...}}  -> REJECTED          {"status":401}   -> DELIVERY_FAILED
#   {"status":500} / {"status":504} / {"delayMs":25000} / {"destroy":true}  -> CONFIRMATION_PENDING (reconcile by hand)
curl -s -X POST http://127.0.0.1:8090/__mock/reset       # clear received messages and queued answers

# 5. Back to the plain stack, webhook off
docker compose -f docker-compose.yml -f docker-compose.nsr-mock.yml down && docker compose up -d
```

Mock deliveries are stored apart from the normal ones (`/data/mock-nsr-deliveries.json`). The Local and Live Postman environments skip the submit requests (`nsr_submit_allowed` is empty), so running them never sends anything.

**A successful mock delivery does not prove that the real NSR registry accepted or committed the data.** It proves the request DataBridge builds (URL, query parameters, envelope, grouping, mapping) and DataBridge's own handling of each response. Even against the real NSR, an `ACK` only means NSR received the message (`registry_commit: NOT_CONFIRMED`); the household has to be checked in the NSR Household Register.

Pending before connecting to the real NSR (details in [nsr-webhook-integration.md §8](docs/api/nsr-webhook-integration.md) and the [runbook](docs/operations/nsr-deployment-runbook.md) gate checklist): the signature method and value, how the endpoint is authenticated (allowlist, gateway, mTLS), partner registration and template deployment, whether `staff-nsr` is staging or production, how to confirm a commit, how resubmissions are treated, the code vocabularies for fields marked REVIEW_REQUIRED, and whether NSR can leave absent keys empty instead of applying its defaults.

`build.py` fails if the field count differs from 145 or if a field name is duplicated. It regenerates:

- `prototype/schema.js`
- `docs/data/canonical-schema.md`
- the templates
- the Mermaid blocks inside `prototype/index.html`

## A 10-minute demo script

1. **Home.** Three numbers and a *needs attention* alert. Problems are already present when the page opens: write outcome unknown, retry scheduled, replication failed, write failures and a possible duplicate. Every number is computed from record states.
2. **Top bar.**
   - **Acting as** switches role. Read-only disables every action with a reason, and the engine refuses and audits any attempt.
   - **+30 s / +3 min** advances the demo clock, which runs the retry scheduler and the replication monitor.
3. **Switch to Platform admin, then Add Records → Demo Tools → S12, write outcome unknown.** Open *Advanced Details* to watch the progress steps. The transfer ends as *Reconciliation pending*: Master Registry 1 holds 2 records whose writes were never confirmed.
4. **Reconcile.** It queries Master Registry 1 by idempotency key. 2 records are confirmed without resending, and 2 are resent. Press **+30 s** and the transfer becomes *Completed*, with no duplicate created.
5. **S10, temporary write failure.** 4 records are *Retry scheduled*, and the **Write attempts** tab lists them. Press **+30 s** and the scheduler writes them.
6. **S13, replication delayed.** Records are written to Master Registry 1 but Master Registry 2 lags. Advanced Details shows *Replication pending*, then *Replication delayed* after 60 s. Press **+3 min** and replication is confirmed.
7. **S06, duplicates in file.** Duplicates are held back, and a `=HYPERLINK(...)` cell is highlighted in the preview and rejected.
8. **S18, malicious upload.** A file named `.xlsx` that is actually HTML is quarantined and never parsed.
9. **Operator journey.** As Transfer operator: **Add Records** → LGA Beneficiary List Upload → *Demo Files → Duplicates* → **Review and Submit** → **Done**. Then **Transfers → Needs Attention** (*Retry*, *Reconcile*, *View*, *Mark Reviewed*). As an administrator, open **Settings** for sources, mapping, lineage and reconciliation.

## What is implemented vs simulated

| Area | In this prototype |
|---|---|
| Canonical schema (145 fields), code lists, field dictionary, template | **Implemented**, generated from the build sheet; count verified at build and at load |
| Mapping engine: 15 transforms, validation of mapping, test on sample, versioned publish | **Implemented** (browser) |
| Canonical validation (required, conditional, regex, range, code list, dates, formula cells) | **Implemented** |
| CSV parsing; XLSX parsing (SheetJS, values only) | **Implemented** in the browser; files never leave it |
| Upload checks: name sanitising, extension allow-list, size, signature, MIME | **Implemented**; AV scan is **not** |
| SSRF guard for source URLs; vault-reference-only credentials | **Implemented** as config validation |
| De-duplication (in-batch, cross-source NIN match → review, same-source update) | **Implemented**, simple rules; real match keys are an open decision |
| Idempotent delivery, retry with exponential backoff + full jitter, dead letters, retry exhaustion | **Implemented** against a **simulated** SR1 store |
| Unknown outcome + reconciliation by idempotency key | **Implemented** against the simulated store |
| SR2 replication lag / failure / re-sync | **Simulated** |
| Source APIs (pagination, 401, 429, timeout, schema drift) | **Mock adapters** |
| RBAC (6 roles, 13 permissions), audit log, payload access with justification | **Implemented** in the engine (no real IdP) |
| Encryption, KMS, Vault, TLS/mTLS | **Not implemented.** Designed and shown as references only |
| OpenG2P push/pull REST API (`server/`) | **Implemented** as a local Node service with a JSON-file store; not connected to any OpenG2P deployment |
| Outbound NSR webhook (`server/integrations/nsr/`) | **Implemented**, tested against a mock only; off by default until the NSR team confirms the open questions |
| Backend service, database, queue | **Not built.** The engine module is the reference logic for the FastAPI + Celery service |

## Project layout

```
cct-databridge/
  Dockerfile           backend image (node:22-alpine, demo mode, /data volume)
  docker/              frontend.Dockerfile (nginx:alpine) and nginx.conf (serves prototype/, proxies /api/)
  docker-compose.yml   local stack; .env.example lists the one setting (DATABRIDGE_API_KEY)
  prototype/
    index.html         shell, styles, injected Mermaid diagrams
    app.js             UI (vanilla JS, escaped templating)
    ui-terms.js        operator labels for every engine code, status, stage and audit action
    engine.js          simulation engine: pure logic, runs in browser and Node
    schema.js          GENERATED canonical schema + code lists
  server/
    api.js             push/pull REST API for OpenG2P (Node built-ins)
    records.js         schema-driven validation, upsert, paging, JSON-file store
    integrations/nsr/  outbound NSR webhook: mapping.json, mapper, envelope, client, delivery store and service
  scripts/build.py     build sheet → schema/docs/templates; diagrams → index.html
  tests/engine.test.js 26 tests covering every failure path below
  tests/ui-terms.test.js 11 tests: labels for every code, status and audit action; navigation and statuses
  tests/ui-flow.test.js 9 jsdom tests of the operator flow, admin pages and Send to NSR (skipped if jsdom is not installed)
  tests/api.test.js    21 tests: status codes, validation, duplicates, paging, keys, modes, masking, direction, 145-field records, demo unmasked pull
  tests/nsr.test.js    28 tests: NSR mapping vs the specification, grouping, payload, delivery outcomes, retries, persistence, security
  scripts/build-postman.js  postman/ collection and environments; field list taken from prototype/schema.js
  scripts/build-nsr-mapping-doc.js  docs/api/nsr-field-mapping.md from mapping.json
  scripts/nsr-mock-server.js  mock NSR /partner/ingest_data for tests and docker-compose.nsr-mock.yml
  templates/           nsr_import_template.csv, field_dictionary.csv
  docs/
    architecture/      8 Mermaid sources (A–H), the single source of truth for diagrams
    data/canonical-schema.md
    security/owasp-controls.md, threat-model.md
    operations/reconciliation.md
    api/contracts.md, openg2p-integration.md, openg2p-handoff.md
    roadmap-and-gaps.md
```

## Findings from the registry codebase that shaped the design

- `registry-platform` already has an ingestion pipeline. `POST /partner/ingest_data` (partner API) writes to `incoming_raw_data`. Celery workers then classify, transform and ingest into an intake-form submission, with `worker_max_attempts = 5`. DataBridge uses `/partner/ingest_data` as the proposed MASTER_SR1 write path and does not reimplement registry ingestion.
- That endpoint is **asynchronous**: a 2xx returns an `ingest_id`, and the register write happens later. The prototype therefore separates *accepted* from *written*, and confirms commits by polling.
- File imports in the platform use `import_file_process_queue` and `import_file_process_log`, with a **unique `(document_id, record_number)` index**. That is a natural idempotency key for file rows, and the prototype mirrors it (`file checksum + row`).
- The NSR extension (`national-social-registry/nsr-extension`) defines `G2PRegisterIndividual` / `G2PRegisterHousehold` models whose column names differ from the build sheet. The sheet's open decision 7 ("exact registry column names") still stands, and the canonical-to-register column mapping is a follow-up.
- The NSR dedup workers exist (`deduplication_*_worker.py`). Production matching should reuse them rather than duplicate the logic in middleware.

## Assumptions

- Source API contracts (NASSCO, Josh) are **unknown**. NASSCO payloads use the NSR form 4.5 field names from the build sheet. The Josh layout is an illustrative example.
- State and LGA codes are placeholders. The code system is open decision 2 in the build sheet.
- Records are flattened to one row per individual with household columns. The real `ingest_data` payload groups a household with its members.
- Mandatory flags and match keys are the build sheet's **proposals**.
