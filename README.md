# SOLVENT

**BOSS Battle 2026 — Freedom Stack (Nostr + Ecash)**
**Problem:** Auditable Ecash — mint proof-of-reserves and proof-of-liabilities
**Team:** _(add your name(s) here)_
**License:** MIT

**Demo video:** _(add link here before submission)_

> The mint made a promise. Did it keep it? SOLVENT checks a Cashu mint's signed Proof-of-Liabilities receipt against its closed accounting epoch, public Nostr state, and a real Bitcoin Signet reserve — before the ecash reaches a real acceptance side effect.

The product is the protocol, aligned to Cashu PR #388 / the draft Proof-of-Liabilities proposal: real NUT-12 DLEQ verification, a holder-reconstructed `B'` bound to a signed transactional receipt, an append-only sum-MMR epoch commitment, real Nostr publication of that evidence, and a real Bitcoin Signet UTXO independently re-verified on chain. The web UI is a thin client over `src/verifier/verify.ts` — it never decides ACCEPT/REFUSE itself.

## PHASE 1 REAL CASHU FOUNDATION

This is a **phase, not a finished system** — the verifier above and the real Cashu foundation below currently run side by side, not yet connected. See `docs/REALITY-MAP.md` for the full real/simulated breakdown and `DECISIONS.md` for why.

**Verified this phase** (`src/cli/real-cashu/`, `.github/workflows/real-cashu-integration.yml` — see `docs/real-cashu-stack.md`), confirmed by real execution in [GitHub Actions run 35853398175](https://github.com/TheWeirdDee/solvent/actions/runs/35853398175) (2026-09-23):
- a real, independent, external Cashu mint (**CDK**, not SOLVENT's own code)
- a real regtest Lightning payment, settled by a separate real node and independently confirmed
- real NUT-04 issuance, real NUT-03 swap, real NUT-07 proof-state transitions, real NUT-05 melt
- real double-spend rejection by the mint's own state, not a client-side check
- real process-restart persistence: after killing and restarting the mint against the same on-disk database, already-spent proofs still report SPENT and a fresh double-spend attempt is still refused

**Not yet connected in this phase**:
- SOLVENT's own Proof-of-Liabilities mint extension (signed receipts, epoch manifests, sum-MMR)
- persistent accounting epochs tied to real mint activity
- Nostr publication sourced from real mint state
- reserve binding to a real mint's real liabilities
- SOLVENT's verifier gating a real receiver's swap

Everything described in the rest of this README (the verifier, the attack corpus, the Live Public Demo, the deployment automation) is real, unchanged, and already documented in detail below and in `docs/trust-boundaries.md` — Phase 1 adds to it, it does not replace or weaken any of it.

## PHASE 2 MINT-NATIVE ACCOUNTING (in progress — NUT-04 only)

Phase 2's goal: couple SOLVENT's own accounting durably to CDK's real economic transitions, inside the mint's real database transaction — not a sidecar that could lose the obligation on a crash. See `docs/cdk-integration-seams.md`, `docs/accounting-model.md`, and `DECISIONS.md`'s Phase 2 entries for the full architecture (SQLite triggers on CDK's own unmodified database file — no CDK fork, no CDK patch, for this part).

**Verified this phase**, confirmed by real execution in [GitHub Actions run 35882242998](https://github.com/TheWeirdDee/solvent/actions/runs/35882242998) (2026-09-23):
- a real NUT-04 mint's issued outputs create durable SOLVENT accounting records automatically, via SQL triggers firing inside CDK's own transaction (`migrations/solvent-accounting/0001_nut04_issued_liability.sql`)
- real atomicity: a transaction that fails after the trigger fires but before commit leaves **both** the CDK row and the SOLVENT row absent; a real commit leaves both present
- real reconciliation: SOLVENT's journal (6 records, 1000 sats) exactly matches CDK's own real `blind_signature` table for the same operation, independently queried
- real retry idempotency: a genuine second mint attempt against an already-issued quote is rejected by the real mint (`Quote already issued`), so no duplicate accounting can be created
- real restart persistence: reconciliation reports byte-identical results before and after killing and restarting the real mint process

**STEP 8 PARTIAL — not yet verified**: mint-native PoL receipt *signing*. The real signing boundary has been audited (`docs/cdk-signatory-audit.md`) and the architecture decided (a minimal, real patch to CDK's `cdk-signatory` crate — `DECISIONS.md`'s Phase 2 Step 8C entry), but not yet implemented: no receipt is signed with the mint's real amount key yet, and `solvent_pol_receipt` rows stay `pending`. NUT-03 (swap) and NUT-05 (melt) accounting are not yet built either — Phase 2 deliberately did NUT-04 alone first.

## Why SOLVENT exists

A Cashu mint's own signed receipt can promise to count a specific issuance in a specific accounting epoch — and the mint can still close that epoch without it, while everything else about the epoch (its own manifest signature, its own reserve) looks perfectly healthy:

```
Mint signs:    "I will count this 70,000-sat issuance in epoch 12."
Epoch 12 closes, signed, internally consistent.
Reserve:       1,000,000 sats, real, unspent, independently verified.

BUT: the 70,000-sat issuance never appears in epoch 12's signed accounting.
```

A reserve-ratio dashboard cannot catch this — the ratio is computed from whatever the mint chooses to report, and the mint's own accounting can be internally consistent while still omitting a specific promised issuance. SOLVENT catches it because the holder independently reconstructs their exact issuance from their own Cashu proof (never a mint-supplied identifier) and checks it against the epoch the mint itself signed and closed — refusing the ecash even when the mint's reserve is comfortably healthy.

## Routes / surfaces

Hash-routed single page (`npm run dev`, no server-side routing needed):

- **`/` — Landing.** The broken-promise story in plain language, the four-check decision gate, real acceptance enforcement, real Nostr evidence, the real live Bitcoin Signet reserve, the 25-case attack corpus, and an honest-limits section.
- **`/verify` — Verifier.** Pick one of three scenarios (honest issuance / promised issuance omitted / reserve below liabilities); each runs the real v2 protocol live in the browser through the real `verify()` function, then a real Gate 4 acceptance boundary.
- **`/publish` — Evidence pipeline.** A read-only view of the real mint-operator pipeline (receipt → close epoch → sum-MMR → sign manifest → bind reserve → publish Nostr), showing the real last-captured evidence from this repository's own `evidence/` directory — not a simulated publish button.
- **`/protocol` — Protocol.** The nine-stage decision chain `verify()` runs, gate by gate.

## What is genuinely working

- **Real NUT-12 DLEQ verification** and holder-side `B'`/`C'` reconstruction through `@cashu/cashu-ts`'s real primitives, over a real `getEncodedToken`/`getDecodedToken` transfer round trip.
- **Real signed transactional Proof-of-Liabilities receipts** — BIP-340 Schnorr, byte-exact to the Cashu PR #388 draft, cross-checked against its official test vectors.
- **A real append-only sum-MMR** for issued/spent accounting per keyset, and a real signed epoch manifest, both byte-exact to the draft and validated against its official vectors.
- **The hero omission contradiction**: a real mint signs a real receipt promising a real, holder-reconstructed issuance in a real signed epoch, and genuinely fails to produce inclusion for it.
- **Real acceptance enforcement**: a spy-tested boundary proving a real accept function is called exactly once on `ACCEPT_VERIFIED` and zero times on every required refusal.
- **Real Nostr v2 evidence**: a real BIP-340-signed kind-8181 event, published to and independently fetched back from public relays, with real conflict/stale/digest-mismatch detection.
- **A real, live Bitcoin Signet reserve**: a real Taproot address, a real funded UTXO (via Mutinynet), dual BIP-340 signatures, and independent re-verification against a public block explorer.
- **25/25 of the PRD's adversarial attack battery**, each constructing real adversarial state and running it through the real decision code.
- **203+ automated tests**, a passing production build, and a fail-closed submission verifier (`npm run verify:submission`).

## What is fixture / not yet real

- **The Cashu mint is a controlled fixture.** It performs real cryptography (real keys, real blind signing, real DLEQ, real receipt/manifest signing) but its issuance and epoch records are constructed for the demo, which is what makes the omission scenario repeatable.
- **The Bitcoin reserve is Signet (Mutinynet) test-network capital**, not mainnet capital — real, independently verifiable, but valueless coins.
- **This is a Phase 1 verifier and acceptance-boundary instrument, not a production wallet.** Gate 4's "acceptance" is a real, spy-tested state mutation (real token serialization + a committed local record), not a live mint-swap HTTP round trip.
- **Liability semantics follow a draft Cashu proposal** (PR #388), not a finalized NUT.

See `docs/trust-boundaries.md` for the complete, current list of what's real vs. not, and `DECISIONS.md` for the full history.

## What SOLVENT supports

**Supported:** SOLVENT-compatible evidence bundles — a signed PoL receipt, a signed closed epoch manifest, an inclusion proof (or an honest `null`), a signed reserve attestation, and a signed Nostr evidence event, in the exact structure `src/app/submission.ts`'s `SubmissionBundle` defines (see `docs/verification-bundle.md`). SOLVENT's own test mint produces this automatically via **Create test ecash** — you never hand-construct it.

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
npm run live-demo         # generates + publishes the stable Live Public Demo evidence used by Try SOLVENT / "Load example bundle"
npm run live-demo:release # live-demo + build in one step — the evidence is bundled at build time, so a rebuild is required for a deployed site to see it
npm run verify:live-demo  # independently re-verifies the Live Public Demo is still live + fresh right now (real relay fetch, real Esplora query, network-aware exact expiry)
npm run verify:deployed -- <url>         # confirms a DEPLOYED build (not just local dist/) is serving the current canonical evidence, via a real fetch
npm run verify:deployed:browser -- <url> # confirms a DEPLOYED build reaches a real ACCEPT VERIFIED in an actual headless Chromium run
```

Every command re-runs real cryptography (and, for `gate5`/`gate6`/`live-demo`/`verify:live-demo`, real network I/O) and writes machine-readable evidence under `evidence/`. See `VERIFY_IN_5_MINUTES.md`.

`npm test` never touches the network — every real Esplora/Nostr-relay call is mocked, so it's deterministic regardless of internet availability. The commands above (and `npm run verify:submission`, which runs the CLI mechanism checks plus these live evidence files) are the separate, real-network gate — see `VERIFY_IN_5_MINUTES.md` for exactly how `verify:submission` reports live-evidence lines distinctly from mechanism/logic lines.

### Web UI

```bash
npm run dev
```

Opens on the landing page (`/`), which explains the broken-promise story and links into:

- **Verify** (`/verify`) — three modes:
  - **Try SOLVENT** — pick **LIVE PUBLIC DEMO**, **BROKEN PROMISE**, or **RESERVE SHORTFALL**, then click **Run verification**. LIVE PUBLIC DEMO loads SOLVENT's one genuinely, publicly-published evidence set (`npm run live-demo` — see below) and independently fetches it from real public Nostr relays every run; BROKEN PROMISE/RESERVE SHORTFALL mint a fresh identity each run. Every case does a real live re-query of the real Bitcoin Signet reserve UTXO, through the exact `verify()` function the CLI and tests use.
  - **Create test ecash** — the real, user-driven issuance journey: click **Create test ecash** to issue one real SOLVENT-compatible token with a brand-new identity, inspect/copy it and its exported verification bundle, then click **Verify this ecash**. Because this fresh evidence is never automatically published anywhere, verification correctly stops at "CRYPTOGRAPHIC CHECK PASSED" with a "PUBLICATION NOT FOUND" badge (`REFUSE_NOSTR_EVENT_NOT_FOUND` — relays were reachable, the event simply isn't there) rather than a full `ACCEPT_VERIFIED` — see "The two-tier Nostr guarantee" below.
  - **Verify your evidence** — paste a verification bundle (your own export from Create test ecash, or one from a compatible mint) and verify it directly, or click **Load example bundle** to load the same Live Public Demo bundle. See `docs/verification-bundle.md` for the exact schema and a complete real example.
  
  Every mode shows the nine-step decision chain, a large ACCEPT/REFUSE result, and an **Accept ecash** button wired to the real Gate 4 acceptance boundary (enabled only when the decision is `ACCEPT_VERIFIED`, and calling it exactly once). Technical detail (reconstructed `B'`, MMR roots, the real Nostr event, the real reserve UTXO, raw JSON) lives behind a **"View evidence"** panel.
- **Publish** (`/publish`) — a read-only view of the real evidence pipeline, showing the actual last-captured Nostr event and reserve attestation this repository generated.
- **Docs** (`/docs`) — real product documentation rendered from this repo's own markdown files.

### The two-tier Nostr guarantee

SOLVENT's whole premise is that a mint's accounting is *publicly checkable*, not just privately signable — so a bundle's own privately-supplied signed Nostr event, however cryptographically valid, does **not** by itself satisfy the live acceptance gate. `verifySubmission()` (`src/app/submission.ts`) always genuinely attempts to fetch the bundle's evidence from real public relays; only a bundle whose evidence a relay actually returns can reach `ACCEPT_VERIFIED`. This is why **Create Test Ecash** (fresh identity every run, intentionally never published — publishing a throwaway event on every click would spam production relays) correctly cannot reach full ACCEPT, while **Try SOLVENT → LIVE PUBLIC DEMO** — built once via `npm run live-demo` and published for real — genuinely can. See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee" section for the full explanation and the exact published event id/relays/digests.

"Couldn't find it" and "couldn't check" are never collapsed into one reason: a relay that answers but doesn't have the event yields `REFUSE_NOSTR_EVENT_NOT_FOUND` (Create Test Ecash's expected case — UI badge "PUBLICATION NOT FOUND"), while every relay being unreachable yields the distinct `REFUSE_NOSTR_UNAVAILABLE` (UI badge "PUBLIC EVIDENCE COULD NOT BE CHECKED"). A real relay miss can also be transient (observed directly during this build): one bounded retry absorbs that without ever masking a genuinely unpublished event — see `docs/trust-boundaries.md`'s "Bounded relay-fetch retry" section.

The Live Public Demo itself has a real, finite shelf life — its *reserve* attestation, not its Nostr event, is the binding freshness constraint, network-aware (see `docs/trust-boundaries.md`'s "Effective expiry" section for the exact computed window and the network-portability fix behind it). `npm run verify:submission`'s "Canonical Live Public Demo" line is a real, right-now check of this exact demo (not historical evidence) — `SUBMISSION READY` is impossible while it's failing.

**Deployment keeps this fresh automatically.** `.github/workflows/refresh-live-demo.yml` runs daily (and on demand via `workflow_dispatch`): regenerate → verify live → test → attack corpus → submission gate → build → deploy to GitHub Pages → confirm the *deployed* site (not just the local build) actually serves the new evidence, via a real fetch check and a real headless-browser run of the Live Public Demo. Any failing step stops the run before anything is deployed. No repository secrets are required — GitHub Pages deployment uses the workflow's own built-in token. See "Deployment" below.

### Try SOLVENT end to end

The complete, user-driven journey — entirely in the browser, no terminal, no manually-constructed JSON:

1. Open `/verify`.
2. Click **Create test ecash** (or the tab of the same name).
3. SOLVENT issues real test ecash and builds the matching evidence bundle.
4. Inspect/copy the token if you want it (`cashuB...`).
5. Inspect/copy/export the verification bundle if you want it (`View JSON` / `Copy bundle`).
6. Click **Verify this ecash**.
7. Watch the nine verification gates run for real — expect **"CRYPTOGRAPHIC CHECK PASSED"** with a **"PUBLICATION NOT FOUND"** badge (Accept stays disabled), since this fresh evidence was never published. Click **"Try live public demo"** to see the same checks reach a real `ACCEPT_VERIFIED`.
8. To test the manual path: copy the bundle from step 5, switch to **Verify your evidence**, paste it, and verify — it reproduces the exact same result, proving the exported bundle is genuinely consumable, not merely displayed. (Or click **Load example bundle** there to load the Live Public Demo bundle and see a real ACCEPT.)

See [`docs/start-here.md`](docs/start-here.md) (or `/docs?doc=start-here` in the running app) for this same walkthrough with more detail on what each step actually proves.

Honest notes:

- The built-in reserve is Bitcoin Signet (Mutinynet) **test-network capital**, not mainnet capital.
- Random external Cashu mints are **not** supported — only mints (including SOLVENT's own test mint) that publish the exact evidence chain `verify()` needs. See the FAQ.
- You are never expected to hand-construct the verification bundle; **Create test ecash** builds a real, valid one for you.

## Try the demo (curated scenarios)

| Scenario | Expected result |
| --- | --- |
| LIVE PUBLIC DEMO — genuinely published, issuance included, live-fetched Nostr evidence matches, reserve covers it | **ACCEPT VERIFIED** |
| BROKEN PROMISE — promised issuance omitted from the closed epoch | **REFUSE — `REFUSE_ISSUANCE_OMITTED`** (even though reserve is healthy) |
| RESERVE SHORTFALL — issuance correctly included, but reserve below liabilities | **REFUSE — `REFUSE_RESERVE_SHORT`** |

BROKEN PROMISE is the point of the project: the mint really signed a receipt promising to count this issuance in this epoch (the receipt verifies, the issuance is real), but the epoch it closed and signed doesn't include it — while its live reserve is comfortably healthy. SOLVENT catches this because the holder independently reconstructs their own issuance and checks it against what the mint itself signed, not against a reported ratio.

Run it via the browser (`npm run dev`, then **Verify ecash** from the landing page or go straight to `/verify`) or reproduce the same properties via `npm run attacks` (A01/A02/A23) and their evidence under `evidence/attacks/`.

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
    app/                    the web client — router.ts, protocol-demo.ts (the one real
                             issuance/evidence builder behind Try SOLVENT, Create test ecash, and
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

**Automated refresh:** `.github/workflows/refresh-live-demo.yml` runs daily (`workflow_dispatch` also available for an on-demand run) and does the full chain, failing closed at every step before anything is deployed:

```
checkout → npm ci
  → npm run live-demo          (regenerate + publish, real Nostr relays)
  → npm run verify:live-demo   (confirm the fresh evidence is genuinely live/ACCEPT_VERIFIED)
  → npm test                   (deterministic suite)
  → npm run attacks            (25/25 attack corpus)
  → npm run verify:submission  (mechanism + the canonical live demo, required to pass)
  → npm run build               (bakes the fresh evidence into the production bundle)
  → deploy to GitHub Pages
  → npm run verify:deployed         (confirms the DEPLOYED bundle, not just local dist/, contains the new evidence)
  → npm run verify:deployed:browser (confirms a real headless-browser run against the DEPLOYED site reaches ACCEPT VERIFIED)
```

Freshness window ~7 days (network-aware — see `docs/trust-boundaries.md`'s "Effective expiry"); refresh cadence 1 day; ~6 days of safety margin, so a temporary CI or Pages outage doesn't immediately take the deployed demo down.

**Manual fallback** (if the workflow is disabled, failing, or an immediate refresh is needed): run `npm run live-demo:release` locally (regenerates + rebuilds `dist/` in one step — a rebuild is required, since the evidence is bundled into the production JS at build time, not fetched at runtime), then deploy `dist/` however this repo is deployed. Run `npm run verify:deployed -- <url>` (and, for the strongest check, `npm run verify:deployed:browser -- <url>`) afterward to confirm the deployed site actually picked up the refresh.

## Testing

```bash
npm test
```

200+ tests across NUT-12/DLEQ (official vectors + mutation attacks), the sum-MMR and epoch manifest (official PR #388 vectors), signed PoL receipts, the hero omission contradiction, the central `verify()` decision rule, Gate 4's real acceptance-boundary spy tests, Gate 5's real Nostr evidence evaluation (signature/freshness/conflict/mismatch), Gate 6's real reserve attestation evaluation, the fail-closed submission verifier's own logic, and a jsdom test driving the real v2 web UI (landing page, all three verifier scenarios, Gate 4 enforcement, and the evidence pipeline / protocol pages).

## Tech stack

TypeScript, Node 24, Vite (vanilla TS, no framework), Vitest, `@cashu/cashu-ts` for Cashu parsing/crypto, `nostr-tools` for Nostr, `@noble/hashes`/`@noble/curves` for hashing/secp256k1 primitives, `@scure/btc-signer` for Taproot address derivation and BIP-341 key tweaking.

## Future work

A second, fully live Signet reserve funding path without a human-solved faucet step; a real mint integration in place of the fixture mint; the remaining PR #388 fraud-challenge types (`append_only_violation`, `sum_mmr_consistency_violation`, keyset-lifecycle enforcement); OpenTimestamps anchoring; and wallet integrations that call `verify()` as a real accept gate outside this demo client. Full list in `docs/draft-alignment.md`.
