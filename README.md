# SOLVENT

**BOSS Battle 2026 — Freedom Stack (Nostr + Ecash)**
**Problem:** Auditable Ecash — mint proof-of-reserves and proof-of-liabilities
**Team:** _(add your name(s) here)_
**License:** MIT

**Public site:** https://theweirddee.github.io/solvent/
**Demo video:** _(add link here before submission)_ — the script is [`docs/DEMO-RUNBOOK.md`](docs/DEMO-RUNBOOK.md)

> The mint made a promise. Did it keep it? SOLVENT checks a Cashu mint's signed Proof-of-Liabilities receipt against the mint's own closed accounting epoch, public Nostr evidence and a live Bitcoin reserve — before the ecash is accepted.

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
| **Public site** | https://theweirddee.github.io/solvent/. `#/verify` runs the Live Public Demo (a real published reference case, re-checked against live relays and the live reserve). `#/mint` is the real-mint flow |
| **Real mint, locally** | Start a patched `cdk-mintd` and the sidecar ([`docs/DEPLOY-REAL-MINT.md`](docs/DEPLOY-REAL-MINT.md); `deploy/docker-compose.yml`), then open `#/mint?mint=<mint URL>&evidence=<sidecar URL>`. Click **Get ecash and verify it** (ACCEPT), then **make the mint break its promise** (REFUSE) |
| **One-command checks** | `npm run verify:submission` (mechanism, attack corpus, live reference case); `npm run verify:phase3b-evidence -- evidence/real-pol/phase3b-local-fakewallet` (offline replay of a real public-evidence run) |
| **Real-mint browser E2E** | `npm run verify:real-mint:browser -- <site> <mint URL> <sidecar URL>` |

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

**Demo- or deployment-specific:**

- The public site's Live Public Demo is a published *reference* case, re-checked live on every run.
- A public interactive mint may use CDK **fakewallet** Lightning, where invoices settle by themselves. It is always labelled so, in the UI and in the evidence. It is never called real Lightning.
- The network is a **test network** (Mutinynet / Bitcoin Signet), not Bitcoin mainnet.

**Limitations:**

- Custodial Cashu trust remains. SOLVENT makes the mint's accounting checkable; it does not remove the custodian.
- Multi-keyset epochs are refused (`REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE`), not aggregated.
- A remote (gRPC) signatory cannot sign the mint-identity delegation, so it fails closed.
- Public relay availability matters. When evidence can't be fetched, SOLVENT refuses (`REFUSE_NOSTR_EVENT_NOT_FOUND` or `…_UNAVAILABLE`).
- There is no persistent public host for the real mint in this repository. The deployment is packaged and CI-tested (`deploy/`), but running it needs a host.

The complete line-by-line table is in [`docs/REALITY-MAP.md`](docs/REALITY-MAP.md), and the decision history in [`DECISIONS.md`](DECISIONS.md).

## Evidence

| Milestone | CI run (Real Cashu + SOLVENT Integration, real LND) | Offline check |
| --- | --- | --- |
| NUT-03 swap accounting | [36150315347](https://github.com/TheWeirdDee/solvent/actions/runs/36150315347) | `npm run verify:nut03-evidence -- 36150315347` |
| Epoch lifecycle (Phase 3A) and public solvency evidence (Phase 3B) | [36614823173](https://github.com/TheWeirdDee/solvent/actions/runs/36614823173): honest `ACCEPT_VERIFIED`, broken promise `REFUSE_ISSUANCE_OMITTED` | `npm run verify:phase3b-evidence -- <artifact>/evidence/real-pol/36614823173-phase3b` |
| NUT-05 melt accounting, plus all of the above again | [36619816959](https://github.com/TheWeirdDee/solvent/actions/runs/36619816959) | `nut05-melt.json` in the run artifact |

Each run's `real-cashu-evidence` artifact holds the machine-readable JSON. It is secret-scanned before upload, and every holder proof it contains is spent before the run ends.

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

- **`/`** — the broken-promise story in plain language.
- **`/mint`** — the real-mint flow: get ecash from a patched CDK mint, see its signed promise, wait for the epoch, verify. It can also run the real broken-promise demo.
- **`/verify`** — the Live Public Demo (a real published reference case, re-checked live), plus manual bundle verification.
- **`/publish`** — the real mint-operator evidence pipeline.
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
npm run live-demo         # generates + publishes the reference case used by /verify's Live check and "Load live example"
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
  - **Live check** — runs SOLVENT against the published reference case (`evidence/nostr/live-demo.json`, published by `npm run live-demo`). Every run re-fetches its Nostr event from real public relays and re-queries its reserve UTXO on Bitcoin Signet (Mutinynet), then runs the real verifier. It shows when the case was published and when its evidence expires, "Last checked", Nostr LIVE / NOT FOUND / UNAVAILABLE, Reserve LIVE / SPENT / UNAVAILABLE, and the exact event id and reserve txid:vout it checked. Nothing is substituted from bundled data when a request fails — the result is a REFUSE naming what couldn't be checked.
  - **Verify evidence** — paste or upload a SOLVENT verification bundle, or click **Load live example** to load the same published reference case. See `docs/verification-bundle.md` for the schema. A plain Cashu token, or a bundle with no liability evidence, is refused as **UNSUPPORTED MINT**.

  Both modes run the same nine checks (token format, mint origin / NUT-12, PoL receipt, promised epoch, signed epoch manifest, liability inclusion, public Nostr retrieval, live reserve, decision). The result always leads with the decision (**ACCEPT** or **REFUSE**) and its reason; partial facts such as "local cryptography: valid" sit beneath it. **Accept ecash** is wired to the real Gate 4 acceptance boundary (enabled only on `ACCEPT_VERIFIED`, called exactly once). Raw JSON lives behind collapsed "View raw bundle" / "View result JSON" toggles.
- **Protocol** (`/protocol`), **Docs** (`/docs`), and a read-only **evidence pipeline** view (`/publish`).
- **Reference mint lab** (`#/lab`, developers only — linked from the footer, not the navigation) — SOLVENT's reference mint running in the browser, with one persistent identity and keyset (until explicitly rotated), a new proof, receipt and closed epoch per issuance, and a choice of amounts. Its evidence is never published, so its primary action is **Check local cryptography**; a full verification of lab evidence refuses with PUBLIC EVIDENCE NOT FOUND. It can also break a promise on purpose (BROKEN PROMISE) or issue past the reserve (RESERVE SHORTFALL).

The real CDK mint integration (NUT-04 / NUT-03 accounting, proven in CI) is not the backend behind this web page — see `docs/trust-boundaries.md`'s "Product, reference lab, and the real CDK integration".

### The two-tier Nostr guarantee

SOLVENT's whole premise is that a mint's accounting is *publicly checkable*, not just privately signable — so a bundle's own privately-supplied signed Nostr event, however cryptographically valid, does **not** by itself satisfy the live acceptance gate. `verifySubmission()` (`src/app/submission.ts`) always genuinely attempts to fetch the bundle's evidence from real public relays; only a bundle whose evidence a relay actually returns can reach `ACCEPT_VERIFIED`. That is why locally generated lab evidence (intentionally never published — publishing a throwaway event on every click would spam production relays) cannot reach ACCEPT, while the published reference case can. See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee".

"Couldn't find it" and "couldn't check" are never collapsed into one reason: a relay that answers but doesn't have the event yields `REFUSE_NOSTR_EVENT_NOT_FOUND` (REFUSE / "PUBLIC EVIDENCE NOT FOUND"), while every relay being unreachable yields `REFUSE_NOSTR_UNAVAILABLE` (REFUSE / "PUBLIC EVIDENCE UNAVAILABLE"). One bounded retry absorbs transient relay misses without ever masking a genuinely unpublished event — see "Bounded relay-fetch retry" in the same doc.

The reference case has a real, finite shelf life — its *reserve* attestation (~7 days on Mutinynet), not its Nostr event, is the binding freshness constraint (see `docs/trust-boundaries.md`'s "Effective expiry"). `npm run verify:submission`'s "Canonical Live Public Demo" line is a real, right-now check of it — `SUBMISSION READY` is impossible while it's failing. See "Deployment" below for how it is kept fresh.

Honest notes:

- The built-in reserve is Bitcoin Signet (Mutinynet) **test-network capital**, not mainnet capital.
- Random external Cashu mints are **not** supported — only mints that publish the exact evidence chain `verify()` needs. See the FAQ.

## Refusal cases

| Case | Expected result |
| --- | --- |
| Published reference case — issuance included, public Nostr evidence retrieved live, reserve covers it | **ACCEPT VERIFIED** (Live check) |
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

**Provider:** GitHub Pages (project site), via the repo's own `pages: write`/`id-token: write` permissions — no third-party account or repository secret required. Enabled with build source "GitHub Actions". Public URL: `https://<owner>.github.io/<repo>/` (see the repo's Pages settings for the exact current value).

**Two workflows, deliberately separate** — a relay outage must never take the site offline:

- **`.github/workflows/deploy-site.yml` (Deploy Site)** — on every push to main, on demand, and after each successful refresh. Builds and deploys the static site with the newest *already-verified* live evidence (the committed file, or a newer copy from the latest successful refresh run — checked offline only, see `src/cli/select-live-evidence.ts`), then smoke-tests the deployed site (`verify:deployed`, and `verify:ui:browser`, which passes whether the live evidence is healthy or not). A separate `live-acceptance` job then runs `verify:deployed:browser`, which fails when the deployed live check is not ACCEPT right now — a signal to refresh, never a reason to take the site down.
- **`.github/workflows/refresh-live-demo.yml` (Refresh Live Evidence)** — twice a day and on demand. Regenerates and publishes the reference case (up to three publish attempts), then `verify:live-demo` → `npm test` → `npm run attacks` → `verify:submission`, failing closed at every step. Only on success does it upload the evidence as the `live-evidence` artifact, which triggers a deploy. It never deploys by itself.

```
Refresh Live Evidence:  live-demo (publish) -> verify:live-demo -> test -> attacks -> verify:submission -> upload artifact
Deploy Site:            select newest verified evidence (offline) -> test -> build -> deploy -> verify:deployed -> verify:ui:browser
                        live-acceptance (separate job): verify:deployed:browser (strict ACCEPT)
```

Freshness window ~7 days (network-aware — see `docs/trust-boundaries.md`'s "Effective expiry"). If the refresh keeps failing, the deployed live check reports the evidence's real state (LIVE EVIDENCE EXPIRED / PUBLIC EVIDENCE UNAVAILABLE) — nothing is faked. Both workflows pass on GitHub: a manual Refresh Live Evidence run ([36620157568](https://github.com/TheWeirdDee/solvent/actions/runs/36620157568)) triggered a Deploy Site run ([36620304510](https://github.com/TheWeirdDee/solvent/actions/runs/36620304510)) whose deployed bundle, 51/51 browser smoke test and strict live check (ACCEPT VERIFIED in a real browser) all passed.

**Real mint hosting** is separate from the static site: see [`docs/DEPLOY-REAL-MINT.md`](docs/DEPLOY-REAL-MINT.md). The Deploy Stack Check workflow builds and runs that stack in CI.

**Manual fallback:** run `npm run live-demo` locally, commit `evidence/nostr/live-demo.json`, and push — Deploy Site deploys it. Then `npm run verify:deployed -- <url>` and `npm run verify:deployed:browser -- <url>` confirm the deployed site picked it up.

## Testing

```bash
npm test
```

380+ tests across the epoch lifecycle, the mint-identity delegation, Phase 3B public evidence, NUT-05 melt accounting and the SOLVENT sidecar (all on the real CDK schema), NUT-12/DLEQ (official vectors + mutation attacks), the sum-MMR and epoch manifest (official PR #388 vectors), signed PoL receipts, the hero omission contradiction, the central `verify()` decision rule, Gate 4's real acceptance-boundary spy tests, Gate 5's real Nostr evidence evaluation (signature/freshness/conflict/mismatch), Gate 6's real reserve attestation evaluation, the fail-closed submission verifier's own logic, and a jsdom test driving the real v2 web UI (landing page, all three verifier scenarios, Gate 4 enforcement, and the evidence pipeline / protocol pages).

## Tech stack

TypeScript, Node 24, Vite (vanilla TS, no framework), Vitest, `@cashu/cashu-ts` for Cashu parsing/crypto, `nostr-tools` for Nostr, `@noble/hashes`/`@noble/curves` for hashing/secp256k1 primitives, `@scure/btc-signer` for Taproot address derivation and BIP-341 key tweaking.

## Future work

A persistent public host for the real mint (packaged in `deploy/`); multi-keyset epoch aggregation; a remote-signatory RPC for the mint-identity delegation; a second, fully live Signet reserve funding path without a human-solved faucet step; the remaining PR #388 fraud-challenge types (`append_only_violation`, `sum_mmr_consistency_violation`, keyset-lifecycle enforcement); OpenTimestamps anchoring; and wallet integrations that call `verify()` as a real accept gate outside this demo client. Full list in `docs/draft-alignment.md`.
