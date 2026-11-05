# CCT DataBridge: Kubernetes deployment (OpenG2P demo server)

Target: RKE2 v1.28.9 single node `ip-172-31-58-104` (x86_64), Istio 1.22.8, storage class `nfs-csi`.

Public URL: **https://databridge.openg2p.dpiforall.com**

```
Browser ──HTTPS──▶ 13.233.236.183 = nginx front proxy "pritunl" (172.31.7.21), TLS terminated here
        ──HTTP/1.1──▶ 172.31.58.104:32242 istio-ingressgateway (NodePort) ── Gateway dev/internal
        ──▶ VirtualService databridge ──▶ Service databridge-frontend:80 ──▶ frontend pod ×1 (nginx :8080)
                                                                  /api/ ──▶ Service backend:8080 ──▶ backend pod ×1 ──▶ PVC (nfs-csi)
```

## Files

| File | What it creates |
|---|---|
| `00-namespace.yaml` | Namespace `cct-databridge` (Pod Security `restricted`) |
| `01-pvc.yaml` | 1Gi `nfs-csi` volume for the backend record store |
| `02-nsr-config.yaml` | ConfigMap `databridge-nsr-config`: NSR webhook settings, **off** (`NSR_WEBHOOK_ENABLED: "false"`) |
| `10-backend.yaml` | Backend Deployment (1 replica, `Recreate`) + Service `backend` |
| `20-frontend.yaml` | Frontend Deployment (1 replica) + Service |
| `30-virtualservice.yaml` | Istio VirtualService on the existing `dev/internal` gateway |
| `40-networkpolicy.yaml` | Deny all inbound; allow istio-system → frontend, frontend → backend |
| `kustomization.yaml` | Ties the files together and sets the image names |
| `proxy/databridge.conf` | nginx site for the front proxy (not applied by kustomize; see step 8) |

The Secret `databridge-secrets` (API key) is created by hand in step 4 and is never stored in git.

Design notes:
- The backend stores records in one JSON file, so it must stay at **1 replica** (`Recreate` strategy, RWO volume). Do not scale it.
- The Service is named `backend` because the frontend image's `nginx.conf` proxies to `http://backend:8080`.
- Demo mode is fixed (`DATABRIDGE_MODE=demo`): synthetic records only.
- `DATABRIDGE_UNMASKED_PULL: "true"` in `10-backend.yaml`: pull returns the stored synthetic values (`"view": "full"`); the API key is still required. Set it to `"false"` for masked pulls. The backend refuses to start if this is combined with integration mode.
- Every pulled record has all 145 build-sheet fields; absent ones are `null`.
- The outbound NSR webhook is off. Its secrets (Secret `databridge-nsr-secrets`) are optional while it is off. Enabling it is a separate, gated procedure: [../docs/operations/nsr-deployment-runbook.md](../docs/operations/nsr-deployment-runbook.md).
- Both pods run as non-root with a read-only root filesystem.

## Prerequisites

- On your Mac: Docker Desktop (with buildx) and a Docker Hub account.
- SSH key `~/Downloads/openg2p-demo.pem` for `ubuntu@172.31.58.104`.
- Access to the Route 53 zone `dpiforall.com`.
- SSH access to the front nginx proxy `pritunl` (172.31.7.21). The `openg2p-demo.pem` key does not work there.

## Step 1. Set the image names

`k8s/kustomization.yaml` already points at the Docker Hub account `oorudigital` (public repos `oorudigital/cct-databridge-backend` and `oorudigital/cct-databridge-frontend`). Change both `newName` lines only if you move to another registry.

## Step 2. Build and push the images (on your Mac, from the repo root)

The server is x86_64, so build for `linux/amd64`.

```bash
docker login
```
```bash
docker buildx build --platform linux/amd64 -t oorudigital/cct-databridge-backend:0.7.0 -f Dockerfile --push .
```
```bash
docker buildx build --platform linux/amd64 -t oorudigital/cct-databridge-frontend:0.7.0 -f docker/frontend.Dockerfile --push .
```

The other apps on this cluster pull public Docker Hub images without pull secrets. If you make these repos private, create an image pull secret in `cct-databridge` and add `imagePullSecrets` to both Deployments.

## Step 3. Copy the manifests to the server

```bash
scp -i ~/Downloads/openg2p-demo.pem -r k8s ubuntu@172.31.58.104:~/cct-databridge-k8s
```

Check that the image names arrived correctly (a placeholder here makes the pods fail with `InvalidImageName`):
```bash
ssh -i ~/Downloads/openg2p-demo.pem ubuntu@172.31.58.104 'grep newName ~/cct-databridge-k8s/kustomization.yaml'
```
```bash
ssh -i ~/Downloads/openg2p-demo.pem ubuntu@172.31.58.104
```

All later commands run on the server.

```bash
alias k='sudo /var/lib/rancher/rke2/bin/kubectl --kubeconfig /etc/rancher/rke2/rke2.yaml'
```

## Step 4. Create the namespace and the API key secret

```bash
k apply -f ~/cct-databridge-k8s/00-namespace.yaml
```
```bash
k -n cct-databridge create secret generic databridge-secrets --from-literal=DATABRIDGE_API_KEY="$(openssl rand -base64 24 | tr '+/' '-_' | tr -d '=')"
```

## Step 5. Deploy

```bash
k apply -k ~/cct-databridge-k8s
```
```bash
k -n cct-databridge rollout status deploy/databridge-backend && k -n cct-databridge rollout status deploy/databridge-frontend
```
```bash
k -n cct-databridge get pods,svc,pvc,vs
```

Expected: 1 backend pod and 1 frontend pod `Running`, PVC `Bound`, VirtualService on `["dev/internal"]`.

## Step 6. Test on the server (before DNS)

```bash
curl -s -H "Host: databridge.openg2p.dpiforall.com" http://127.0.0.1:32242/api/v1/health
```

Expected: `{"status":"ok","mode":"demo"}`. A `502` in the first seconds after a rollout is normal (the frontend is ready before the backend) and clears on its own.

## Step 7. DNS (Route 53)

In the `dpiforall.com` hosted zone, add an **A record** `databridge.openg2p` → `13.233.236.183`, TTL 300 (same as `staff-nsr` and `beneficiary`). There is no wildcard record.

## Step 8. Front nginx proxy (pritunl, 172.31.7.21)

The proxy only serves the valid certificate for hostnames it has a site for; any other name gets the old default certificate (expired Oct 20, 2026) and a 403.

1. Print the certificate paths the other sites use, and put the same paths in `k8s/proxy/databridge.conf`:
   ```bash
   sudo grep -rh "ssl_certificate" /etc/nginx/sites-enabled/ | sort -u
   ```
2. Save the file as `/etc/nginx/sites-enabled/databridge.conf` (a plain file in `sites-enabled` is enough; no symlink).
3. Test and reload:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```

The `protocol options redefined` warnings from `biosdk-service.conf` / `biosdkdev.conf` existed before and are harmless.

Keep `proxy_http_version 1.1;`: without it nginx talks HTTP/1.0 to Istio, which answers **426 Upgrade Required**.

## Step 9. URLs and end-to-end checks

| What | URL |
|---|---|
| Operator console | https://databridge.openg2p.dpiforall.com/ |
| Health | https://databridge.openg2p.dpiforall.com/api/v1/health |
| Push (POST) / Pull (GET) | https://databridge.openg2p.dpiforall.com/api/v1/records (header `X-API-Key`) |

Get the key (on the server):
```bash
k -n cct-databridge get secret databridge-secrets -o jsonpath='{.data.DATABRIDGE_API_KEY}' | base64 -d
```

From your Mac, with `KEY` set to that value:
```bash
curl -s https://databridge.openg2p.dpiforall.com/api/v1/health
```
```bash
curl -s -X POST https://databridge.openg2p.dpiforall.com/api/v1/records -H "X-API-Key: $KEY" -H "Content-Type: application/json" --data @docs/samples/openg2p-push-record.json
```
```bash
curl -s "https://databridge.openg2p.dpiforall.com/api/v1/records?page_size=5" -H "X-API-Key: $KEY"
```

Expected: health `ok`; first push `201` (`CREATED`), a repeat `200` (`UNCHANGED`); pull returns `"view": "full"`, 145 fields per record and unmasked synthetic values (`"nin": "99000001035"`); 31 records in total (30 seeded + the sample).

The Postman collection in `postman/` runs all of these checks (environment "CCT DataBridge - Live", `expected_view` = `full`).

## Operations

| Task | Command (on the server) |
|---|---|
| Backend logs | `k -n cct-databridge logs -f deploy/databridge-backend` |
| Frontend logs | `k -n cct-databridge logs -f deploy/databridge-frontend` |
| Update | push a new tag, change `newTag` in `kustomization.yaml`, copy it, then `k apply -k ~/cct-databridge-k8s` |
| Masked / unmasked pull | change `DATABRIDGE_UNMASKED_PULL` in `10-backend.yaml`, copy it, then `k apply -k ~/cct-databridge-k8s` (the backend restarts) |
| Roll back | `k -n cct-databridge rollout undo deploy/databridge-frontend` (or `databridge-backend`) |
| Rotate API key | `k -n cct-databridge delete secret databridge-secrets`, re-run step 4's second command, then `k -n cct-databridge rollout restart deploy/databridge-backend` |
| Remove everything | `k delete -k ~/cct-databridge-k8s` (the NFS volume uses `Retain`, so its data stays under `/srv/nfs/openg2p`) |

## Troubleshooting

| Symptom | Check |
|---|---|
| Pod `InvalidImageName` | `kustomization.yaml` on the server still has a placeholder; fix `newName`, then `k apply -k` |
| Pod `ImagePullBackOff` | Image name/tag in `kustomization.yaml`; image built for `linux/amd64`; repo public |
| Browser: certificate expired | No site for the hostname on the front proxy (step 8) |
| `403 Forbidden` from `nginx/1.24.0 (Ubuntu)` | Same: the proxy's default server answered |
| `426 Upgrade Required` | `proxy_http_version 1.1;` missing in the proxy site |
| `nginx -t`: `open() ... sites-enabled/databridge failed` | Broken symlink; `sudo rm /etc/nginx/sites-enabled/databridge` |
| `503 no healthy upstream` | Route works but no ready pod; `k -n cct-databridge get pods` |
| Backend `CrashLoopBackOff` | `k -n cct-databridge logs deploy/databridge-backend`; the secret `databridge-secrets` must exist |
| PVC `Pending` | `k get sc nfs-csi`; NFS server on 172.31.58.104 running |
| 404 from the URL | VirtualService host must exactly match the DNS name; gateway `dev/internal` must exist |
| Timeout from the URL | DNS record; NetworkPolicy `frontend-from-ingress-controller` must allow `istio-system` |

## Tested

Live on 2026-11-03: `https://databridge.openg2p.dpiforall.com/api/v1/health` returns `{"status":"ok","mode":"demo"}`; on the node, push 201 then UNCHANGED, masked pull, no key 401.

Before that, tested on a local minikube copy of this setup: Kubernetes v1.28.9, Calico, Istio 1.22.8, and the same `dev/internal` gateway on ports 8080/8443. Checks: console loads, unknown host returns 404, health ok, no key returns 401, push 201 then UNCHANGED, masked pull, data survives a backend restart, other namespaces cannot reach either Service. The sandbox used local storage instead of NFS.
