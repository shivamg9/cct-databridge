# NSR webhook: deployment runbook (backend and frontend 0.7.0)

For the deployment team. Rolls out DataBridge 0.7.0 with the NSR webhook **off**, then turns it on in a controlled way once the NSR team has confirmed the prerequisites. Cluster details (RKE2 node `172.31.58.104`, namespace `cct-databridge`, front proxy) are in [../../k8s/DEPLOYMENT.md](../../k8s/DEPLOYMENT.md).

What does not change: the persistent volume and its records, the API key Secret `databridge-secrets`, the VirtualService, the NetworkPolicies, demo mode and `DATABRIDGE_UNMASKED_PULL`. Deploying 0.7.0 alone sends nothing to NSR.

## Gate: keep `NSR_WEBHOOK_ENABLED=false` until the NSR team confirms

- [ ] Partner `CCT_DATABRIDGE` is registered and active in the target environment
- [ ] Data model `CCT_DATABRIDGE_INTAKE` exists, and template `cct_databridge_to_nsr.json.j2` is deployed
- [ ] Register ID `a0000000-0000-4000-8000-000000000002` and intake form ID `c1000000-0000-4000-8000-000000000002` are correct for that environment
- [ ] The signature value (and any authentication or allowlist) is agreed, and delivered through a secure channel
- [ ] Network access from the cluster to `staff-nsr.openg2p.dpiforall.com:443` is allowed (step 5)
- [ ] Whether `staff-nsr` is staging or production, and where synthetic test households may go
- [ ] A synthetic test submission is accepted and visible in the Household Register (steps 7-9)
- [ ] Answers to the open questions in [../api/nsr-webhook-integration.md](../api/nsr-webhook-integration.md) §8, at least 1-5

## 1. Build and push the images (from the repo root)

The server is x86_64.

```bash
docker login
docker buildx build --platform linux/amd64 -t oorudigital/cct-databridge-backend:0.7.0 -f Dockerfile --push .
docker buildx build --platform linux/amd64 -t oorudigital/cct-databridge-frontend:0.7.0 -f docker/frontend.Dockerfile --push .
```

Both change in 0.7.0: the backend has the NSR integration, the frontend has the Send to NSR screen.

## 2. Copy the manifests to the server

`k8s/kustomization.yaml` already points both images at `0.7.0` and includes the new `02-nsr-config.yaml`.

```bash
scp -i ~/Downloads/openg2p-demo.pem k8s/02-nsr-config.yaml k8s/10-backend.yaml k8s/20-frontend.yaml k8s/kustomization.yaml ubuntu@172.31.58.104:~/cct-databridge-k8s/
ssh -i ~/Downloads/openg2p-demo.pem ubuntu@172.31.58.104
alias k='sudo /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml'
grep -E 'newTag|02-nsr' ~/cct-databridge-k8s/kustomization.yaml
grep NSR_WEBHOOK_ENABLED ~/cct-databridge-k8s/02-nsr-config.yaml     # must be "false"
```

## 3. Secrets

Not needed while the webhook is off: the backend reads them with `optional: true`. Create them before enabling (step 6). Type the signature value from the NSR team; never paste it into a file in Git, a ticket or chat.

```bash
read -rs NSR_SIG    # the signature value agreed with the NSR team
k -n cct-databridge create secret generic databridge-nsr-secrets \
  --from-literal=NSR_WEBHOOK_SIGNATURE="$NSR_SIG" \
  --from-literal=DATABRIDGE_NSR_SUBMIT_KEY="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
unset NSR_SIG
```

Give the submit key only to the operators who may send to NSR:

```bash
k -n cct-databridge get secret databridge-nsr-secrets -o jsonpath='{.data.DATABRIDGE_NSR_SUBMIT_KEY}' | base64 -d
```

## 4. Deploy 0.7.0 (webhook off)

```bash
k apply -k ~/cct-databridge-k8s
k -n cct-databridge rollout status deploy/databridge-backend
k -n cct-databridge rollout status deploy/databridge-frontend
k -n cct-databridge get deploy -o custom-columns=NAME:.metadata.name,IMAGE:.spec.template.spec.containers[0].image
k -n cct-databridge logs deploy/databridge-backend --tail 8      # "NSR webhook off (NSR_WEBHOOK_ENABLED=false): preview only, nothing is sent."
k -n cct-databridge get pvc databridge-data                     # Bound, same volume as before
```

The backend uses the `Recreate` strategy, so the API is down for a few seconds. Records stay on the volume.

Check from your machine, with `KEY` set to the API key:

```bash
BASE=https://databridge.openg2p.dpiforall.com/api/v1
curl -s $BASE/health                                                        # {"status":"ok","mode":"demo"}
curl -s "$BASE/records?changed_by=databridge-ingestion&page_size=1" -H "X-API-Key: $KEY" | head -c 300
curl -s $BASE/nsr/config -H "X-API-Key: $KEY"                               # "enabled":false
curl -s -X POST $BASE/nsr/submit -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d '{"household_serial":"x","confirm":true}'   # 503 NSR_WEBHOOK_DISABLED
npx newman run postman/CCT-DataBridge.postman_collection.json -e postman/CCT-DataBridge-Live.postman_environment.json --env-var "api_key=$KEY"
```

The Postman run adds 5 synthetic test records (`PM-TEST-…`, `PM-HH-…`) to the demo store each time, and skips every NSR submit request (the Live environment does not allow them).

## 5. Network: egress, DNS and TLS from the backend pod

The NetworkPolicies restrict ingress only, so egress is open. `staff-nsr.openg2p.dpiforall.com` resolves to the public front proxy (`13.233.236.183`), so traffic leaves the node and comes back; the AWS security group and the proxy must allow that.

```bash
# DNS
k -n cct-databridge exec deploy/databridge-backend -- node -e "require('dns').lookup('staff-nsr.openg2p.dpiforall.com',(e,a)=>console.log(e?e.code:a))"
# TCP + TLS + HTTP, without sending data (GET on the ingest path; any HTTP status proves the path, 405/404/422 are fine)
k -n cct-databridge exec deploy/databridge-backend -- node -e "require('https').get('https://staff-nsr.openg2p.dpiforall.com/partner/ingest_data',r=>{console.log('HTTP',r.statusCode,'TLS ok');process.exit(0)}).on('error',e=>{console.log('FAIL',e.code||e.message);process.exit(1)})"
# Certificate (from the node)
echo | openssl s_client -connect staff-nsr.openg2p.dpiforall.com:443 -servername staff-nsr.openg2p.dpiforall.com 2>/dev/null | openssl x509 -noout -subject -dates
```

If the NSR team allowlists by source IP, give them the node's public egress IP (`curl -s https://checkip.amazonaws.com` on the node). If an egress NetworkPolicy is added later, allow TCP 443 to that address and UDP/TCP 53 to the cluster DNS.

## 6. Enable for a synthetic staging test

Only after the gate's first five items are confirmed, and with the NSR team's agreement to receive synthetic test households.

```bash
k -n cct-databridge patch configmap databridge-nsr-config --type merge -p '{"data":{"NSR_WEBHOOK_ENABLED":"true","NSR_WEBHOOK_ALLOW_SYNTHETIC":"true"}}'
k -n cct-databridge rollout restart deploy/databridge-backend
k -n cct-databridge rollout status deploy/databridge-backend
k -n cct-databridge logs deploy/databridge-backend --tail 3    # "NSR webhook ON: https://staff-nsr…/partner/ingest_data?… synthetic records allowed"
```

If the backend does not start, the log names the missing setting (usually the Secret from step 3).

A patched ConfigMap is overwritten the next time `k apply -k` runs with `02-nsr-config.yaml` saying `"false"`. That is deliberate: to keep it on, change the file in Git after approval.

## 7. Synthetic single-household submission

Use a clearly named synthetic household so the NSR team can find and remove it. Set `KEY` (API key) and `SKEY` (NSR submit key).

```bash
SERIAL=CCTDB-STAGING-$(date +%Y%m%d)-01
# Push one synthetic member record (NIN starts with 99), based on the repository sample
jq --arg s "$SERIAL" '.internal_record_id=($s+"-M1") | .nsr_household_serial=$s | .member_count=1' docs/samples/openg2p-push-record.json \
  | curl -s -X POST $BASE/records -H "X-API-Key: $KEY" -H "Content-Type: application/json" --data @-
# Preview: must be "READY"; read the warnings
curl -s -X POST $BASE/nsr/preview -H "X-API-Key: $KEY" -H "Content-Type: application/json" -d "{\"household_serials\":[\"$SERIAL\"]}"
# Submit
curl -s -X POST $BASE/nsr/submit -H "X-API-Key: $SKEY" -H "X-Operator-Id: deploy.<name>" -H "Content-Type: application/json" \
  -H "Idempotency-Key: staging-$SERIAL" -d "{\"household_serial\":\"$SERIAL\",\"confirm\":true}"
```

## 8. Synthetic batch submission

```bash
for i in 02 03; do S=CCTDB-STAGING-$(date +%Y%m%d)-$i; jq --arg s "$S" --arg i "$i" '.internal_record_id=($s+"-M1") | .nsr_household_serial=$s | .member_count=1 | .nin=("990000020"+$i)' docs/samples/openg2p-push-record.json \
  | curl -s -X POST $BASE/records -H "X-API-Key: $KEY" -H "Content-Type: application/json" --data @-; done
D=$(date +%Y%m%d)
curl -s -X POST $BASE/nsr/submit/batch -H "X-API-Key: $SKEY" -H "X-Operator-Id: deploy.<name>" -H "Content-Type: application/json" \
  -d "{\"household_serials\":[\"CCTDB-STAGING-$D-02\",\"CCTDB-STAGING-$D-03\"],\"batch_format\":\"records\",\"confirm\":true}"
```

## 9. Verify the acknowledgement and the register

```bash
curl -s "$BASE/nsr/deliveries?household_serial=$SERIAL" -H "X-API-Key: $KEY"
```

Expected: `"status":"ACCEPTED"`, `ack.ack_status` `"ACK"`, `ack.status` `"succ"`, a `correlation_id`, `registry_commit` `"NOT_CONFIRMED"`.

Then, with the NSR team, find each test household in the **NSR Household Register** (by `individual_sn` = the serial, or the correlation ID) and check: the household exists once; the head and members match; consent is YES; the values listed as `NSR_DEFAULT_APPLIES` and `VALUE_FORMAT_UNCONFIRMED` in the preview came out as intended. Record the result and any mapping changes needed. Then switch synthetic sending off again:

```bash
k -n cct-databridge patch configmap databridge-nsr-config --type merge -p '{"data":{"NSR_WEBHOOK_ALLOW_SYNTHETIC":"false"}}'
k -n cct-databridge rollout restart deploy/databridge-backend
```

## 10. Production approval and enablement

This deployment runs in demo mode and holds synthetic records only, so it cannot send real households. Sending real households needs a separate integration-mode deployment (its own volume, `DATABRIDGE_MODE=integration`), and:

- written approval from the data owner and the NSR team, naming the fields sent and who holds the NSR submit key;
- the open questions in the integration reference answered and the mapping updated;
- a successful synthetic test in that environment (steps 7-9);
- `NSR_WEBHOOK_ENABLED: "true"` and `NSR_WEBHOOK_ALLOW_SYNTHETIC: "false"` committed in that deployment's ConfigMap.

## 11. Monitoring after enablement

See [nsr-delivery-operations.md](nsr-delivery-operations.md). In short:

```bash
k -n cct-databridge logs deploy/databridge-backend | grep "nsr delivery"
curl -s "$BASE/nsr/deliveries?status=CONFIRMATION_PENDING" -H "X-API-Key: $KEY"
curl -s "$BASE/nsr/deliveries?status=DELIVERY_FAILED" -H "X-API-Key: $KEY"
k -n cct-databridge exec deploy/databridge-backend -- tail -n 20 /data/demo-nsr-deliveries.json.audit.jsonl
```

## 12. Rollback

**Stop sending (first response, seconds):**

```bash
k -n cct-databridge patch configmap databridge-nsr-config --type merge -p '{"data":{"NSR_WEBHOOK_ENABLED":"false"}}'
k -n cct-databridge rollout restart deploy/databridge-backend
```

Pending retries stay on the volume and are not sent while the webhook is off.

**Return to 0.6.0 / 0.5.0 (the previous release):**

```bash
k -n cct-databridge set image deploy/databridge-backend backend=oorudigital/cct-databridge-backend:0.6.0
k -n cct-databridge set image deploy/databridge-frontend frontend=oorudigital/cct-databridge-frontend:0.5.0
k -n cct-databridge rollout status deploy/databridge-backend
```

or `k -n cct-databridge rollout undo deploy/databridge-backend` (and `databridge-frontend`). Then set `newTag` back to `0.6.0` / `0.5.0` in `kustomization.yaml` so a later `k apply -k` does not undo the rollback. Version 0.6.0 ignores the NSR settings; the ConfigMap, the Secret and `/data/demo-nsr-deliveries.json*` can stay (or be removed with `k -n cct-databridge delete configmap databridge-nsr-config` and `k -n cct-databridge delete secret databridge-nsr-secrets`). Never delete the PVC.

**Rotate the NSR submit key** (an operator leaves, or the key leaked):

```bash
k -n cct-databridge delete secret databridge-nsr-secrets   # then re-run step 3 with the same signature
k -n cct-databridge rollout restart deploy/databridge-backend
```
