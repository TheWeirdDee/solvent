# Deploy a real SOLVENT mint

This is how to run a real, publicly reachable SOLVENT mint: a patched CDK Cashu mint, plus the SOLVENT sidecar that closes its accounting epochs, publishes them to Nostr and serves the evidence a wallet needs. A small Linux host with Docker is enough; Kubernetes is not needed. For Railway, see [`DEPLOY-RAILWAY.md`](DEPLOY-RAILWAY.md) (one service, one volume, two domains).

The artifacts in [`deploy/`](../deploy) are exercised end to end by the **Deploy Stack Check** workflow (`.github/workflows/deploy-stack-check.yml`), which runs these steps:

1. build both images;
2. start the stack;
3. drive the real browser flow against it;
4. require ACCEPT for an honest run and `REFUSE_ISSUANCE_OMITTED` for the broken promise.

## What runs

```text
public host
├── mint      patched cdk-mintd (patches/cdk/0001-0009)      :8085  -> https://mint.example.com
│             └── /data/cdk-mintd.sqlite  (CDK + SOLVENT tables, one file, persistent volume)
├── sidecar   SOLVENT (src/sidecar/service.ts)              :8086  -> https://evidence.example.com
│             ├── epoch closer     closes the OPEN epoch when it holds liabilities (~every 30s)
│             ├── Nostr publisher  kind 8181, relay ACK + exact fetch-back
│             └── evidence API     /v1/solvent/{status,issuance/<B_>}, /healthz, demo /v1/solvent/demo/omit
└── caddy     HTTPS for both hostnames (automatic certificates)
```

| Process | Owns | Reads | Writes |
| --- | --- | --- | --- |
| `mint` | Cashu (NUT-04/03/05/07/12), PoL receipts, the mint identity key | seed (mnemonic) | CDK tables; SOLVENT liability and receipt rows, via triggers in the same transactions |
| `sidecar` | epoch lifecycle, manifests, reserve binding, Nostr | the same SQLite file, the reserve-control key, the manifest key | `solvent_pol_epoch*` rows; `/data/solvent-publications.json` |
| `caddy` | TLS | — | its certificate store |

The web app (GitHub Pages or any static host) talks to both public URLs from the browser. Build it with `VITE_SOLVENT_MINT_URL` and `VITE_SOLVENT_EVIDENCE_URL`, or open `#/mint?mint=<url>&evidence=<url>`.

## Keys and secrets

| Key | Where it lives | Purpose |
| --- | --- | --- |
| Mint seed `CDK_MINTD_MNEMONIC` | `mint.env` only | Cashu keysets and the **NUT-06 mint identity** (its BIP32 master key) |
| Manifest private key `SOLVENT_MANIFEST_PRIVKEY` | `sidecar.env` only | signs epoch manifests and reserve bindings |
| Manifest public key `SOLVENT_MANIFEST_PUBKEY` | `mint.env` | the mint identity delegates it (patch 0008) at first boot, written to `/data/delegation.json` |
| Reserve-control key | `deploy/secrets/reserve-key.json`, mounted read-only into the sidecar | signs the reserve statement for the Mutinynet UTXO it controls |
| Nostr key `SOLVENT_NOSTR_SECRET_HEX` (optional) | `sidecar.env` | transport signature only; carries no authority |
| LND `tls.cert` and `admin.macaroon` (proof mode) | `deploy/secrets/lnd/`, mounted into the mint | real Lightning settlement |

`deploy/mint.env`, `deploy/sidecar.env`, `deploy/mint.toml` and `deploy/secrets/` are git-ignored. No process gets a key it doesn't use: the mint never sees the manifest private key, and the sidecar never sees the seed.

## Steps

```sh
cd deploy
cp mint.env.example mint.env         # CDK_MINTD_MNEMONIC, SOLVENT_MANIFEST_PUBKEY
cp sidecar.env.example sidecar.env   # SOLVENT_MINT_URL, SOLVENT_MANIFEST_PRIVKEY, hosts, backend label
cp mint.fakewallet.toml mint.toml    # or mint.lnd.toml; set [info].url to the public mint URL
mkdir -p secrets && cp <reserve key>.json secrets/reserve-key.json
docker compose up -d --build                  # mint + sidecar
docker compose --profile https up -d          # add Caddy once DNS points here
```

**Startup order.** The mint's first boot does four things:

1. imports `mint.toml`;
2. starts `cdk-mintd` once so CDK creates its schema, then stops it;
3. applies SOLVENT migrations 0001–0003 (epoch 1 opens);
4. has the mint identity delegate the manifest key, valid from epoch 1.

After that it runs `cdk-mintd`. The sidecar waits until the SOLVENT schema and the delegation exist, then starts closing epochs.

**Health.**

- `GET /v1/info` on the mint (also its Docker `HEALTHCHECK`).
- `GET /healthz` on the sidecar, which reports the open epoch and the last publication.
- `GET /v1/solvent/status` gives the full state, including the Lightning mode shown to users.

**Restart.** Both services use `restart: unless-stopped`, and state is only the `mint-data` volume. Restarting either container is safe: epochs are committed SQLite state and closing is atomic (`docs/epoch-lifecycle.md`). A pending demo omission request is in memory and is dropped on restart.

**Backup.** Stop both containers, or use `sqlite3 /data/cdk-mintd.sqlite ".backup …"`, and copy `/data` (the database, `delegation.json` and `solvent-publications.json`). Losing the database loses the mint.

**Rotating the manifest key.** Generate a new key, then issue a new delegation with `--valid-from-epoch <the current open epoch>` (`cdk-mintd solvent delegate-manifest-key`). Only after that, switch the sidecar to the new key. The closer refuses a silent key change between epochs.

## Two modes: always labelled

| | Proof mode | Public interactive demo |
| --- | --- | --- |
| Lightning | real LND (`mint.lnd.toml`, `SOLVENT_LIGHTNING_BACKEND=lnd`) | CDK fakewallet (`mint.fakewallet.toml`, `SOLVENT_LIGHTNING_BACKEND=fakewallet`); invoices settle by themselves |
| Mint, receipts, epochs, MMRs, manifests, delegation | real | real |
| Nostr publication and fetch-back | real public relays | real public relays |
| Bitcoin reserve | real Mutinynet UTXO | real Mutinynet UTXO |

The `#/mint` page states the mode from the sidecar's `/v1/solvent/status`, for example "Demo fakewallet — invoices settle automatically; no real Lightning payment". A fakewallet deployment is **never** described as real Lightning. The strongest evidence, with real LND, comes from the Real Cashu + SOLVENT Integration CI run.

## Network configuration

- **Mutinynet:** the reserve is queried through `https://mutinynet.com/api` (Esplora). `SOLVENT_RESERVE_OUTPOINT` must be a P2TR output of the reserve-control key.
- **Nostr:** the defaults (current public demo configuration, `POL_RELAYS`) are `wss://nos.lol`, `wss://relay.primal.net`, `wss://nostr.mom`, `wss://offchain.pub` and `wss://relay.snort.social`; `SOLVENT_NOSTR_RELAYS` overrides them. A publication counts only after at least one ACK and an exact fetch-back by id. Otherwise the epoch is recorded as `unpublished`, and wallets correctly refuse with PUBLIC EVIDENCE NOT FOUND.
- **CORS:** both the mint (cdk-axum) and the sidecar send `Access-Control-Allow-Origin: *`, so browser wallets can call them.

## Security limitations

- **The demo omission endpoint** (`SOLVENT_DEMO_ALLOW_OMISSION=1`) lets any visitor make the mint break its promise for their own issuance. That is the purpose of the demo, but never enable it on a mint presented as honest.
- **Custodial trust remains.** SOLVENT makes a mint's accounting checkable; it does not make Cashu non-custodial.
- **Single keyset only.** An epoch spanning several keysets is refused (`REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE`), not aggregated.
- **Local signatory only.** A remote gRPC signatory cannot sign the delegation (it fails closed).
- **Test network.** This is Mutinynet, not Bitcoin mainnet.
- **The reserve key in this repository** (`evidence/reserves/reserve-key.json`) is a published Signet test key. A real deployment must use its own key and its own UTXO.
