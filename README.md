# SOLVENT

**BOSS Battle 2026 â€” Freedom Stack (Nostr + Ecash)**
**Problem:** Auditable Ecash â€” mint proof-of-reserves and proof-of-liabilities
**Team:** _(add your name(s) here)_
**License:** MIT

**Demo video:** _(add link here before submission)_

> The mint made a promise. Did it keep it? SOLVENT checks a Cashu mint's signed Proof-of-Liabilities receipt against its closed accounting epoch, public Nostr state, and a real Bitcoin Signet reserve â€” before the ecash reaches a real acceptance side effect.

The product is the protocol, aligned to Cashu PR #388 / the draft Proof-of-Liabilities proposal: real NUT-12 DLEQ verification, a holder-reconstructed `B'` bound to a signed transactional receipt, an append-only sum-MMR epoch commitment, real Nostr publication of that evidence, and a real Bitcoin Signet UTXO independently re-verified on chain. The web UI is a thin client over `src/verifier/verify.ts` â€” it never decides ACCEPT/REFUSE itself.

## PHASE 1 REAL CASHU FOUNDATION

This is a **phase, not a finished system** â€” the verifier above and the real Cashu foundation below currently run side by side, not yet connected. See `docs/REALITY-MAP.md` for the full real/simulated breakdown and `DECISIONS.md` for why.

**Verified this phase** (`src/cli/real-cashu/`, `.github/workflows/real-cashu-integration.yml` â€” see `docs/real-cashu-stack.md`), confirmed by real execution in [GitHub Actions run 35853398175](https://github.com/TheWeirdDee/solvent/actions/runs/35853398175) (2026-09-23):
- a real, independent, external Cashu mint (**CDK**, not SOLVENT's own code)
- a real regtest Lightning payment, settled by a separate real node and independently confirmed
- real NUT-04 issuance, real NUT-03 swap, real NUT-07 proof-state transitions, real NUT-05 melt
- real double-spend rejection by the mint's own state, not a client-side check
- real process-restart persistence: after killing and restarting the mint against the same on-disk database, already-spent proofs still report SPENT and a fresh double-spend attempt is still refused

**Not yet connected in this phase**:
- persistent accounting epochs tied to real mint activity — **Phase 3A built**: the patched CDK mint now stamps real epochs, and `npm run pol:epoch-close` closes them into signed sum-MMR manifests derived from the mint's own database. Verified against a real local `cdk-mintd` (fakewallet Lightning); the LND-backed CI run has not happened yet. See [`docs/epoch-lifecycle.md`](docs/epoch-lifecycle.md)
- Nostr publication sourced from real mint state
- reserve binding to a real mint's real liabilities
- SOLVENT's verifier gating a real receiver's swap

Everything described in the rest of this README (the verifier, the attack corpus, the Live Public Demo, the deployment automation) is real, unchanged, and already documented in detail below and in `docs/trust-boundaries.md` â€” Phase 1 adds to it, it does not replace or weaken any of it.

## PHASE 2 MINT-NATIVE ACCOUNTING + DURABLE PoL RECEIPTS (NUT-04 STEP 8 VERIFIED Â· NUT-03 VERIFIED Â· NUT-05 NOT STARTED)

Phase 2's goal: couple SOLVENT's own accounting durably to CDK's real economic transitions, inside the mint's real database transaction; sign real Proof-of-Liability receipts with the mint's real amount key; and prove the receipt obligation survives a real crash and is genuinely retrievable â€” not a sidecar that could lose it, not a fixture signature, not merely "synchronous, so probably fine." See `docs/cdk-integration-seams.md`, `docs/cdk-signatory-audit.md`, `docs/receipt-lifecycle.md`, `docs/accounting-model.md`, and `DECISIONS.md`'s Phase 2 entries for the full architecture.

**Verified this phase**, confirmed by real execution across [run 35924475422](https://github.com/TheWeirdDee/solvent/actions/runs/35924475422), [run 35961052740](https://github.com/TheWeirdDee/solvent/actions/runs/35961052740), and [run 35962153613](https://github.com/TheWeirdDee/solvent/actions/runs/35962153613) (2026-09-23/24):
- a real NUT-04 mint's issued outputs create durable SOLVENT accounting records automatically, via SQL triggers firing inside CDK's own transaction â€” **no CDK fork or patch needed for this part**
- **a real, mint-native PoL receipt is signed for every real output**, using the mint's real per-amount signatory key, via five small, real, checked-in patches to CDK's own source (`patches/cdk/0001`-`0005`; `cdk-mintd` is built from the pinned upstream commit plus this patch series in CI, not downloaded prebuilt, for this specific capability)
- **independent verification, with zero signatory access**: 6/6 real receipt signatures verified against the mint's own public `/v1/keys` response, and 4/4 deliberately tampered receipts correctly refused
- **real receipt recovery**: a startup scan finds any receipt left `pending`, signs it through the real signatory, and verifies it locally before persisting â€” proven against 3 synthetic pending receipts seeded directly into the real database, recovered by a real mint restart, and unchanged (no duplicates) after a second real restart
- **a genuine `kill -9`, not a simulation**: a real background Lightning-paid mint attempt was interrupted mid-transaction by an actual process termination; row counts were identical before and after, proving the interrupted transaction â€” receipt state included â€” left nothing behind
- **real receipt delivery**: `GET /v1/solvent/pol-receipt/{blinded_message}`, a real retrieval endpoint, proven end to end by a minimal real wallet path â€” 6 Cashu proofs received, 6 receipts retrieved, 6/6 independently verified â€” a named extension beyond the pinned draft's inline-response requirement, not silently substituted for it
- **direct, real negative tests of the signing capability itself** (`cargo test`, not HTTP-simulated, since it has no HTTP route): refuses a nonexistent keyset, an out-of-range amount, and an expired keyset â€” 4/4 real tests pass
- real atomicity, real reconciliation, real retry idempotency, real restart persistence â€” all unchanged and still passing

**NUT-03 (swap) â€” NUT-03 VERIFIED. Real NUT-03 swap accounting is now backed by machine-readable CI evidence.** A real patch (`patches/cdk/0006-*.patch`) wires consumed-liability, replacement issued-liability, and PoL receipt signing into CDK's real `SwapSaga::finalize()` transaction, reusing the existing NUT-04 issued-liability trigger and adding a new consumed-liability trigger (`migrations/solvent-accounting/0002_*.sql`).

Verified by [CI run 36150315347](https://github.com/TheWeirdDee/solvent/actions/runs/36150315347) on commit `4a802bc444fb6b0d3f31032336af19129950508b`. Result: SUCCESS.
- **Evidence contract:** 15/15 required NUT-03 JSON files produced, in `evidence/real-pol/36150315347/` inside the run's `real-cashu-evidence` artifact.
- **Evidence verifier:** `npm run verify:nut03-evidence -- 36150315347` ran 165 checks, 0 failed, exit code 0.
- **Regression at that commit:** 285/285 tests, build PASS, 25/25 attacks.

The evidence covers:
- a real swap;
- a real failed swap and double-spend after swap;
- a genuine `kill -9` inside `finalize()`, before commit;
- NUT-09 `POST /v1/restore` recovery after a lost response;
- swap accounting persisting across a real restart, plus a real swap afterwards;
- two consecutive swaps with outstanding liability unchanged.

An earlier run ([36008787769](https://github.com/TheWeirdDee/solvent/actions/runs/36008787769)) passed the same scenarios but recorded them only in CI step logs. Not covered: a keyset-rotation swap test, which was deferred and has not been run. See `docs/receipt-lifecycle.md`'s NUT-03 section for the architecture, and `DECISIONS.md`'s 2026-09-25 entry for the evidence correction.

**Not yet built**: NUT-05 (melt) accounting â€” Phase 2's explicit build-order instruction is NUT-04, then NUT-03, then NUT-05, one milestone reviewed at a time.

## Why SOLVENT exists

A Cashu mint's own signed receipt can promise to count a specific issuance in a specific accounting epoch â€” and the mint can still close that epoch without it, while everything else about the epoch (its own manifest signature, its own reserve) looks perfectly healthy:

```
Mint signs:    "I will count this 70,000-sat issuance in epoch 12."
Epoch 12 closes, signed, internally consistent.
Reserve:       1,000,000 sats, real, unspent, independently verified.

BUT: the 70,000-sat issuance never appears in epoch 12's signed accounting.
```

A reserve-ratio dashboard cannot catch this â€” the ratio is computed from whatever the mint chooses to report, and the mint's own accounting can be internally consistent while still omitting a specific promised issuance. SOLVENT catches it because the holder independently reconstructs their exact issuance from their own Cashu proof (never a mint-supplied identifier) and checks it against the epoch the mint itself signed and closed â€” refusing the ecash even when the mint's reserve is comfortably healthy.

## Routes / surfaces

Hash-routed single page (`npm run dev`, no server-side routing needed):

- **`/` â€” Landing.** The broken-promise story in plain language, the four-check decision gate, real acceptance enforcement, real Nostr evidence, the real live Bitcoin Signet reserve, the 25-case attack corpus, and an honest-limits section.
- **`/verify` â€” Verifier.** Pick one of three scenarios (honest issuance / promised issuance omitted / reserve below liabilities); each runs the real v2 protocol live in the browser through the real `verify()` function, then a real Gate 4 acceptance boundary.
- **`/publish` â€” Evidence pipeline.** A read-only view of the real mint-operator pipeline (receipt â†’ close epoch â†’ sum-MMR â†’ sign manifest â†’ bind reserve â†’ publish Nostr), showing the real last-captured evidence from this repository's own `evidence/` directory â€” not a simulated publish button.
- **`/protocol` â€” Protocol.** The nine-stage decision chain `verify()` runs, gate by gate.

## What is genuinely working

- **Real NUT-12 DLEQ verification** and holder-side `B'`/`C'` reconstruction through `@cashu/cashu-ts`'s real primitives, over a real `getEncodedToken`/`getDecodedToken` transfer round trip.
- **Real signed transactional Proof-of-Liabilities receipts** â€” BIP-340 Schnorr, byte-exact to the Cashu PR #388 draft, cross-checked against its official test vectors.
- **A real append-only sum-MMR** for issued/spent accounting per keyset, and a real signed epoch manifest, both byte-exact to the draft and validated against its official vectors.
- **The hero omission contradiction**: a real mint signs a real receipt promising a real, holder-reconstructed issuance in a real signed epoch, and genuinely fails to produce inclusion for it.
- **Real acceptance enforcement**: a spy-tested boundary proving a real accept function is called exactly once on `ACCEPT_VERIFIED` and zero times on every required refusal.
- **Real Nostr v2 evidence**: a real BIP-340-signed kind-8181 event, published to and independently fetched back from public relays, with real conflict/stale/digest-mismatch detection.
- **A real, live Bitcoin Signet reserve**: a real Taproot address, a real funded UTXO (via Mutinynet), dual BIP-340 signatures, and independent re-verification against a public block explorer.
- **25/25 of the PRD's adversarial attack battery**, each constructing real adversarial state and running it through the real decision code.
- **203+ automated tests**, a passing production build, and a fail-closed submission verifier (`npm run verify:submission`).

## What is fixture / not yet real

- **The Cashu mint is a controlled fixture.** It performs real cryptography (real keys, real blind signing, real DLEQ, real receipt/manifest signing) but its issuance and epoch records are constructed for the demo, which is what makes the omission scenario repeatable.
- **The Bitcoin reserve is Signet (Mutinynet) test-network capital**, not mainnet capital â€” real, independently verifiable, but valueless coins.
- **This is a Phase 1 verifier and acceptance-boundary instrument, not a production wallet.** Gate 4's "acceptance" is a real, spy-tested state mutation (real token serialization + a committed local record), not a live mint-swap HTTP round trip.
- **Liability semantics follow a draft Cashu proposal** (PR #388), not a finalized NUT.

See `docs/trust-boundaries.md` for the complete, current list of what's real vs. not, and `DECISIONS.md` for the full history.

## What SOLVENT supports

**Supported:** SOLVENT-compatible evidence bundles â€” a signed PoL receipt, a signed closed epoch manifest, an inclusion proof (or an honest `null`), a signed reserve attestation, and a signed Nostr evidence event, in the exact structure `src/app/submission.ts`'s `SubmissionBundle` defines (see `docs/verification-bundle.md`). A SOLVENT-compatible mint exports it with the ecash; **Load live example** on /verify loads the published reference case, and the developer reference mint lab (`#/lab`) generates local ones â€” you never hand-construct it.

**Not automatically supported:** arbitrary Cashu tokens or mints that don't publish this evidence chain. Pasting a plain Cashu token, or a bundle from a mint that doesn't produce signed PoL receipts/manifests/reserve attestations/Nostr evidence, is reported as **UNSUPPORTED MINT** or **INCOMPLETE BUNDLE** â€” SOLVENT fails closed rather than guessing at partial support.

## Quick start (clean machine)

```bash
git clone <this-repo>
cd solvent
npm install
npm test                    # 200+ tests
npm run build                # typecheck + production bundle
npm run verify:submission    # the 5-minute judge verifier â€” see VERIFY_IN_5_MINUTES.md
npm run verify:cashu-real    # PHASE 1: real CDK mint + real regtest Lightning lifecycle â€” see docs/real-cashu-stack.md (requires the stack from docs/reproduce-real-stack.md or .github/workflows/real-cashu-integration.yml; not runnable standalone)
```

### CLI â€” regenerate evidence

```bash
npm run gate0     # NUT-12 transfer invariant
npm run gate1     # signed PoL receipt
npm run gate2     # signed epoch + hero omission contradiction
npm run gate4     # real acceptance side effect
npm run gate5     # real Nostr publish/fetch against public relays
npm run gate6     # real Signet reserve attestation
npm run attacks   # the full 25-case attack corpus
npm run live-demo         # generates + publishes the reference case used by /verify's Live check and "Load live example"
npm run live-demo:release # live-demo + build in one step â€” the evidence is bundled at build time, so a rebuild is required for a deployed site to see it
npm run verify:live-demo  # independently re-verifies the Live Public Demo is still live + fresh right now (real relay fetch, real Esplora query, network-aware exact expiry)
npm run verify:deployed -- <url>         # confirms a DEPLOYED build (not just local dist/) is serving the current canonical evidence, via a real fetch
npm run verify:deployed:browser -- <url> # confirms a DEPLOYED build's live check reaches a real ACCEPT VERIFIED in headless Chromium
npm run verify:ui:browser -- <url>       # real-browser UI check: routes, 1440/1024/768/390 overflow, sticky docs sidebar, live check, lab
```

Every command re-runs real cryptography (and, for `gate5`/`gate6`/`live-demo`/`verify:live-demo`, real network I/O) and writes machine-readable evidence under `evidence/`. See `VERIFY_IN_5_MINUTES.md`.

`npm test` never touches the network â€” every real Esplora/Nostr-relay call is mocked, so it's deterministic regardless of internet availability. The commands above (and `npm run verify:submission`, which runs the CLI mechanism checks plus these live evidence files) are the separate, real-network gate â€” see `VERIFY_IN_5_MINUTES.md` for exactly how `verify:submission` reports live-evidence lines distinctly from mechanism/logic lines.

### Web UI

```bash
npm run dev
```

Opens on the landing page (`/`): the problem (a valid Cashu token doesn't prove the mint counted what it owes), the solution, who it's for, and the broken-promise story. It links into:

- **Verify** (`/verify`) â€” two modes:
  - **Live check** â€” runs SOLVENT against the published reference case (`evidence/nostr/live-demo.json`, published by `npm run live-demo`). Every run re-fetches its Nostr event from real public relays and re-queries its reserve UTXO on Bitcoin Signet (Mutinynet), then runs the real verifier. It shows when the case was published and when its evidence expires, "Last checked", Nostr LIVE / NOT FOUND / UNAVAILABLE, Reserve LIVE / SPENT / UNAVAILABLE, and the exact event id and reserve txid:vout it checked. Nothing is substituted from bundled data when a request fails â€” the result is a REFUSE naming what couldn't be checked.
  - **Verify evidence** â€” paste or upload a SOLVENT verification bundle, or click **Load live example** to load the same published reference case. See `docs/verification-bundle.md` for the schema. A plain Cashu token, or a bundle with no liability evidence, is refused as **UNSUPPORTED MINT**.

  Both modes run the same nine checks (token format, mint origin / NUT-12, PoL receipt, promised epoch, signed epoch manifest, liability inclusion, public Nostr retrieval, live reserve, decision). The result always leads with the decision (**ACCEPT** or **REFUSE**) and its reason; partial facts such as "local cryptography: valid" sit beneath it. **Accept ecash** is wired to the real Gate 4 acceptance boundary (enabled only on `ACCEPT_VERIFIED`, called exactly once). Raw JSON lives behind collapsed "View raw bundle" / "View result JSON" toggles.
- **Protocol** (`/protocol`), **Docs** (`/docs`), and a read-only **evidence pipeline** view (`/publish`).
- **Reference mint lab** (`#/lab`, developers only â€” linked from the footer, not the navigation) â€” SOLVENT's reference mint running in the browser, with one persistent identity and keyset (until explicitly rotated), a new proof, receipt and closed epoch per issuance, and a choice of amounts. Its evidence is never published, so its primary action is **Check local cryptography**; a full verification of lab evidence refuses with PUBLIC EVIDENCE NOT FOUND. It can also break a promise on purpose (BROKEN PROMISE) or issue past the reserve (RESERVE SHORTFALL).

The real CDK mint integration (NUT-04 / NUT-03 accounting, proven in CI) is not the backend behind this web page â€” see `docs/trust-boundaries.md`'s "Product, reference lab, and the real CDK integration".

### The two-tier Nostr guarantee

SOLVENT's whole premise is that a mint's accounting is *publicly checkable*, not just privately signable â€” so a bundle's own privately-supplied signed Nostr event, however cryptographically valid, does **not** by itself satisfy the live acceptance gate. `verifySubmission()` (`src/app/submission.ts`) always genuinely attempts to fetch the bundle's evidence from real public relays; only a bundle whose evidence a relay actually returns can reach `ACCEPT_VERIFIED`. That is why locally generated lab evidence (intentionally never published â€” publishing a throwaway event on every click would spam production relays) cannot reach ACCEPT, while the published reference case can. See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee".

"Couldn't find it" and "couldn't check" are never collapsed into one reason: a relay that answers but doesn't have the event yields `REFUSE_NOSTR_EVENT_NOT_FOUND` (REFUSE / "PUBLIC EVIDENCE NOT FOUND"), while every relay being unreachable yields `REFUSE_NOSTR_UNAVAILABLE` (REFUSE / "PUBLIC EVIDENCE UNAVAILABLE"). One bounded retry absorbs transient relay misses without ever masking a genuinely unpublished event â€” see "Bounded relay-fetch retry" in the same doc.

The reference case has a real, finite shelf life â€” its *reserve* attestation (~7 days on Mutinynet), not its Nostr event, is the binding freshness constraint (see `docs/trust-boundaries.md`'s "Effective expiry"). `npm run verify:submission`'s "Canonical Live Public Demo" line is a real, right-now check of it â€” `SUBMISSION READY` is impossible while it's failing. See "Deployment" below for how it is kept fresh.

Honest notes:

- The built-in reserve is Bitcoin Signet (Mutinynet) **test-network capital**, not mainnet capital.
- Random external Cashu mints are **not** supported â€” only mints that publish the exact evidence chain `verify()` needs. See the FAQ.

## Refusal cases

| Case | Expected result |
| --- | --- |
| Published reference case â€” issuance included, public Nostr evidence retrieved live, reserve covers it | **ACCEPT VERIFIED** (Live check) |
| BROKEN PROMISE â€” promised issuance omitted from the closed epoch | **REFUSE â€” `REFUSE_ISSUANCE_OMITTED`** (even though reserve is healthy) |
| RESERVE SHORTFALL â€” issuance correctly included, but reserve below liabilities | **REFUSE â€” `REFUSE_RESERVE_SHORT`** |
| Signed evidence that was never published | **REFUSE â€” `REFUSE_NOSTR_EVENT_NOT_FOUND`** |

BROKEN PROMISE is the point of the project: the mint really signed a receipt promising to count this issuance in this epoch (the receipt verifies, the issuance is real), but the epoch it closed and signed doesn't include it â€” while its live reserve is comfortably healthy. SOLVENT catches this because the holder independently reconstructs their own issuance and checks it against what the mint itself signed, not against a reported ratio.

See it on the landing page's live-computed example, in the reference mint lab (`#/lab`), or reproduce the same properties via `npm run attacks` (A01/A02/A23/A25) and their evidence under `evidence/attacks/`.

## Architecture

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
    app/                    the web client â€” router.ts, protocol-demo.ts (the one real
                             reference issuance/evidence builder behind the live check, the lab, and
                             Verify your evidence â€” see createTestEcash()/verifyEcash()/runScenario()),
                             submission.ts (SubmissionBundle: raw evidence only, plus
                             verifySubmission() â€” independently re-derives reserve/Nostr status via a
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

A presented proof MUST carry `dleq.e`, `dleq.s`, and `dleq.r` for SOLVENT to independently verify it. `r` is what lets a *receiver* (not just the original minting wallet) reconstruct `B'`/`C'` offline. A proof missing usable DLEQ data fails closed â€” see `PROTOCOL.md` Â§1 and reason code `REFUSE_MISSING_BLINDING_FACTOR`.

## Trust boundaries & limitations

Read [`docs/trust-boundaries.md`](docs/trust-boundaries.md) before trusting an `ACCEPT_VERIFIED`. In short: the mint remains a custodian; the live reserve is Signet test-network capital, not mainnet capital; liability semantics follow a draft Cashu proposal, not a finalized NUT; and this is an early-stage verifier, not a production wallet.

**Real Cashu foundation (separate from the verifier above):** [`ARCHITECTURE.md`](ARCHITECTURE.md) (how the two pieces relate), [`docs/REALITY-MAP.md`](docs/REALITY-MAP.md) (exact real/simulated table), [`docs/real-cashu-stack.md`](docs/real-cashu-stack.md) (topology), [`docs/reproduce-real-stack.md`](docs/reproduce-real-stack.md) (run it yourself), [`docs/dependencies.md`](docs/dependencies.md) (exact pinned versions), [`docs/limitations.md`](docs/limitations.md) (explicit gaps).

## Deployment

**Provider:** GitHub Pages (project site), via the repo's own `pages: write`/`id-token: write` permissions â€” no third-party account or repository secret required. Enabled with build source "GitHub Actions". Public URL: `https://<owner>.github.io/<repo>/` (see the repo's Pages settings for the exact current value).

**Two workflows, deliberately separate** â€” a relay outage must never take the site offline:

- **`.github/workflows/deploy-site.yml` (Deploy Site)** â€” on every push to main, on demand, and after each successful refresh. Builds and deploys the static site with the newest *already-verified* live evidence (the committed file, or a newer copy from the latest successful refresh run â€” checked offline only, see `src/cli/select-live-evidence.ts`), then smoke-tests the deployed site (`verify:deployed`, and `verify:ui:browser`, which passes whether the live evidence is healthy or not). A separate `live-acceptance` job then runs `verify:deployed:browser`, which fails when the deployed live check is not ACCEPT right now â€” a signal to refresh, never a reason to take the site down.
- **`.github/workflows/refresh-live-demo.yml` (Refresh Live Evidence)** â€” twice a day and on demand. Regenerates and publishes the reference case (up to three publish attempts), then `verify:live-demo` â†’ `npm test` â†’ `npm run attacks` â†’ `verify:submission`, failing closed at every step. Only on success does it upload the evidence as the `live-evidence` artifact, which triggers a deploy. It never deploys by itself.

```
Refresh Live Evidence:  live-demo (publish) -> verify:live-demo -> test -> attacks -> verify:submission -> upload artifact
Deploy Site:            select newest verified evidence (offline) -> test -> build -> deploy -> verify:deployed -> verify:ui:browser
                        live-acceptance (separate job): verify:deployed:browser (strict ACCEPT)
```

Freshness window ~7 days (network-aware â€” see `docs/trust-boundaries.md`'s "Effective expiry"). If the refresh keeps failing, the deployed live check reports the evidence's real state (LIVE EVIDENCE EXPIRED / PUBLIC EVIDENCE UNAVAILABLE) â€” nothing is faked. **Neither workflow has succeeded on GitHub yet**: this split is new and unpushed, and the previous combined workflow failed on every scheduled run.

**Manual fallback:** run `npm run live-demo` locally, commit `evidence/nostr/live-demo.json`, and push â€” Deploy Site deploys it. Then `npm run verify:deployed -- <url>` and `npm run verify:deployed:browser -- <url>` confirm the deployed site picked it up.

## Testing

```bash
npm test
```

200+ tests across NUT-12/DLEQ (official vectors + mutation attacks), the sum-MMR and epoch manifest (official PR #388 vectors), signed PoL receipts, the hero omission contradiction, the central `verify()` decision rule, Gate 4's real acceptance-boundary spy tests, Gate 5's real Nostr evidence evaluation (signature/freshness/conflict/mismatch), Gate 6's real reserve attestation evaluation, the fail-closed submission verifier's own logic, and a jsdom test driving the real v2 web UI (landing page, all three verifier scenarios, Gate 4 enforcement, and the evidence pipeline / protocol pages).

## Tech stack

TypeScript, Node 24, Vite (vanilla TS, no framework), Vitest, `@cashu/cashu-ts` for Cashu parsing/crypto, `nostr-tools` for Nostr, `@noble/hashes`/`@noble/curves` for hashing/secp256k1 primitives, `@scure/btc-signer` for Taproot address derivation and BIP-341 key tweaking.

## Future work

A second, fully live Signet reserve funding path without a human-solved faucet step; a real mint integration in place of the fixture mint; the remaining PR #388 fraud-challenge types (`append_only_violation`, `sum_mmr_consistency_violation`, keyset-lifecycle enforcement); OpenTimestamps anchoring; and wallet integrations that call `verify()` as a real accept gate outside this demo client. Full list in `docs/draft-alignment.md`.
