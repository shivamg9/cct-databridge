# NSR deliveries: operations

For the people who send households to NSR and look after the deliveries. Background: [../api/nsr-webhook-integration.md](../api/nsr-webhook-integration.md).

## Sending households (console)

**Transfers → Send to NSR** (Transfer operators and Platform admins can send; Data quality analysts and Auditors can check and view).

1. **Connect**: enter the API key. To send, also enter the NSR submit key and your name or ID. Keys stay in the page and are gone when it is closed.
2. **Select households**: only households marked *Ready* can be ticked. The others say why in plain words (for example "Consent to share data was not given.").
3. **Check Selected**: DataBridge checks the households and shows what NSR would receive. *Notes for the NSR team* lists values NSR would fill in itself and codes NSR has not confirmed. *Show the request NSR will receive* shows the full message.
4. **Send**: tick the confirmation and press **Send to NSR**.
5. **Result**: *Sent. NSR received the message.* with the NSR reference (correlation ID). NSR adds households in the background, so check the Household Register before telling anyone the household is registered.

The same steps through the API are in the integration reference (preview, then submit with `"confirm": true`).

## Delivery statuses

| Status (console) | API status | What it means | What to do |
|---|---|---|---|
| Sending | `PENDING` | Being sent now | Wait |
| Received by NSR | `ACCEPTED` | NSR acknowledged the message (`ACK`). Not yet proof the household is in the register (`registry_commit: NOT_CONFIRMED`) | Confirm in the NSR Household Register using the NSR reference |
| Will retry | `RETRY_SCHEDULED` | NSR was unreachable or busy (refused connection, 429, 502, 503). Nothing was received | Nothing. DataBridge retries with growing delays (`next_attempt_at`). Press **Retry** to send now |
| Check NSR | `CONFIRMATION_PENDING` | NSR may or may not have received it (timeout, 500, 504, connection lost, or DataBridge restarted mid-send) | **Look in NSR first.** Found: **Found in NSR** (note what you checked). Not found: **Not in NSR**, then **Retry** |
| Rejected by NSR | `REJECTED` | NSR refused the message (NACK or 4xx) | Read `last_reason` and the `ack` fields. Fix the data, then send again |
| Not delivered | `DELIVERY_FAILED` | Retries used up, or a configuration fault (401, 403, 404, certificate error), or reconciled as not received | Fix the cause (see Troubleshooting), then **Retry** |

A household cannot be sent again while it has a delivery that is Sending, Will retry or Check NSR. A household NSR already received cannot be sent again unchanged; if its records changed, the API needs `"resubmit": true` (ask the NSR team first whether a resend updates or duplicates the household).

## API commands

Set `BASE=https://databridge.openg2p.dpiforall.com/api/v1`, `KEY` (API key) and `SKEY` (NSR submit key).

```bash
# Problems first
curl -s "$BASE/nsr/deliveries?status=CONFIRMATION_PENDING" -H "X-API-Key: $KEY"
curl -s "$BASE/nsr/deliveries?status=DELIVERY_FAILED" -H "X-API-Key: $KEY"
curl -s "$BASE/nsr/deliveries?status=RETRY_SCHEDULED" -H "X-API-Key: $KEY"
# One delivery, every attempt
curl -s "$BASE/nsr/deliveries/<id>" -H "X-API-Key: $KEY"
# Everything sent for one household
curl -s "$BASE/nsr/deliveries?household_serial=<serial>" -H "X-API-Key: $KEY"
# Retry now (DELIVERY_FAILED or RETRY_SCHEDULED)
curl -s -X POST "$BASE/nsr/deliveries/<id>/retry" -H "X-API-Key: $SKEY" -H "X-Operator-Id: <your name>"
# Uncertain outcome: found in NSR
curl -s -X POST "$BASE/nsr/deliveries/<id>/reconcile" -H "X-API-Key: $SKEY" -H "X-Operator-Id: <your name>" -H "Content-Type: application/json" \
  -d '{"outcome":"ACCEPTED","note":"Found in Household Register, searched by serial","correlation_id":"<if known>"}'
# Uncertain outcome: not in NSR, then resend
curl -s -X POST "$BASE/nsr/deliveries/<id>/reconcile" -H "X-API-Key: $SKEY" -H "X-Operator-Id: <your name>" -H "Content-Type: application/json" \
  -d '{"outcome":"NOT_RECEIVED","note":"Not in Household Register, searched by serial and NIN"}'
curl -s -X POST "$BASE/nsr/deliveries/<id>/retry" -H "X-API-Key: $SKEY" -H "X-Operator-Id: <your name>"
```

## Monitoring

| Watch | How | Act when |
|---|---|---|
| Uncertain outcomes | `GET /nsr/deliveries?status=CONFIRMATION_PENDING` | Any: they need a person |
| Dead letters | `GET /nsr/deliveries?status=DELIVERY_FAILED` | Any |
| Retry backlog | `GET /nsr/deliveries?status=RETRY_SCHEDULED` (`total`) | Growing, or the oldest older than an hour |
| Rejections | `GET /nsr/deliveries?status=REJECTED` | Any: usually a mapping or code-value problem to raise with the NSR team |
| Backend log | `k -n cct-databridge logs deploy/databridge-backend \| grep "nsr delivery"` | `FAILED`, `UNCERTAIN`, or `http=401/403/404` |
| Settings | `GET /nsr/config` | `enabled` or `endpoint` not what you expect |

Log lines look like `nsr delivery dlv-… attempt 2 RETRY -> RETRY_SCHEDULED http=503 ms=41`. They never contain names, NINs, phone numbers, account details or keys.

## Audit trail

Every submission, attempt, manual retry, reconciliation and restart recovery is appended to `/data/<mode>-nsr-deliveries.json.audit.jsonl` (household serials, record IDs counts, operator, status, HTTP status, correlation ID; never field values):

```bash
k -n cct-databridge exec deploy/databridge-backend -- tail -n 50 /data/demo-nsr-deliveries.json.audit.jsonl
```

Delivery state (including the message sent, for retries) is in `/data/demo-nsr-deliveries.json` on the same volume as the records. It contains personal data in integration mode: treat it like the record store (no copies, no attachments).

## Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| `503 NSR_WEBHOOK_DISABLED` | Webhook off | Expected until enabled (runbook) |
| `403 NSR_SUBMIT_FORBIDDEN` | Standard API key used | Use the NSR submit key |
| `400 OPERATOR_REQUIRED` | No `X-Operator-Id` | Add your name or ID |
| Household *Needs correction*: `HOUSEHOLD_FIELD_CONFLICT` | Members carry different household values (address, dwelling…) | Correct the source records so they agree, push again, check again |
| `CONSENT_NOT_GIVEN` / `CONSENT_MISSING` | A member record lacks consent | Never override. Obtain consent through the agreed NSR process, update the records |
| `MEMBER_COUNT_MISMATCH` | `member_count` differs from the member records on file | Load the missing members, or correct the count |
| `SYNTHETIC_NOT_ALLOWED` | Test records, and synthetic sending is off | Expected outside an approved staging test |
| Every attempt `RETRY_SCHEDULED`, `error=ENOTFOUND` / `EAI_AGAIN` | DNS from the pod | Runbook step 5 (egress and DNS) |
| `error=ECONNREFUSED` / `ETIMEDOUT` before sending | Network path or firewall | Runbook step 5 |
| `DELIVERY_FAILED`, TLS error | Certificate on the NSR side, or a proxy intercepting TLS | `openssl s_client -connect staff-nsr.openg2p.dpiforall.com:443 -servername staff-nsr.openg2p.dpiforall.com` from the node |
| `DELIVERY_FAILED`, `http=401/403` | Partner not registered, or signature/allowlist not accepted | NSR team: partner registration, signature, IP allowlist |
| `DELIVERY_FAILED`, `http=404` | Wrong base URL or path, or data model not deployed | `GET /nsr/config`; NSR team: data model and template |
| `REJECTED` with a NACK | NSR template could not process the household | Send `last_reason`, the `ack` fields and the correlation ID to the NSR team (not the payload) |
| Many `CONFIRMATION_PENDING` with `TIMEOUT` | NSR slower than `NSR_WEBHOOK_TIMEOUT_MS` | Reconcile each. Agree a timeout with the NSR team; keep it below the 30 s frontend proxy timeout |
| Backend will not start: `NSR_WEBHOOK_ENABLED=true needs …` | Enabled without the Secret | Create `databridge-nsr-secrets` (runbook step 3) or turn the webhook off |
