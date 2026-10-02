# SOLVENT

**BOSS Battle 2026 — Freedom Stack (Nostr + Ecash)**
**Problem:** Auditable Ecash — mint proof-of-reserves and proof-of-liabilities
**Team:** [TheWeirdDee](https://github.com/TheWeirdDee)
**License:** MIT

**Public app:** https://solvent-ashen.vercel.app/ — start at the landing page, then **Try the live mint**: a real patched CDK mint and SOLVENT evidence service on Railway, already connected.
**Demo video:** DEMO_VIDEO_URL_PENDING — being recorded from [`docs/DEMO-RUNBOOK.md`](docs/DEMO-RUNBOOK.md)

> The mint made a promise. Did it keep it? SOLVENT checks a Cashu mint's signed Proof-of-Liabilities receipt against the mint's own closed accounting epoch, public Nostr evidence and a live Bitcoin reserve — before the ecash is accepted.

## Demo

**Judge SOLVENT in 3 minutes** on https://solvent-ashen.vercel.app/#/mint:

1. **Mint & verify an honest issuance** → `ACCEPT_VERIFIED` (the accept function is called once).
2. **Break the promise** → `REFUSE_ISSUANCE_OMITTED`: every signature valid, public evidence retrieved, reserve covering — only the promised issuance is missing. The accept function is not called.
3. **Inspect the evidence**: open the Nostr event and the reserve transaction from the result, or download it.
4. **Real Lightning**: the live mint uses demo (fakewallet) Lightning; the same pipeline over real LND is committed evidence: the app's [Evidence page](https://solvent-ashen.vercel.app/#/publish), or the [Evidence](#evidence) section below.

Video: DEMO_VIDEO_URL_PENDING. Script: [`docs/DEMO-RUNBOOK.md`](docs/DEMO-RUNBOOK.md). Step-by-step: [`docs/start-here.md`](docs/start-here.md).

## What SOLVENT is

**The problem.** A valid Cashu token proves the mint signed it. It does not prove the mint *counted* it. A custodial mint can issue ecash and leave that liability out of the books it publishes, and a reserve ratio computed from those books still looks healthy.

**The solution.** When SOLVENT's patched mint issues ecash, it signs a **receipt promising to count that exact issuance in accounting epoch N**. When N closes, the mint commits all of its liabilities to a signed sum-MMR manifest, publishes it on **Nostr**, and binds it to a **real Bitcoin UTXO**. Before accepting ecash, the holder's verifier:

1. reconstructs the issuance from its own proof (NUT-12);
2. checks the receipt;
3. checks that the epoch's manifest is authorized by the mint's own **NUT-06 identity**;
4. checks that its issuance is **included**;
5. fetches the evidence **back from public relays**;
6. re-queries the **reserve on chain**.

If the mint broke its promise, the result is `REFUSE_ISSUANCE_OMITTED`, even when every signature is valid and the reserve is healthy.

The protocol follows the Cashu PR #388 Proof-of-Liabilities draft (receipts, sum-MMR, epoch manifests). It is implemented as nine small patches to the real CDK mint plus SOLVENT's accounting, closer, sidecar and verifier.

## Try it

| What | How |
| --- | --- |
| **Public app** | https://solvent-ashen.vercel.app/. **Try the live mint** (`#/mint`) issues real ecash from the Railway-hosted mint: **Mint & verify an honest issuance** (ACCEPT), then **Break the promise** (REFUSE). No URLs or JSON to paste. **Re-check published evidence** (`#/verify`) re-verifies a captured reference case against live relays and the chain; it mints nothing |
| **Live backend** | Mint [`/v1/info`](https://solvent-production-2029.up.railway.app/v1/info) · evidence service [`/v1/solvent/status`](https://solvent-production-9c92.up.railway.app/v1/solvent/status) (Railway; [`docs/DEPLOY-RAILWAY.md`](docs/DEPLOY-RAILWAY.md)). Lightning is **fakewallet** there, and the page says so |
| **Real mint, locally** | Start a patched `cdk-mintd` and the sidecar ([`docs/DEPLOY-REAL-MINT.md`](docs/DEPLOY-REAL-MINT.md); `deploy/docker-compose.yml`), then open `#/mint?mint=<mint URL>&evidence=<sidecar URL>`. Click **Mint & verify an honest issuance** (ACCEPT), then **Break the promise** (REFUSE) |
| **One-command checks** | `npm run verify:submission` (mechanism, attack corpus, live reference case); `npm run verify:phase3b-evidence -- evidence/real-pol/phase3b-local-fakewallet` (offline replay of a real public-evidence run) |
| **Real-mint browser E2E** | `npm run verify:public-app` (the exact public app) or `npm run verify:real-mint:browser -- <site> <mint URL> <sidecar URL> [--browser webkit --width 390]` |

## Architecture

```text
 wallet / browser                         mint host
 ────────────────                         ─────────
 cashu-ts ── NUT-04/03/05 ──────────────► cdk-mintd (patches/cdk/0001-0009)
    │  ◄── signed PoL receipt (epoch N) ──  │  SQLite: CDK tables + SOLVENT triggers
    │                                        │  (liabilities stamped with the OPEN epoch,
    │                                        │   receipts signed in the same transaction)
    │                                        ▼
    │                                     SOLVENT sidecar
    │                                        closes N -> sum-MMR manifest (manifest key,
    │                                        delegated by the mint's NUT-06 identity)
    │                                        -> live Mutinynet reserve + reserve binding
    │                                        -> kind 8181 on public Nostr relays (ACK + fetch-back)
    │  ◄── /v1/solvent/issuance/<B_> ──────  evidence API
    ▼
 verifySubmission() -> verify()
    NUT-06 identity (from the mint) · delegation · receipt · manifest · inclusion
    · Nostr event (from relays) · reserve (from Esplora) · coverage
    -> ACCEPT_VERIFIED | REFUSE_*
```

Details: [`docs/epoch-lifecycle.md`](docs/epoch-lifecycle.md), [`docs/manifest-key-delegation.md`](docs/manifest-key-delegation.md), [`docs/phase3b-public-evidence.md`](docs/phase3b-public-evidence.md), [`docs/nut05-melt-accounting.md`](docs/nut05-melt-accounting.md), [`docs/DEPLOY-REAL-MINT.md`](docs/DEPLOY-REAL-MINT.md).

## Reality map

**Real**, and verified in CI over real regtest Lightning (LND):

- the CDK Cashu mint (`cdk-mintd` v0.18.1, built from source with `patches/cdk/0001-0009`);
- NUT-04 issuance, NUT-03 swap, NUT-05 melt with change, NUT-07 proof state and NUT-12 DLEQ;
- PoL receipts signed by the mint's per-amount keys, inside CDK's own transactions;
- the epoch lifecycle, the issued and spent sum-MMRs and signed manifests, crash rollback and restart;
- the mint's NUT-06 identity delegating the manifest key (patch 0008);
- the live Mutinynet reserve UTXO, the reserve-control signature and the epoch-scoped reserve binding;
- Nostr kind 8181 publication on public relays, with ACK and exact fetch-back;
- the central verifier's ACCEPT and REFUSE decisions, including the broken promise.

**Public interactive deployment** (https://solvent-ashen.vercel.app/ + Railway): real patched CDK mint, real receipts, accounting, epochs, manifests and delegation, real public Nostr, a real Mutinynet reserve and the real verifier — with CDK **fakewallet** Lightning, where invoices settle by themselves. It is labelled so in the UI and in the evidence, and never called real Lightning.

**CI evidence:** the same mint over **real LND**, the full Phase 3B public evidence, and real NUT-05 (see the [Evidence page](https://solvent-ashen.vercel.app/#/publish) and the [Evidence](#evidence) section below).

**Also:** *Re-check published evidence* verifies a captured *reference* case (published earlier, re-checked live); the network is a **test network** (Mutinynet / Bitcoin Signet), not Bitcoin mainnet.

**Limitations:**

- Custodial Cashu trust remains. SOLVENT makes the mint's accounting checkable; it does not remove the custodian.
- Multi-keyset epochs are refused (`REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE`), not aggregated.
- A remote (gRPC) signatory cannot sign the mint-identity delegation, so it fails closed.
- Public relay availability matters. When evidence can't be fetched, nothing is accepted and the result says the check *could not complete* (`REFUSE_NOSTR_EVENT_NOT_FOUND` or `…_UNAVAILABLE`); that is not a finding against the mint, and *Retry verification* re-checks the same issuance.
- The public mint runs fakewallet Lightning (labelled); real LND is proven in CI. Hosting is reproducible: Railway (`railway.toml`, [`docs/DEPLOY-RAILWAY.md`](docs/DEPLOY-RAILWAY.md)) or Docker Compose on any Linux host ([`docs/DEPLOY-REAL-MINT.md`](docs/DEPLOY-REAL-MINT.md)).
- The HTTPS relay fetch (used only when a browser cannot open relay WebSockets) is run by the mint's own evidence service; its result is still verified in the browser, but "was it published" then rests on that service querying the relays honestly. See [`docs/trust-boundaries.md`](docs/trust-boundaries.md).

The complete line-by-line table is in [`docs/REALITY-MAP.md`](docs/REALITY-MAP.md), and the decision history in [`DECISIONS.md`](DECISIONS.md).

## Evidence

Every real-LND result below is **committed to this repository**, so it can be read directly and survives the expiry of GitHub's CI artifacts (December 2026). The full index, with backends, dates, event ids and verification commands, is [`evidence/README.md`](evidence/README.md).

| Milestone (real LND) | Committed evidence | Original CI run | Check it |
| --- | --- | --- | --- |
| **Phase 3B: public solvency evidence.** Honest `ACCEPT_VERIFIED` (13/13 checks) and broken promise `REFUSE_ISSUANCE_OMITTED` (only inclusion fails) | [`phase3-accept.json`](evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-accept.json) · [`phase3-omission-refuse.json`](evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-omission-refuse.json) · [full package](evidence/real-pol/ci-36614823173-lnd/phase3b/) | [36614823173](https://github.com/TheWeirdDee/solvent/actions/runs/36614823173) | `npm run verify:phase3b-evidence -- evidence/real-pol/ci-36614823173-lnd/phase3b` (offline replay) |
| **NUT-05: melt with change, accounted** | [`nut05-melt.json`](evidence/real-pol/ci-36619816959-lnd/nut05/nut05-melt.json) | [36619816959](https://github.com/TheWeirdDee/solvent/actions/runs/36619816959) | Inspect the JSON |
| **Phase 3A / Phase 2: epoch lifecycle, mint-native accounting, crash and restart** | [`phase3a/`](evidence/real-pol/ci-36614823173-lnd/phase3a/) (public audit record; two never-spent proof files withheld, so not offline-replay complete) | [36614823173](https://github.com/TheWeirdDee/solvent/actions/runs/36614823173) | Inspect the JSON |
| **NUT-03: swap accounting** | in the run artifact | [36150315347](https://github.com/TheWeirdDee/solvent/actions/runs/36150315347) | `npm run verify:nut03-evidence -- 36150315347` |

The live public mint's evidence (fakewallet Lightning) is published as it runs: see *Live mint* and *Evidence* in the app. The CI artifacts are secret-scanned before upload. Committed packages contain no keys, and only Cashu proofs recorded as spent.

## Why SOLVENT exists

A Cashu mint's own signed receipt can promise to count a specific issuance in a specific accounting epoch — and the mint can still close that epoch without it, while everything else about the epoch (its own manifest signature, its own reserve) looks perfectly healthy:

```
Mint signs:    "I will count this 70,000-sat issuance in epoch 12."
Epoch 12 closes, signed, internally consistent.
Reserve:       1,000,000 sats, real, unspent, independently verified.

BUT: the 70,000-sat issuance never appears in epoch 12's signed accounting.
```

A reserve-ratio dashboard cannot catch this — the ratio is computed from whatever the mint chooses to report, and the mint's own accounting can be internally consistent while still omitting a specific promised issuance. SOLVENT catches it because the holder independently reconstructs their exact issuance from their own Cashu proof (never a mint-supplied identifier) and checks it against the epoch the mint itself signed and closed — refusing the ecash even when the mint's reserve is comfortably healthy.

## Routes

Hash-routed single page:

- **`/`** — the broken-promise story in plain language, with live observations of the Railway mint.
- **`/mint`** — **Live mint**: a fresh issuance on the real patched CDK mint, its signed promise, the epoch wait, verification, the enforcement card, evidence links and downloads. Also the broken-promise run and Retry verification.
- **`/verify`** — **Re-check published evidence** (a captured reference case, re-checked live) and **Verify evidence** (paste, upload or drop a bundle).
- **`/publish`** — **Evidence**: the mint-operator evidence pipeline.
- **`/protocol`** — the decision chain `verify()` runs.
- **`/docs`** — all documentation, including deployment.
- **`/lab`** — developer reference mint in the browser. It is never publicly published, so its evidence can't be accepted.

## What SOLVENT supports

**Supported:** SOLVENT-compatible evidence bundles — a signed PoL receipt, a signed closed epoch manifest, an inclusion proof (or an honest `null`), a signed reserve attestation, and a signed Nostr evidence event, in the exact structure `src/app/submission.ts`'s `SubmissionBundle` defines (see `docs/verification-bundle.md`). A SOLVENT-compatible mint exports it with the ecash; **Load live example** on /verify loads the published reference case, and the developer reference mint lab (`#/lab`) generates local ones — you never hand-construct it.

**Not automatically supported:** arbitrary Cashu tokens or mints that don't publish this evidence chain. Pasting a plain Cashu token, or a bundle from a mint that doesn't produce signed PoL receipts/manifests/reserve attestations/Nostr evidence, is reported as **UNSUPPORTED MINT** or **INCOMPLETE BUNDLE** — SOLVENT fails closed rather than guessing at partial support.

## Quick start (clean machine)

```bash
git clone <this-repo>
cd solvent
npm install
npm test                    # 200+ tests
npm run build                # typecheck + production bundle
npm run verify:submission    # the 5-minute judge verifier — see VERIFY_IN_5_MINUTES.md
npm run verify:cashu-real    # PHASE 1: real CDK mint + real regtest Lightning lifecycle — see docs/real-cashu-stack.md (requires the stack from docs/reproduce-real-stack.md or .github/workflows/real-cashu-integration.yml; not runnable standalone)
```

### CLI — regenerate evidence

```bash
npm run gate0     # NUT-12 transfer invariant
npm run gate1     # signed PoL receipt
npm run gate2     # signed epoch + hero omission contradiction
npm run gate4     # real acceptance side effect
npm run gate5     # real Nostr publish/fetch against public relays
npm run gate6     # real Signet reserve attestation
npm run attacks   # the full 25-case attack corpus
npm run live-demo         # generates + publishes the reference case used by /verify's Re-check published evidence and "Load live example"
npm run live-demo:release # live-demo + build in one step — the evidence is bundled at build time, so a rebuild is required for a deployed site to see it
npm run verify:live-demo  # independently re-verifies the Live Public Demo is still live + fresh right now (real relay fetch, real Esplora query, network-aware exact expiry)
npm run verify:deployed -- <url>         # confirms a DEPLOYED build (not just local dist/) is serving the current canonical evidence, via a real fetch
npm run verify:deployed:browser -- <url> # confirms a DEPLOYED build's live check reaches a real ACCEPT VERIFIED in headless Chromium
npm run verify:ui:browser -- <url>       # real-browser UI check: routes, 1440/1024/768/390 overflow, sticky docs sidebar, live check, lab
```

Every command re-runs real cryptography (and, for `gate5`/`gate6`/`live-demo`/`verify:live-demo`, real network I/O) and writes machine-readable evidence under `evidence/`. See `VERIFY_IN_5_MINUTES.md`.

`npm test` never touches the network — every real Esplora/Nostr-relay call is mocked, so it's deterministic regardless of internet availability. The commands above (and `npm run verify:submission`, which runs the CLI mechanism checks plus these live evidence files) are the separate, real-network gate — see `VERIFY_IN_5_MINUTES.md` for exactly how `verify:submission` reports live-evidence lines distinctly from mechanism/logic lines.

### Web UI

```bash
npm run dev
```

Opens on the landing page (`/`): the problem (a valid Cashu token doesn't prove the mint counted what it owes), the solution, who it's for, and the broken-promise story. It links into:

- **Verify** (`/verify`) — two modes:
  - **Re-check published evidence** — runs SOLVENT against the published reference case (`evidence/nostr/live-demo.json`, published by `npm run live-demo`). Every run re-fetches its Nostr event from real public relays and re-queries its reserve UTXO on Bitcoin Signet (Mutinynet), then runs the real verifier. It shows when the case was published and when its evidence expires, "Last checked", Nostr LIVE / NOT FOUND / UNAVAILABLE, Reserve LIVE / SPENT / UNAVAILABLE, and the exact event id and reserve txid:vout it checked. Nothing is substituted from bundled data when a request fails — the result is a REFUSE naming what couldn't be checked.
  - **Verify evidence** — paste or upload a SOLVENT verification bundle, or click **Load live example** to load the same published reference case. See `docs/verification-bundle.md` for the schema. A plain Cashu token, or a bundle with no liability evidence, is refused as **UNSUPPORTED MINT**.

  Both modes run the same eight checks (token format, mint origin / NUT-12, PoL receipt, promised epoch, signed epoch manifest, liability inclusion, public Nostr retrieval, live reserve), then one final decision. The result always leads with the decision (**ACCEPT** or **REFUSE**) and its reason; partial facts such as "local cryptography: valid" sit beneath it. **Accept ecash** is wired to the real Gate 4 acceptance boundary (enabled only on `ACCEPT_VERIFIED`, called exactly once). Raw JSON lives behind collapsed "View raw bundle" / "View result JSON" toggles.
- **Protocol** (`/protocol`), **Docs** (`/docs`), and a read-only **evidence pipeline** view (`/publish`).
- **Reference mint lab** (`#/lab`, developers only — linked from the footer, not the navigation) — SOLVENT's reference mint running in the browser, with one persistent identity and keyset (until explicitly rotated), a new proof, receipt and closed epoch per issuance, and a choice of amounts. Its evidence is never published, so its primary action is **Check local cryptography**; a full verification of lab evidence refuses with PUBLIC EVIDENCE NOT FOUND. It can also break a promise on purpose (BROKEN PROMISE) or issue past the reserve (RESERVE SHORTFALL).

The real CDK mint is the backend behind **Live mint** (`#/mint`): the Railway-hosted patched `cdk-mintd` with fakewallet Lightning. The same mint runs over real LND in CI. See `docs/trust-boundaries.md`'s "What the app runs against".

### The two-tier Nostr guarantee

SOLVENT's whole premise is that a mint's accounting is *publicly checkable*, not just privately signable — so a bundle's own privately-supplied signed Nostr event, however cryptographically valid, does **not** by itself satisfy the live acceptance gate. `verifySubmission()` (`src/app/submission.ts`) always genuinely attempts to fetch the bundle's evidence from real public relays; only a bundle whose evidence a relay actually returns can reach `ACCEPT_VERIFIED`. That is why locally generated lab evidence (intentionally never published — publishing a throwaway event on every click would spam production relays) cannot reach ACCEPT, while the published reference case can. See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee".

"Couldn't find it" and "couldn't check" are never collapsed into one reason: a relay that answers but doesn't have the event yields `REFUSE_NOSTR_EVENT_NOT_FOUND`, while no relay being reachable yields `REFUSE_NOSTR_UNAVAILABLE`. Both are shown as *verification could not complete* (amber), with nothing accepted and *Retry verification* offered, never as a broken promise. One bounded retry absorbs transient relay misses without ever masking a genuinely unpublished event; see "Bounded relay-fetch retry" in `docs/trust-boundaries.md`.

The reference case has a real, finite shelf life — its *reserve* attestation (~7 days on Mutinynet), not its Nostr event, is the binding freshness constraint (see `docs/trust-boundaries.md`'s "Effective expiry"). `npm run verify:submission`'s "Canonical Live Public Demo" line is a real, right-now check of it: `ENGINEERING READY` (and therefore `SUBMISSION READY`) is impossible while it fails. See "Deployment" below for how it is kept fresh.

Honest notes:

- The built-in reserve is Bitcoin Signet (Mutinynet) **test-network capital**, not mainnet capital.
- Random external Cashu mints are **not** supported — only mints that publish the exact evidence chain `verify()` needs. See the FAQ.

## Refusal cases

| Case | Expected result |
| --- | --- |
| Published reference case — issuance included, public Nostr evidence retrieved live, reserve covers it | **ACCEPT VERIFIED** (Re-check published evidence) |
| BROKEN PROMISE — promised issuance omitted from the closed epoch | **REFUSE — `REFUSE_ISSUANCE_OMITTED`** (even though reserve is healthy) |
| RESERVE SHORTFALL — issuance correctly included, but reserve below liabilities | **REFUSE — `REFUSE_RESERVE_SHORT`** |
| Signed evidence that was never published | **REFUSE — `REFUSE_NOSTR_EVENT_NOT_FOUND`** |

BROKEN PROMISE is the point of the project: the mint really signed a receipt promising to count this issuance in this epoch (the receipt verifies, the issuance is real), but the epoch it closed and signed doesn't include it — while its live reserve is comfortably healthy. SOLVENT catches this because the holder independently reconstructs their own issuance and checks it against what the mint itself signed, not against a reported ratio.

See it on the landing page's live-computed example, in the reference mint lab (`#/lab`), or reproduce the same properties via `npm run attacks` (A01/A02/A23/A25) and their evidence under `evidence/attacks/`.

## Verifier internals

```
Cashu proof
    -> NUT-12 DLEQ / holder reconstruction of B'         (src/cashu/reconstruct.ts)
    -> signed PoL receipt for this exact B' + epoch        (src/pol/receipt.ts)
    -> target epoch closed, signed manifest verifies         (src/pol/manifest.ts)
    -> sum-MMR inclusion for the reconstructed B'               (src/pol/mmr.ts)
    -> Nostr evidence: signature / freshness / conflict          (src/nostr/pol-evidence.ts)
    -> reserve attestation: signatures / independent re-query     (src/reserve/evaluate.ts)
    -> ACCEPT_VERIFIED / REFUSE_*                                   (src/verifier/verify.ts)
    -> real acceptance side effect, spy-tested                       (src/enforcement/accept-gate.ts)
    -> Accept enabled / disabled in the UI                              (src/app/verifier-panel.ts)
```

```
solvent/
  evidence/                 machine-readable evidence written by npm run gate0..gate6 / attacks
  docs/
    trust-boundaries.md     what SOLVENT does and does not prove, right now
    nostr-schema.md         the v2 Nostr event kind/schema/verification rules
    reserve-attestation.md  the Gate 6 bounded reserve-proof design
    verification-bundle.md  the exact canonical bundle schema + a complete real example
    draft-alignment.md      exactly what's byte-exact to Cashu PR #388 vs. cut
  src/
    cashu/                  NUT-12 DLEQ + holder reconstruction, fixture-mint blind-signing
    pol/                    PR #388 sum-MMR, epoch manifest, signed receipts
    nostr/                  v2 evidence event (pol-event.ts) + publish/fetch/evaluate (pol-evidence.ts)
    reserve/                Taproot key derivation, reserve statement, independent evaluation
    enforcement/            the real acceptance side-effect boundary (Gate 4)
    verifier/               the central verify() decision function + stable reason codes
    cli/                    gate0..gate6, attacks, verify-submission CLIs
    app/                    the web client — router.ts, protocol-demo.ts (the one real
                             reference issuance/evidence builder behind the live check, the lab, and
                             Verify your evidence — see createTestEcash()/verifyEcash()/runScenario()),
                             submission.ts (SubmissionBundle: raw evidence only, plus
                             verifySubmission() — independently re-derives reserve/Nostr status via a
                             live chain re-query + an independent cryptographic re-check before ever
                             calling verify(); no pasted bundle can assert its own "verified" status),
                             bundle-json.ts (canonical bundle <-> JSON, handles Amount/bigint/Uint8Array),
                             evidence-data.ts (real captured evidence), docs-data.ts + markdown.ts
                             (renders real docs), verifier-panel.ts, publisher-panel.ts, hero-panel.ts,
                             docs-panel.ts, main.ts
```

PROTOCOL.md has the full byte-level formulas; ATTACKS.md has the complete attack-corpus table.

## Nostr event: kind & schema

Kind **`8181`** (regular/immutable), content schema `solvent/pol/v2`. Full field-by-field spec and the tag-letter rationale in [`docs/nostr-schema.md`](docs/nostr-schema.md).

## NUT-12 requirement

A presented proof MUST carry `dleq.e`, `dleq.s`, and `dleq.r` for SOLVENT to independently verify it. `r` is what lets a *receiver* (not just the original minting wallet) reconstruct `B'`/`C'` offline. A proof missing usable DLEQ data fails closed — see `PROTOCOL.md` §1 and reason code `REFUSE_MISSING_BLINDING_FACTOR`.

## Trust boundaries & limitations

Read [`docs/trust-boundaries.md`](docs/trust-boundaries.md) before trusting an `ACCEPT_VERIFIED`. In short: the mint remains a custodian; the live reserve is Signet test-network capital, not mainnet capital; liability semantics follow a draft Cashu proposal, not a finalized NUT; and this is an early-stage verifier, not a production wallet.

**Real Cashu foundation (separate from the verifier above):** [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the two pieces relate), [`docs/REALITY-MAP.md`](docs/REALITY-MAP.md) (exact real/simulated table), [`docs/real-cashu-stack.md`](docs/real-cashu-stack.md) (topology), [`docs/reproduce-real-stack.md`](docs/reproduce-real-stack.md) (run it yourself), [`docs/dependencies.md`](docs/dependencies.md) (exact pinned versions), [`docs/limitations.md`](docs/limitations.md) (explicit gaps).

## Deployment

```text
visitor ──► Vercel: https://solvent-ashen.vercel.app/   canonical frontend (static build from main)
               │  (GitHub Pages mirror: https://theweirddee.github.io/solvent/)
               ▼
            Railway: one service (railway.toml -> deploy/railway/Dockerfile), volume /data
               ├── mint      https://solvent-production-2029.up.railway.app   patched cdk-mintd, fakewallet
               └── evidence  https://solvent-production-9c92.up.railway.app   SOLVENT sidecar
               ▼
            public Nostr relays + Mutinynet reserve
```

- **Frontend — Vercel (canonical).** Vercel builds `npm run build` from every push to `main`. `.env.production` points `#/mint` at the Railway mint and evidence service by default. `#/mint?mint=&evidence=` still overrides them.
- **Backend — Railway.** The mint and the SOLVENT sidecar run in one service, sharing one SQLite file on one volume ([`docs/DEPLOY-RAILWAY.md`](docs/DEPLOY-RAILWAY.md)). Railway rebuilds on pushes that touch its watch paths. Live-mint evidence is fetched from Railway at run time, so it never needs a frontend redeploy.
- **Reference evidence refresh.** *Re-check published evidence* uses `evidence/nostr/live-demo.json`, bundled into the static build. Its reserve attestation stays fresh for about 7 days. `.github/workflows/refresh-live-demo.yml` regenerates and republishes it twice a day, fails closed through `verify:live-demo`, tests, attacks and `verify:submission`, and then commits the one file to `main`. That redeploys Vercel, and the `live-evidence` artifact redeploys the GitHub Pages mirror.
- **GitHub Pages (secondary mirror).** `.github/workflows/deploy-site.yml` deploys the same build to Pages, smoke-tests it (`verify:deployed`, `verify:ui:browser`), and runs a strict live-acceptance job.
- **Deploy Stack Check** builds and runs both the Compose stack and the Railway image in CI. It drives the real browser flows, restarts the Railway image to prove its state persists, and checks its start guards.

**Manual fallback:** run `npm run live-demo`, commit `evidence/nostr/live-demo.json`, and push. Then `npm run verify:public-app` checks the exact public app end to end.

## Testing

```bash
npm test
```

380+ tests across the epoch lifecycle, the mint-identity delegation, Phase 3B public evidence, NUT-05 melt accounting and the SOLVENT sidecar (all on the real CDK schema), NUT-12/DLEQ (official vectors + mutation attacks), the sum-MMR and epoch manifest (official PR #388 vectors), signed PoL receipts, the hero omission contradiction, the central `verify()` decision rule, Gate 4's real acceptance-boundary spy tests, Gate 5's real Nostr evidence evaluation (signature/freshness/conflict/mismatch), Gate 6's real reserve attestation evaluation, the fail-closed submission verifier's own logic, and a jsdom test driving the real v2 web UI (landing page, all three verifier scenarios, Gate 4 enforcement, and the evidence pipeline / protocol pages).

## Tech stack

TypeScript, Node 24, Vite (vanilla TS, no framework), Vitest, `@cashu/cashu-ts` for Cashu parsing/crypto, `nostr-tools` for Nostr, `@noble/hashes`/`@noble/curves` for hashing/secp256k1 primitives, `@scure/btc-signer` for Taproot address derivation and BIP-341 key tweaking.

## Future work

Real (non-fakewallet) Lightning on the public mint; multi-keyset epoch aggregation; a remote-signatory RPC for the mint-identity delegation; a second, fully live Signet reserve funding path without a human-solved faucet step; the remaining PR #388 fraud-challenge types (`append_only_violation`, `sum_mmr_consistency_violation`, keyset-lifecycle enforcement); OpenTimestamps anchoring; and wallet integrations that call `verify()` as a real accept gate outside this demo client. Full list in `docs/draft-alignment.md`.
