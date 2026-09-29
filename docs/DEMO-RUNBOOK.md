# Demo runbook

A 3–5 minute demo of SOLVENT, with the exact commands and URLs. Two tracks:

- **Track A — public site only (no setup).** Uses the published reference case, re-checked live.
- **Track B — real mint.** A patched CDK mint and the SOLVENT sidecar, running locally or on a host (see [`DEPLOY-REAL-MINT.md`](DEPLOY-REAL-MINT.md)).

Say plainly which track you are showing. Track B with fakewallet Lightning is labelled as such on screen; the real-LND evidence is the CI runs in the README's Evidence table.

## Before you start (both tracks)

```sh
npm ci
npm run verify:submission     # expect: SUBMISSION READY
```

If `verify:submission` reports stale live evidence, run `npm run live-demo` (publishes a fresh kind 8181 event and re-signs the reserve statement) and re-run it.

## Track A — public site (≈3 min)

| Time | Show | Say |
| --- | --- | --- |
| 0:00 | https://theweirddee.github.io/solvent/ | "A valid Cashu token proves the mint signed it — not that the mint counted it." The hero terminal shows a reference mint that omitted a promised issuance, decided by the real verifier as the page loads: **PROMISED ISSUANCE OMITTED**. |
| 0:45 | `#/verify` → **Run live check** | The verifier fetches the Nostr event from public relays and the reserve UTXO from Mutinynet, live. Result: **ACCEPT_VERIFIED**; point at each check. |
| 1:45 | `#/protocol` → reason-code table, `#/docs?doc=attack-corpus` | Same signatures, same healthy reserve, but the issuance is missing from the closed epoch → `REFUSE_ISSUANCE_OMITTED`. Every other refusal case is in the attack corpus (`npm run attacks`). |
| 2:30 | `#/mint` | What the real-mint flow needs (Track B); without a configured mint it says so instead of faking one. |
| 3:00 | README Evidence table | Real-LND CI runs: 36614823173 (Phase 3A/3B), 36619816959 (NUT-05). |

## Track B — real mint (≈5 min)

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
| 0:30 | **Get 64 sats of ecash and verify it** | Real NUT-04 mint, receipt for epoch N; the sidecar closes N, publishes to Nostr, the browser fetches it back and checks the reserve. Result: **ACCEPT_VERIFIED**. |
| 2:00 | **Get ecash — and make the mint break its promise** | The sidecar omits this issuance from the next epoch (`SOLVENT_DEMO_ALLOW_OMISSION=1`). All signatures remain valid. Result: **REFUSE_ISSUANCE_OMITTED**, only the inclusion check fails. |
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
