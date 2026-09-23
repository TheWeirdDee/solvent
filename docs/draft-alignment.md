# Draft alignment — Cashu PR #388

SOLVENT aligns its liability semantics to **Cashu PR #388 / draft Proof-of-Liabilities proposal** (`github.com/cashubtc/nuts/pull/388`, semantic content pinned from `github.com/a1denvalu3/nuts/blob/pol-spec/pol.md`, fetched 2026-09-21; re-confirmed unchanged 2026-09-23 — head commit `8fc2d3fcd33e1b6ba9b21497c2e71bd8ec60b685` on branch `pol-spec`, base `cashubtc:main@2814335d16c848389c2eb657b08e8548a1a27e22`, PR state `open`/`draft: true`, `merged: false`). This is a **draft pull request**, not an assigned, finalized Cashu NUT. Per the draft's own header:

> Draft identifier: `388` is the proposal's pull-request number and MUST be replaced with the NUT number assigned when the proposal is merged.

SOLVENT never refers to it as "NUT-388" in product copy — only "Cashu PR #388 / draft Proof-of-Liabilities proposal."

## What is implemented byte-exact to the draft

Every item below is validated against the draft's own official test vectors (`tests/pol-tests.md`), not self-authored fixtures — see `tests/pol/mmr.test.ts` and `tests/pol/manifest.test.ts`.

- **sum-MMR leaf hashing** (`Leaf_issued = SHA256(bytes(B_))`, `Leaf_spent = SHA256(bytes(Y))`, sum = amount) — `src/pol/mmr.ts`.
- **sum-MMR parent/peak-bagging** (`hash_P = SHA256(hash_L || hash_R || bytes_8(sum_L) || bytes_8(sum_R))`, right-to-left bagging, uint64 overflow rejection) — matches the official 2-leaf, 3-leaf, and 3→4-consistency vectors exactly, including root hash and root sum.
- **sum-MMR inclusion proofs**, with position **derived, never trusted**, per the draft's Verification Protocol step 4/5 wording — `verifyInclusionProof` in `src/pol/mmr.ts`.
- **Keyset leaf hash / keyset Merkle tree / global digest** (`Cashu_PoL_Keyset_Leaf_v1`, `Cashu_PoL_Keyset_Node_v1`, `Cashu_PoL_Keyset_Empty_v1`, `Cashu_PoL_Epoch_v1` domain separators) — `src/pol/manifest.ts`, matches the official epoch-1 vector's exact keyset leaf hash, global digest, and manifest message string.
- **Signed transactional PoL receipts**, secp256k1 (version `00`/`01`) path only: `"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch`, BIP-340 Schnorr over `SHA256(message)`, signed/verified with the keyset's per-amount key (the same key used for Cashu blind signing) — `src/pol/receipt.ts`, matches the official vector.
- **Signed epoch manifest message** (the exact 14-field colon-separated string) and its BIP-340 signature over `SHA256(message)` with the mint's master key — `src/pol/manifest.ts`.

## Deliberate Phase-1 cuts

These are named explicitly, per the draft's own "Deliberate Cut" guidance and PRD §10.4:

- **No OpenTimestamps (OTS) anchoring.** The draft's manifest-signature chain is fully real; the OTS-receipt validation described in "Validate OpenTimestamps Attestation" (steps 2-5 of the Verification Protocol) is not implemented. A manifest's authenticity in this build rests entirely on the BIP-340 signature, not on an independent Bitcoin block-header attestation. `ots_receipt` is not part of `ManifestFields`.
- **No BLS12-381 (version `02`) signature path.** Only the secp256k1 BIP-340 path is implemented, matching Gate 0's supported cryptographic scope.
- **No keyset lifecycle enforcement.** `active`/`deactivation_epoch` fields exist in `KeysetManifestEntry` and are hashed/signed correctly, but the lifecycle invariants ("Monotonic Status," "Issued MMR Freeze," "Epoch Deadline") described in the draft's "Keyset Lifecycle Commitments" section are not independently checked by SOLVENT's verifier. The `rotation_violation` fraud-challenge type (draft §5) is not implemented.
- **No `append_only_violation` or `sum_mmr_consistency_violation` fraud-challenge verification** (draft challenge types 2 and 4) — these require comparing two epochs' signed state and would need a persisted epoch history, which is out of scope for the single-epoch hero demonstration built this session.
- **`manifest_equivocation` detection (draft challenge type 3) is implemented** — Gate 5's `evaluatePolEvidence()` detects two or more distinct, validly-signed evidence states for the same mint identity/epoch and refuses with `REFUSE_NOSTR_CONFLICT` (PRD attack A15). This is Nostr-evidence-level equivocation detection (two different signed manifest digests published as evidence for the same epoch), not the draft's full multi-relay historical-audit workflow.
- **No HTTP API compatibility** (`GET /v1/pol/{keyset_id}/manifest`, `POST /v1/pol/{keyset_id}/proofs/issued`, etc.) — SOLVENT's fixture mint is an in-process TypeScript module, not an HTTP server implementing the draft's wire API.
- **`leaf_omission_or_mismatch` (draft challenge type 1) is implemented** — this is the hero mechanism (`src/pol/fraud.ts`), and is the one challenge type this build actually needs.

## What this means for "ACCEPT"

`src/verifier/verify.ts`'s `ACCEPT` decision covers the full Gate 0-3 cryptographic spine (DLEQ → B' reconstruction → signed receipt → closed epoch → signed manifest → inclusion → liability arithmetic) plus two **externally-supplied** `{verified, reasonCode?}` objects for reserve coverage and Nostr evidence — `verify()` itself stays synchronous and does no network I/O. What supplies those two objects matters: `src/nostr/pol-evidence.ts`'s `evaluatePolEvidence()`/`fetchAndEvaluatePolEvidence()` (Gate 5, real relay publish/fetch, real signature/freshness/conflict checks) and `src/reserve/evaluate.ts`'s `evaluateReserveAttestation()`/`fetchAndEvaluateReserve()` (Gate 6, real dual-signature + independent chain-state re-verification against a real, funded Signet UTXO) are both real and fully tested — see `docs/nostr-schema.md` and `docs/reserve-attestation.md`. In the browser, nothing outside `verify()` is trusted to supply these two objects either: `src/app/submission.ts`'s `verifySubmission()` independently re-derives both from raw evidence before ever constructing `verify()`'s input — see `docs/trust-boundaries.md`. Omitting `reserve`/`nostr` from `verify()`'s input still fails closed with `REFUSE_UNVERIFIABLE` rather than silently passing.
