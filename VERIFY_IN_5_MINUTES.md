# Verify in 5 minutes

```bash
npm ci
npm test                 # includes official Cashu NUT-12 and PR #388 draft test vectors, plus a full jsdom browser-UI suite
npm run verify:submission
```

`verify:submission` re-runs the real gate mechanisms (not a canned transcript) and prints something like:

```
Gate 0 reconstruction          PASS
DLEQ                           PASS
Honest inclusion               PASS  -> ACCEPT
Hero omission                  PASS  -> REFUSE_ISSUANCE_OMITTED
Short reserve                  PASS  -> REFUSE_RESERVE_SHORT
Gate 4 (enforcement)           PASS  spy: ACCEPT calls once, REFUSE calls zero
Gate 5 (Nostr mechanism)       PASS  signature/freshness/mismatch/unavailable checks
Gate 5 (live relay evidence, historical) PASS
Gate 6 (reserve mechanism)     PASS  signature/binding/spent/mismatch checks
Gate 6 (live Signet UTXO, historical) PASS
Canonical Live Public Demo     PASS  ACCEPT_VERIFIED
Attack corpus                  PASS  25/25 (expected 25)

SUBMISSION READY
```

Every line is a **required** check — the command exits non-zero (fail closed) unless every one of them passes. "Gate 6 (live Signet UTXO, historical)" is real and passing: the reserve address was funded with a real Signet transaction, and this line independently re-queries that real UTXO on every run. See `docs/trust-boundaries.md` for exactly what "real" means for each gate.

**"Canonical Live Public Demo" is a real, right-now check — never historical.** It calls `verifyCanonicalLiveDemo()` (`src/app/submission.ts`), the exact same function the browser's "LIVE PUBLIC DEMO" case and `npm run verify:live-demo` use, so `SUBMISSION READY` is now impossible while the actual browser-facing demo a judge would click is stale, unreachable, or mismatched. This is distinct from the "..., historical" lines above it, which read the *last-recorded* evidence from `npm run gate5`/`gate6` (general mechanism proof — signature/freshness/conflict/spent/mismatch cases exercised against throwaway fixtures) rather than `evidence/nostr/live-demo.json`; historical evidence passing is never a substitute for the canonical line. Run `npm run verify:live-demo` for the same canonical check with full diagnostic detail (relay reachability, exact freshness numbers, expiry estimate) if the canonical line fails.

Prefer to see this in a browser instead of a terminal? See [Start here — try SOLVENT in 2 minutes](#/docs?doc=start-here) for the same guarantees, driven entirely by clicking.

## Regenerate the underlying evidence files

```bash
npm run gate0    # evidence/gate-0/      — NUT-12 transfer invariant
npm run gate1    # evidence/gate-1/      — signed PoL receipt
npm run gate2    # evidence/gate-2/, evidence/hero/  — signed epoch + the hero omission contradiction
npm run gate4    # evidence/gate-4/      — real acceptance side effect (spy proof for ACCEPT and 4 REFUSE cases)
npm run gate5    # evidence/nostr/       — real publish/fetch-back against public relays + all 5 negative cases
npm run gate6    # evidence/reserves/    — real Taproot address, dual signatures, negative cases, real funded live UTXO
npm run attacks  # evidence/attacks/Axx-*/ — all 25 attacks, each with input.json/result.json/verify.txt
npm run live-demo         # evidence/nostr/live-demo.json — generates + publishes the stable Live Public Demo evidence
npm run live-demo:release # live-demo + build in one step — the evidence is bundled at build time, so a deployed site needs a rebuild (and redeploy) to see a refresh, not just a regeneration
npm run verify:live-demo  # independently re-checks the Live Public Demo is still live + fresh right now (real relay fetch, real Esplora query, network-aware exact expiry)
```

Every one of these re-runs real cryptography (real secp256k1 blind signing, real BIP-340 Schnorr signing, real sum-MMR construction, real Taproot key derivation) — nothing is a hand-authored fixture pretending to be a valid proof. `gate5` and `gate6` additionally do real network I/O (public Nostr relays; a public Bitcoin Signet block explorer). Each run produces different random keys/secrets, so exact hex values change between runs; the PASS/FAIL outcomes and structural properties (root hashes matching official test vectors, reconstructed `B'` equaling the original, etc.) do not.

## What to look at if you only have 2 minutes

1. `evidence/hero/fraud-evidence.json` — the hero contradiction, self-contained. You can independently verify `pol_receipt.signature` against the amount public key in `evidence/gate-2/epoch.json`, and `manifest.mint_signature` against the master public key in the same file, without trusting this repo's frontend.
2. `evidence/gate-4/enforcement.json` — proof that a real accept function is called exactly once on ACCEPT and zero times on every required REFUSE case.
3. `evidence/nostr/cases.json` — a real event id, published to and fetched back from real public relays, plus all 5 required Gate 5 negative cases.
4. `evidence/reserves/cases.json` — the real, funded reserve address/mechanism plus all required negative cases; `live_verified: true`.
5. `ATTACKS.md` — all 25 specified attacks, each pointing at a real test and a real evidence directory.
6. `DECISIONS.md` — the gate-by-gate status and every decision made building this.

## Deployment stays fresh automatically

`.github/workflows/refresh-live-demo.yml` regenerates, verifies, tests, builds, and redeploys the Live Public Demo to GitHub Pages daily (and on demand) — see `README.md`'s "Deployment" section for the full chain and `docs/trust-boundaries.md`'s "Automated deployment refresh" for the fail-closed details and why no repository secret is needed. If it's ever disabled or failing, the manual fallback is:

```bash
npm run live-demo:release              # regenerate + rebuild (a rebuild is required — the evidence bundles at build time)
# deploy dist/ however this repo is deployed
npm run verify:deployed -- <url>         # confirm the DEPLOYED bundle contains the new evidence
npm run verify:deployed:browser -- <url> # confirm a real headless-browser run reaches ACCEPT VERIFIED on the DEPLOYED site
```

## What this does NOT verify

`verify:submission` checks the protocol mechanism end to end, including a real live Bitcoin Signet re-query and real public Nostr relay evidence. It does not verify a production Cashu mint's reserves or accounting — this build's mint is SOLVENT's own test fixture. See `docs/trust-boundaries.md` for the complete list of what is and isn't real.
