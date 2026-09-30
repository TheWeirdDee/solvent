# Demo runbook

A 3–5 minute demo of SOLVENT, with the exact commands and URLs. Two tracks:

- **Track A — the public app (no setup).** https://solvent-ashen.vercel.app/: the landing page, then the real Railway-hosted mint, already connected.
- **Track B — self-hosted real mint.** The same patched CDK mint and SOLVENT sidecar, run locally or on your own host (see [`DEPLOY-REAL-MINT.md`](DEPLOY-REAL-MINT.md)).

Both mints run fakewallet Lightning, and the page labels it as such. The real-LND evidence is the CI runs in the README's Evidence table.

## Before you start

```sh
curl -s https://solvent-production-9c92.up.railway.app/healthz    # {"ok":true,...}: the live backend is up
```

For Track B, or to re-check the reference case offline:

```sh
npm ci
npm run verify:submission     # expect: SUBMISSION READY
```

If `verify:submission` reports stale live evidence, run `npm run live-demo` (publishes a fresh kind 8181 event and re-signs the reserve statement) and re-run it.

## Track A — the public app (≈4 min)

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | https://solvent-ashen.vercel.app/ | "A valid Cashu token proves the mint signed it — not that the mint counted it." The hero terminal shows a reference mint that omitted a promised issuance, decided by the real verifier as the page loads: **PROMISED ISSUANCE OMITTED**. |
| 0:45 | **Try the live mint** → `#/mint` | A real patched CDK mint on Railway, its NUT-06 identity, and "Demo fakewallet — invoices settle automatically". Nothing to paste. |
| 1:00 | **Mint & verify an honest issuance** | The operation card appears under the button: the mint signs a receipt promising epoch N; the card counts down to N's close, then shows which relays ACKed the publication; the browser fetches the event back and re-queries the Mutinynet reserve. Result: **ACCEPT_VERIFIED**; the Enforcement card shows accept function calls: 1. |
| 2:15 | **Start again** → **Break the promise** | Before minting, the page registers this exact issuance for omission; the real epoch closer leaves it out. Receipt VALID, manifest VALID, delegation VALID, public evidence RETRIEVED, reserve COVERED — promised issuance MISSING. Result: **REFUSE — BROKEN PROMISE** (`REFUSE_ISSUANCE_OMITTED`); accept function calls: 0. Open the Nostr event from the result. |
| 3:15 | `#/verify` → **Re-check published evidence** | A captured reference case, published earlier and re-checked live now (it mints nothing): **ACCEPT_VERIFIED**. |
| 3:45 | README Evidence table | Real-LND CI runs: 36614823173 (Phase 3A/3B), 36619816959 (NUT-05). |

## Track B — self-hosted real mint (≈5 min)

Start the stack (Docker):

```sh
cd deploy
cp mint.env.example mint.env && cp sidecar.env.example sidecar.env   # fill in keys
cp mint.fakewallet.toml mint.toml
mkdir -p secrets && cp <reserve key>.json secrets/reserve-key.json
docker compose up -d --build
curl -s localhost:8085/v1/info | head -c 200     # mint up
curl -s localhost:8086/healthz                   # sidecar up, epoch open
```

Serve the site and open the real-mint page:

```sh
npm run dev
# http://localhost:5173/#/mint?mint=http://localhost:8085&evidence=http://localhost:8086
```

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | `#/mint` header | The Lightning mode shown comes from the sidecar (e.g. "Demo fakewallet — invoices settle automatically"). |
| 0:30 | **Mint & verify an honest issuance** | Real NUT-04 mint, receipt for epoch N; the sidecar closes N, publishes to Nostr, the browser fetches it back and checks the reserve. Result: **ACCEPT_VERIFIED**. |
| 2:00 | **Break the promise** | The sidecar omits exactly this issuance from the epoch it was promised to (`SOLVENT_DEMO_ALLOW_OMISSION=1`). All signatures remain valid. Result: **REFUSE_ISSUANCE_OMITTED**, only the inclusion check fails. |
| 3:30 | `curl -s localhost:8086/v1/solvent/status` | Closed epochs, publication ids, backend label. |
| 4:00 | `npm run verify:phase3b-evidence -- evidence/real-pol/phase3b-local-fakewallet` | Offline replay of a committed real run. |

Headless version of the same flow (what CI runs):

```sh
npm run verify:real-mint:browser -- http://localhost:5173/ http://localhost:8085 http://localhost:8086
```

## If something goes wrong

| Symptom | Cause | Fix |
| --- | --- | --- |
| `REFUSE_NOSTR_EVENT_NOT_FOUND` / `…_UNAVAILABLE` | Relays did not return the event | Retry; check `SOLVENT_NOSTR_RELAYS`. This is correct fail-closed behaviour. |
| `REFUSE_NOSTR_STALE` on the Live Public Demo | Reference event older than its freshness window | `npm run live-demo`, commit, redeploy (or run the *Refresh Live Evidence* workflow). |
| `#/mint` stuck on "3. Waiting for epoch N to close" | Sidecar not closing | `docker compose logs sidecar`; the epoch closes only once it holds liabilities. |
| Reserve check fails | Esplora (mutinynet.com) unreachable | Retry; the verifier refuses rather than guessing. |
