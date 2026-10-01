# Deploy the real SOLVENT mint on Railway

The same patched CDK mint and SOLVENT sidecar as [`DEPLOY-REAL-MINT.md`](DEPLOY-REAL-MINT.md), packaged for Railway. The website is a static build (Vercel at https://solvent-ashen.vercel.app/, mirrored on GitHub Pages); Railway runs only the mint and the evidence API.

## Why one Railway service, not two

The mint and the sidecar share **one SQLite file**:

- SOLVENT's triggers record liabilities and sign receipts inside CDK's own transactions.
- The sidecar's epoch closer writes epoch rows into that same database.

A Railway volume attaches to a single service, so the two processes run in one service with one volume. That service has **two public domains**, one per port:

```text
Railway service (railway.toml -> deploy/railway/Dockerfile)
├── cdk-mintd (patches 0001-0009, fakewallet)   0.0.0.0:8085  <- domain 1: PUBLIC MINT URL
├── SOLVENT sidecar (closer, Nostr, evidence)   :8086         <- domain 2: PUBLIC EVIDENCE URL
└── volume /data: cdk-mintd.sqlite, delegation.json, solvent-publications.json
```

The sidecar never calls the mint over HTTP; it reads the shared database. No internal or private-network URL is involved. The only mint URL anywhere is the public one, and it is bound into the NUT-06 delegation.

The image is built from the same sources as `deploy/mint/Dockerfile` and `deploy/sidecar/Dockerfile`. The Deploy Stack Check workflow builds and runs it the way Railway does:

- `PORT=8085`, the Railway environment markers and a volume at `/data`;
- the full honest and broken-promise browser flows;
- a restart, which must keep the same identity;
- the two start guards below.

## What the container checks before starting (`deploy/railway/start.sh`)

- `SOLVENT_PUBLIC_MINT_URL` must be `https://…`, so a localhost or internal URL can never end up in the delegation.
- On Railway, a volume must be mounted at `/data`, or the container refuses to start. Without a volume, the mint's identity state would vanish on the next deploy.
- `PORT` must be `8085`: the health check (`/v1/info`) must reach the mint.
- If `/data/delegation.json` already exists, it must be bound to the same public mint URL.
- Secrets are split per process: the mint never sees the manifest, reserve or Nostr keys, and the sidecar never sees the mint seed.

## Variables

`npm run railway:secrets` writes all of them to `deploy/secrets/railway.env`, which is git-ignored. It prints only names. It is idempotent: re-running never rotates an existing value.

| Variable | Kind | Notes |
| --- | --- | --- |
| `SOLVENT_PUBLIC_MINT_URL` | public config | `https://<domain for port 8085>`. Must be set **before the first boot**: the mint's stored config and its delegation bind it |
| `PORT` | public config | `8085` |
| `CDK_MINTD_MNEMONIC` | persisted secret | the mint seed = its NUT-06 identity and keysets. Never change it after the first boot; back up the file |
| `SOLVENT_MANIFEST_PRIVKEY` | persisted secret | signs manifests; its public key is delegated at first boot. Rotating it needs a new delegation (`DEPLOY-REAL-MINT.md`) |
| `SOLVENT_RESERVE_KEY_JSON` | persisted secret | this deployment's own Mutinynet reserve-control key. Never the published test key; the script refuses it |
| `SOLVENT_RESERVE_OUTPOINT` | public config | `txid:vout` of the funded reserve UTXO. The script fills it once the address is funded |
| `SOLVENT_NOSTR_SECRET_HEX` | secret, may rotate | transport signature only, no authority; kept stable anyway |
| `SOLVENT_DEMO_ALLOW_OMISSION` | public config | `1`: enables the broken-promise demo. The mint is labelled as a demo |
| `SOLVENT_EPOCH_INTERVAL_SECONDS` | public config | `30` |
| `SOLVENT_EVIDENCE_VALIDITY_SECONDS` | public config | `3600` |

The start script sets the Lightning backend to `fakewallet`. The image ships only the fakewallet mint configuration, and the page and evidence say so.

Railway itself provides `RAILWAY_PROJECT_ID` and `RAILWAY_VOLUME_MOUNT_PATH`.

## CORS

Both APIs send `Access-Control-Allow-Origin: *`: cdk-axum's own middleware for the mint, and `src/sidecar/api.ts` for the evidence service. That is correct for them. A Cashu mint is a public API that any wallet origin may call, no request carries credentials or cookies, and everything served is public evidence. Restricting the origin would not protect the demo omission endpoint, since non-browser clients ignore CORS; what gates it is `SOLVENT_DEMO_ALLOW_OMISSION`.

## Public interactive deployment vs CI evidence

| | Railway (public, interactive) | Real Cashu + SOLVENT Integration (CI) |
| --- | --- | --- |
| Mint | real patched CDK `cdk-mintd` | real patched CDK `cdk-mintd` |
| Lightning | **fakewallet**: invoices settle by themselves, labelled on screen | **real LND** (regtest) |
| Receipts, accounting, epochs, manifests, delegation | real | real |
| Nostr | real public relays | real public relays |
| Reserve | real Mutinynet UTXO (this deployment's own key) | real Mutinynet UTXO |
| Verifier | real, in the visitor's browser | real |

## After deploying

```sh
npm run verify:railway -- https://<mint domain> https://<evidence domain>
```

This checks the following:

- **A. Mint:** `/v1/info`.
- **B. Identity:** the NUT-06 identity against the delegation.
- **C. Evidence service:** health, binding to the public mint URL, and the backend label.
- **D. CORS:** requests from the GitHub Pages origin.
- **E. Nostr:** the latest epoch's event on public relays.
- **F. Browser:** a real browser on the public app (https://solvent-ashen.vercel.app/) runs the honest flow (`ACCEPT_VERIFIED`) and the broken-promise flow (`REFUSE_ISSUANCE_OMITTED`). Together these cover the receipt endpoint, the epoch evidence, the live reserve and the Nostr fetch-back.

The public page is:

```text
https://solvent-ashen.vercel.app/#/mint?mint=https%3A%2F%2F<mint domain>&evidence=https%3A%2F%2F<evidence domain>
```

The production builds default `#/mint` to this deployment (`.env.production`), so the plain https://solvent-ashen.vercel.app/#/mint connects to it without parameters.

```text
```

## Troubleshooting: Railway built the website instead of the mint

**Symptoms:**
- the build log says `Detected Node`, `Deploying as vite static site`, `runtime: caddy`;
- the mint URL's `/v1/info` returns the SOLVENT web page (HTML);
- the evidence URL answers "Application failed to respond".

**Cause:** Railway's auto-detection (Railpack) was used instead of `railway.toml`'s `builder = "DOCKERFILE"`. That happens when the service's own build settings take precedence over the repository config. The static site answers every path with `index.html` and HTTP 200, so the `/v1/info` healthcheck passes and the wrong build is marked healthy.

**Fix (state is not affected; the volume, variables and domains stay):**
1. Service → **Settings** → **Build** → **Builder** = **Dockerfile**.
2. Same section → **Dockerfile Path** = `deploy/railway/Dockerfile`.
3. Redeploy the latest `main`.

The build log must then show the Docker build stages (`FROM rust:1-bookworm AS build` …), not "vite static site".

**Check:**
```sh
npm run verify:railway -- https://<mint domain> https://<evidence domain> --no-browser --expect-identity <the mint's NUT-06 pubkey>
```
It fails on an HTML `/v1/info`, on a missing endpoint map at `/`, or on a changed identity.

## Changing the mint URL

The delegation is bound to the URL at first boot, and the container refuses to start under a different one. To move to a new domain, either:

- keep the old domain; or
- delete the volume, which is a new mint with new keysets (outstanding ecash is lost); or
- keep the volume and re-issue the delegation and the stored config (operator work: `cdk-mintd config replace` and `solvent delegate-manifest-key`).
