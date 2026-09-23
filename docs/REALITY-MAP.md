# Reality map — Phase 1

**Never allow "testnet" and "simulated protocol" to be conflated.** Every prior pass of this project used a real test network (Bitcoin Signet/Mutinynet) for the reserve leg, but the Cashu issuance/redemption leg itself ran entirely inside SOLVENT's own process — real cryptography, against a network of exactly one, imaginary participant. This table is the explicit, line-by-line answer to "which of these is real, and which is simulated" for Phase 1.

| Component | Implementation | Environment | Simulation? |
| --- | --- | --- | --- |
| Cashu mint | **CDK** (`cdk-mintd` v0.18.1, prebuilt binary) — an independent, external, real Cashu implementation, not SOLVENT's own code | Bitcoin regtest + a real `lnd` payment backend | **NO** |
| Lightning invoice (mint side) | Created by the real CDK mint via its real `lnd` backend (LND-1); paid by a **separate** real Lightning node (LND-2) | Bitcoin regtest | **NO** |
| Lightning invoice (melt/destination side) | Created directly on LND-2 (independent of the mint); paid by the mint via its LND-1 backend | Bitcoin regtest | **NO** |
| NUT-04 issuance (mint) | Real CDK HTTP endpoint (`/v1/mint/quote/bolt11`, `/v1/mint/bolt11`) | — | **NO** |
| NUT-03 swap (receiver) | Real CDK HTTP endpoint (`/v1/swap`), driven by `@cashu/cashu-ts`'s real `Wallet` client | — | **NO** |
| NUT-07 proof state | Queried from the real mint's `/v1/checkstate` endpoint, never local application memory | — | **NO** |
| NUT-05 melt | Real CDK HTTP endpoint (`/v1/melt/quote/bolt11`, `/v1/melt/bolt11`) | — | **NO** |
| Double-spend rejection | The real mint's own real proof-state tracking rejects a resubmitted spent proof — not a client-side check | — | **NO** |
| Process-restart persistence | The mint process is killed and restarted against the SAME on-disk SQLite database; already-spent proofs are re-queried in a fresh process and still report SPENT, and a fresh double-spend attempt against them is still refused — proving durable state, not an in-memory artifact | Bitcoin regtest | **NO** |
| Money | Bitcoin regtest coins | Regtest | Economic value: **NONE** (by construction — regtest coins are worthless everywhere) |
| SOLVENT PoL (signed receipts, epoch manifests, sum-MMR, reserve attestation, Nostr publication) | **NOT YET CONNECTED IN PHASE 1** — see "Why SOLVENT is not yet connected" in `DECISIONS.md`. This is Phase 2's job. | — | N/A this phase |
| Nostr publication/verification, Bitcoin Signet reserve verification (the existing SOLVENT verifier) | Unchanged, fully preserved from prior passes — see `docs/trust-boundaries.md` | Bitcoin Signet (Mutinynet) + real public Nostr relays | **NO** (already real, and untouched by this phase) |
| Reference acceptance store (`src/enforcement/accept-gate.ts`'s in-memory `WalletStore`) | Legacy/test-only. **NOT used anywhere in the Phase 1 real Cashu flow** — Phase 1's real acceptance primitive is the mint's own real proof-state transition (UNSPENT → SPENT via a real `/v1/swap`), observed via NUT-07, not this in-memory array. `accept-gate.ts` remains exactly as before for the existing SOLVENT verifier's own Gate 4 demonstrations (a separate, still-valid claim: "SOLVENT's own decision boundary performs a real, observable state mutation iff `verify()` says ACCEPT" — see `docs/trust-boundaries.md`'s "What Gate 4's acceptance does NOT mean"). | — | Legacy/test-only, out of scope for Phase 1 |
| SOLVENT's own fixture mint (`src/cashu/keys.ts`, `src/cashu/mint-sim.ts`) | Unchanged. Still real `@cashu/cashu-ts` blind-signing/DLEQ cryptography, still used by every existing deterministic test, the attack corpus, and the live browser demo (Try SOLVENT / Create Test Ecash / Live Public Demo) — none of that is touched by Phase 1. Its role going forward is explicitly Lane A (fast, deterministic, no-network verifier testing), never again claimed as "this proves ecash is real." | In-process, no network | Fixture, by design — see "Fixtures remain useful" in `DECISIONS.md` |

## Two execution lanes, never conflated

- **Lane A — deterministic local development.** Everything that existed before this phase: `npm test`, the attack corpus, `npm run gate0`..`gate6`, the browser demo. No Docker, no Bitcoin/Lightning/CDK required. Fast, reproducible, offline-capable. Proves the verifier's *logic* is correct against constructed adversarial state.
- **Lane B — real integration.** This phase's new work: `npm run verify:cashu-real` against a real Bitcoin regtest + real Lightning + real CDK mint stack, orchestrated by `.github/workflows/real-cashu-integration.yml` (see `docs/real-cashu-stack.md`). Proves the underlying Cashu *economic lifecycle* is genuinely real, independent of anything SOLVENT itself asserts.

Lane A and Lane B are not in tension — Lane A's fixtures remain exactly as useful as they always were for fast, deterministic testing. What changed is that Lane A's fixture mint can no longer be pointed to as evidence that ecash issuance/redemption itself is real; that claim now rests on Lane B.

Lane B is confirmed by real execution, not just by code review: [GitHub Actions run 35853398175](https://github.com/TheWeirdDee/solvent/actions/runs/35853398175) (2026-09-23) ran the entire table above for real and printed `REAL CASHU FOUNDATION VERIFIED` and `REAL CASHU FOUNDATION RESTART PERSISTENCE VERIFIED`. See `docs/limitations.md` for exactly what that run proved and where its evidence artifact is attached.

## Phase 2 — mint-native accounting + PoL receipts (NUT-04 only so far — Step 8 verified)

| Component | Implementation | Simulation? |
| --- | --- | --- |
| SOLVENT issued-liability records for NUT-04 | SQLite triggers on CDK's own unmodified `blind_signature` table, firing inside CDK's real transaction (`migrations/solvent-accounting/0001_nut04_issued_liability.sql`) | **NO** |
| Accounting atomicity | A transaction that fails after the trigger fires but before commit leaves both CDK's and SOLVENT's rows absent; a real commit leaves both present — proven against the real database in CI, not asserted | **NO** |
| Accounting reconciliation | SOLVENT's journal independently queried and compared against CDK's own real `blind_signature` table in the same database — exact match, not compared only against itself | **NO** |
| Retry idempotency | A genuine second HTTP mint attempt against an already-issued quote, rejected by the real mint | **NO** |
| Restart persistence (accounting + receipts) | Reconciliation re-run after killing and restarting the real, patched mint process reports byte-identical results, including signed-receipt state | **NO** |
| PoL receipt signing (NUT-04) | A real, small, checked-in patch to CDK's own source (`patches/cdk/*.patch`) adds `Signatory::sign_pol_receipt()`, using the exact same real per-amount key `blind_sign` uses. `cdk-mintd` is built from the pinned upstream commit plus this patch in CI. Every real output gets a real signed receipt, written in the same transaction as the accounting row. | **NO** |
| Independent receipt verification | A separate module (`src/cli/real-cashu/pol-receipt-verify.ts`) with no signatory access, no seed, no private key — only the mint's own real `/v1/keys` response — verified all 6 real signatures and correctly refused 4/4 tampered variants | **NO** |
| NUT-03 (swap) / NUT-05 (melt) accounting | **NOT YET BUILT.** Phase 2 deliberately implemented NUT-04 alone first, per its own build-order instruction. | N/A — not built |

Confirmed by real execution: [GitHub Actions run 35924475422](https://github.com/TheWeirdDee/solvent/actions/runs/35924475422) (2026-09-23) — the first run of the source-built, patched `cdk-mintd`, passing completely on the first attempt.
