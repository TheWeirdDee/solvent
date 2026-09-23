# ATTACKS

Status of the PRD §11 attack battery (A01-A25). Honest disclosure, not a completion claim.

| ID | Attack | Expected | Status | Where |
| --- | --- | --- | --- | --- |
| A01 | valid token + valid receipt + included issuance + covered reserve | ACCEPT | **Implemented** | `tests/verifier/verify.test.ts` ("ACCEPT when the crypto spine passes..."), `evidence/attacks/A01-honest-accept/` |
| A02 | promised issuance omitted | REFUSE_ISSUANCE_OMITTED | **Implemented** | `tests/verifier/verify.test.ts`, `tests/pol/hero.test.ts`, `evidence/hero/`, `evidence/attacks/A02-promised-issuance-omitted/` |
| A03 | issuance included with wrong value | REFUSE (surfaces as `REFUSE_MMR_PROOF_INVALID` — see note below) | **Implemented** | `src/cli/attacks.ts` ("A03"), `evidence/attacks/A03-issuance-included-wrong-value/` |
| A04 | forged receipt signature | REFUSE_RECEIPT_INVALID | **Implemented** | `tests/pol/receipt.test.ts`, `tests/verifier/verify.test.ts`, `evidence/attacks/A04-forged-receipt-signature/` |
| A05 | receipt epoch modified after signing | REFUSE_RECEIPT_INVALID | **Implemented** | `tests/pol/receipt.test.ts`, `evidence/attacks/A05-receipt-epoch-modified/` |
| A06 | reconstructed B' tampered | REFUSE_INVALID_DLEQ | **Implemented** | `tests/pol/receipt.test.ts`, `tests/cashu/reconstruct.test.ts`, `evidence/attacks/A06-reconstructed-b-prime-tampered/` |
| A07 | invalid DLEQ | REFUSE_INVALID_DLEQ | **Implemented** | `tests/cashu/reconstruct.test.ts`, `evidence/attacks/A07-invalid-dleq/` |
| A08 | missing r | REFUSE_MISSING_BLINDING_FACTOR | **Implemented** | `tests/verifier/verify.test.ts`, `tests/cashu/reconstruct.test.ts`, `evidence/attacks/A08-missing-blinding-factor/` |
| A09 | wrong mint/keyset public key | REFUSE_INVALID_DLEQ | **Implemented** | `tests/pol/receipt.test.ts`, `tests/cashu/reconstruct.test.ts`, `evidence/attacks/A09-wrong-amount-public-key/` |
| A10 | tampered MMR sibling hash | REFUSE_MMR_PROOF_INVALID | **Implemented** | `tests/pol/mmr.test.ts`, `evidence/attacks/A10-tampered-mmr-sibling-hash/` |
| A11 | tampered sibling sum | REFUSE_MMR_PROOF_INVALID | **Implemented** | `tests/pol/mmr.test.ts`, `evidence/attacks/A11-tampered-mmr-sibling-sum/` |
| A12 | reordered/wrong positional proof | REFUSE_MMR_PROOF_INVALID | **Implemented** | `tests/pol/mmr.test.ts`, `evidence/attacks/A12-reordered-positional-proof/` |
| A13 | manifest signature flipped | REFUSE_MANIFEST_INVALID | **Implemented** | `tests/pol/manifest.test.ts`, `tests/verifier/verify.test.ts`, `evidence/attacks/A13-manifest-signature-flipped/` |
| A14 | manifest liability arithmetic inconsistent | REFUSE_LIABILITY_ARITHMETIC | **Implemented** | `tests/verifier/verify.test.ts`, `evidence/attacks/A14-liability-arithmetic-inconsistent/` |
| A15 | conflicting signed manifests for same epoch | REFUSE_NOSTR_CONFLICT + evidence | **Implemented** | `src/nostr/pol-evidence.ts` (`evaluatePolEvidence`), `tests/nostr/pol-evidence.test.ts`, `evidence/attacks/A15-conflicting-signed-manifests-same-epoch/` |
| A16 | stale Nostr state | REFUSE_NOSTR_STALE | **Implemented** | `tests/nostr/pol-evidence.test.ts`, `evidence/attacks/A16-stale-nostr-state/` |
| A17 | one relay unavailable, second has valid state | deterministic success (ACCEPT) | **Implemented** | `tests/nostr/pol-evidence.test.ts` ("tolerates one relay contributing nothing..."), `evidence/attacks/A17-one-relay-down-other-has-valid-state/`; demonstrated for real (not just locally constructed) by `npm run gate5` against public relays |
| A18 | both relays unavailable | REFUSE_NOSTR_UNAVAILABLE | **Implemented** | `tests/nostr/pol-evidence.test.ts`, `evidence/attacks/A18-both-relays-unavailable/` |
| A19 | Nostr event digest differs from proof bundle | REFUSE_NOSTR_STATE_MISMATCH | **Implemented** | `tests/nostr/pol-evidence.test.ts`, `evidence/attacks/A19-nostr-event-digest-differs-from-proof-bundle/` |
| A20 | invalid reserve signature | REFUSE_RESERVE_ATTESTATION_INVALID | **Implemented** | `tests/reserve/evaluate.test.ts`, `evidence/attacks/A20-reserve-signature-invalid/` |
| A21 | previously attested reserve UTXO now spent | REFUSE_RESERVE_UTXO_SPENT | **Implemented** | `tests/reserve/evaluate.test.ts`, `evidence/attacks/A21-reserve-outpoint-spent-after-attestation/` |
| A22 | reserve value/script mismatch | REFUSE_RESERVE_STATE_MISMATCH | **Implemented** | `tests/reserve/evaluate.test.ts`, `evidence/attacks/A22-reserve-outpoint-value-script-mismatch/` |
| A23 | reserves below liabilities | REFUSE_RESERVE_SHORT | **Implemented** | `tests/verifier/verify.test.ts`, `tests/reserve/evaluate.test.ts`, `evidence/attacks/A23-reserve-below-liabilities/` |
| A24 | RED token attempts acceptance | acceptance fn called zero times | **Implemented** | `tests/enforcement/accept-gate.test.ts`, `evidence/attacks/A24-refused-token-never-reaches-acceptance/` |
| A25 | mint privately hands the receiver a correctly signed accounting event that was never publicly published (relay reachable, event absent) | REFUSE_NOSTR_EVENT_NOT_FOUND + `accept()` called zero times | **Implemented** | `src/cli/attacks.ts` ("A25"), exercises the real `src/app/submission.ts` `verifySubmission()` orchestration with the relay/chain-state fetches deterministically injected (never real internet — see `RelayFetchFn`/`ChainStateFetchFn`), `evidence/attacks/A25-signed-state-never-published/` |

**25/25 implemented and evidenced.** Every attack's assertion lives in a real Vitest test (or, for A25, a real deterministic run of the actual browser-facing `verifySubmission()` orchestration) against real cryptography (not prose, not a screenshot) AND a machine-readable evidence artifact under `evidence/attacks/Axx-*/{input.json,result.json,verify.txt}`. Run `npm test` to reproduce the test assertions, or `npm run attacks` to regenerate the evidence files — all 25 currently report PASS.

### Why A25 exists

A24 proves a REFUSE decision can't reach `accept()`. A25 proves something narrower and specific to this build's Nostr guarantee: a mint cannot satisfy SOLVENT merely by handing the receiver a *validly signed* accounting event privately — every other gate (proof, DLEQ, receipt, manifest, inclusion, liability arithmetic, reserve) genuinely passes, and the bundle's own Nostr event is genuinely, cryptographically valid, but because no public relay actually has it, SOLVENT refuses with `REFUSE_NOSTR_EVENT_NOT_FOUND` rather than trusting the private copy. See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee".

### Notes on reason-code mapping

- **A03**: the central verifier (`src/verifier/verify.ts`) recomputes the issued-tree leaf from the *received* proof's own amount and checks it against the epoch's committed inclusion proof. If the epoch's tree actually recorded a different value for the same `B'`, the recomputed leaf hash disagrees with the tree at the first hashing step — this surfaces as the same `REFUSE_MMR_PROOF_INVALID` any other tampered/incorrect inclusion proof produces, not a separately distinguished code. `REFUSE_ISSUANCE_VALUE_MISMATCH` exists in `src/verifier/reasons.ts` (documents the conceptual failure mode) but the sum-MMR design as implemented has no way to independently observe "the tree's value for this leaf differs from the claim" without already knowing the correct value — see `DECISIONS.md`.
- **A20-A22** (reserve attacks) use `bitcoin-signet-mutinynet` (real Taproot keys, real BIP-340 signatures, real Esplora-shaped chain-state checks) — the *evaluation mechanism* is fully real and tested; whether a live on-chain UTXO currently backs a specific run is a separate, Gate-6-specific question (see `docs/trust-boundaries.md` and the Gate 6 entry in `DECISIONS.md`).
- **A15-A19** (Nostr attacks) use the same `evaluatePolEvidence()` that `npm run gate5` exercises against real public relays; A15/A16/A18/A19 in the attack corpus specifically use locally-constructed (but really BIP-340-signed) event sets rather than waiting on live adversarial relay state, since reproducing "a relay is currently serving stale/conflicting data" on demand against public infrastructure isn't controllable — A17 is additionally demonstrated for real end-to-end by `npm run gate5`.
