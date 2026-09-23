# PROTOCOL

Canonical serialization and verification rules SOLVENT implements, aligned to Cashu PR #388 / draft Proof-of-Liabilities proposal. Full byte-level formulas live in the code (`src/pol/`) and are validated against the draft's own official test vectors in `tests/pol/`. See `docs/draft-alignment.md` for exactly what is/isn't implemented from the draft.

## 1. Holder-side reconstruction (Gate 0)

Given a received Cashu proof `(secret, C, dleq: {e, s, r})` and the mint's per-amount public key `A`:

```
Y  = hash_to_curve(secret)
B' = Y + rG
C' = C + rA
```

`B'` is then verified against the mint's NUT-12 DLEQ proof `(e, s)` and used — never a mint-supplied opaque ID — as the identity for every liability check that follows. Implementation: `src/cashu/reconstruct.ts`. Evidence: `evidence/gate-0/`.

## 2. Signed transactional PoL receipt (Gate 1)

```
message = "Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch_decimal
signature = BIP340_Schnorr_Sign(SHA256(message), private_keys[amount])
```

Verified against `public_keys[amount]` — the same per-amount key used for Cashu blind signing. Implementation: `src/pol/receipt.ts`. Evidence: `evidence/gate-1/`.

## 3. sum-MMR (Gate 2)

Two append-only Merkle Mountain Ranges with Sums per keyset:

- **Issued:** leaf = `(SHA256(bytes(B_)), amount)`.
- **Spent:** leaf = `(SHA256(bytes(Y)), amount)`.

```
Parent(L, R) = (SHA256(hash_L || hash_R || bytes_8(sum_L) || bytes_8(sum_R)), sum_L + sum_R)
```

Fails (throws) if `sum_L + sum_R >= 2^64`. Peaks are bagged right-to-left into `(root_hash, root_sum)`; the empty MMR is `(SHA256(""), 0)`.

Inclusion proofs carry a sibling path plus every current peak; the verifier **derives** the leaf's position from the path length and the committed MMR size (via the size's binary decomposition into peak heights) — it never trusts a claimed `leaf_index`.

```
outstanding_balance = issued_mmr_root_sum - spent_mmr_root_sum
```

Implementation: `src/pol/mmr.ts`. Evidence: `evidence/gate-2/`. Validated exactly against the draft's 2-leaf, 3-leaf, and 3→4-consistency test vectors.

## 4. Epoch manifest (Gate 2)

```
keyset_leaf_hash = SHA256(
  "Cashu_PoL_Keyset_Leaf_v1"
  || u16(len(keyset_id)) || keyset_id
  || u16(len(unit))      || unit
  || u64(issued_mmr_size) || issued_mmr_root_hash || u64(issued_mmr_root_sum)
  || u64(spent_mmr_size)  || spent_mmr_root_hash  || u64(spent_mmr_root_sum)
  || u8(active) || u64(deactivation_epoch)
)

keyset_merkle_root = binary Merkle tree over sorted keyset leaves,
                      node = SHA256("Cashu_PoL_Keyset_Node_v1" || left || right),
                      odd levels duplicate the final hash,
                      empty root = SHA256("Cashu_PoL_Keyset_Empty_v1")

global_digest = SHA256(
  "Cashu_PoL_Epoch_v1" || previous_global_digest || u64(epoch_index) || u16(keyset_count) || keyset_merkle_root
)

manifest_message = "{keyset_id}:{unit}:{epoch_index}:{timestamp}:{previous_global_digest}:
                     {issued_mmr_size}:{issued_mmr_root_hash}:{issued_mmr_root_sum}:
                     {spent_mmr_size}:{spent_mmr_root_hash}:{spent_mmr_root_sum}:
                     {outstanding_balance}:{active}:{deactivation_epoch}"

mint_signature = BIP340_Schnorr_Sign(SHA256(manifest_message), master_private_key)
```

Keysets sort by unit then keyset_id, lexicographically by encoded bytes. Implementation: `src/pol/manifest.ts`. Evidence: `evidence/gate-2/`. Validated exactly against the draft's epoch-1 test vector (keyset leaf hash, global digest, manifest message string, and the official BIP-340 signature verifies against our computed digest).

## 5. The hero contradiction (Gate 3)

```
holder reconstructs B' (§1)
  -> receipt verifies for this exact B' and target_epoch (§2)
  -> target_epoch is closed (manifest.epoch_index >= receipt.target_epoch)
  -> that epoch's manifest signature verifies (§4)
  -> attempt sum-MMR inclusion for B' at the claimed amount (§3)

inclusion found  -> continue toward ACCEPT
inclusion missing -> REFUSE_ISSUANCE_OMITTED
```

Fraud evidence object: `src/pol/fraud.ts`, schema `leaf_omission_or_mismatch` (draft challenge type 1). Self-contained — a judge can recompute the decision from `evidence/hero/fraud-evidence.json` plus the public keyset/master keys alone, without trusting SOLVENT's frontend.

## 6. Decision rule

`src/verifier/verify.ts` implements checks 1-9 of the full rule (parse → keyset support → DLEQ present → DLEQ valid → `B'` reconstructed → receipt valid → epoch closed → manifest valid → inclusion valid → liability arithmetic valid) directly, plus two externally-supplied `{verified: boolean, reasonCode?}` objects for reserve coverage (checks 11-13) and Nostr evidence (checks 14-17). `verify()` itself stays synchronous and does zero network I/O — the real Gate 5/6 evaluators (§8, §9 below) run first and hand their result in. Missing reserve/Nostr context fails closed to `REFUSE_UNVERIFIABLE`, never silent ACCEPT. Stable reason codes: `src/verifier/reasons.ts`.

## 7. Real acceptance side effect (Gate 4)

```
received token -> verify(input) -> decision
  ACCEPT -> acceptFn(store, mint, proof) called exactly once
             (serializes via real getEncodedToken(), commits to WalletStore)
  REFUSE -> acceptFn never called
```

`runAcceptGate()` takes an injectable `acceptFn` (defaulting to the real `acceptProof()`) so tests can spy on call count without re-testing `acceptProof`'s internals every time. Implementation: `src/enforcement/accept-gate.ts`. Evidence: `evidence/gate-4/`. See `docs/trust-boundaries.md` for exactly what "acceptance" does and does not mean here.

## 8. Nostr public evidence (Gate 5)

```
content = { schema: 'solvent/pol/v2', mint_identity, epoch_index,
            manifest_digest, manifest_signature, global_digest,
            issued/spent mmr root hash+sum, outstanding_balance,
            reserve_digest, reserve_sats, reserve_network,
            issued_at, valid_until, proof_uri }
event   = kind 8181, tags [['M', mint_identity], ['E', epoch_index], ['K', keyset_id]],
          signed with a Nostr identity keypair (BIP-340, nostr-tools finalizeEvent)
```

Verification (`evaluatePolEvidence`, checks 14-17): dedupe by event id → re-verify identity/epoch binding independently of relay-side filtering → signature/shape (`REFUSE_NOSTR_SIGNATURE`) → group by `(manifest_digest, global_digest, reserve_digest)`, 2+ distinct groups = `REFUSE_NOSTR_CONFLICT` → freshness `issued_at <= now <= valid_until` (`REFUSE_NOSTR_STALE`) → digest binding matches the decision actually made (`REFUSE_NOSTR_STATE_MISMATCH`) → nothing found at all (`REFUSE_NOSTR_UNAVAILABLE`). Implementation: `src/nostr/pol-event.ts`, `src/nostr/pol-evidence.ts`. Evidence: `evidence/nostr/`. Full schema rationale: `docs/nostr-schema.md`.

The browser's orchestration layer (`evaluateNostrIndependently()`, `src/app/submission.ts`) further splits the "nothing found" case above by relay reachability, since "relays answered but don't have this event" and "no relay could be reached" are different facts: reachable-but-absent becomes `REFUSE_NOSTR_EVENT_NOT_FOUND` (Create Test Ecash's expected case), unreachable stays `REFUSE_NOSTR_UNAVAILABLE`. Never collapsed into one code. See `docs/nostr-schema.md`'s "Browser-layer refinement" and `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee".

## 9. Reserve attestation (Gate 6)

```
statement = { network, reserve_pubkey (tweaked P2TR output key, x-only),
              outpoints: [{txid, vout, value_sats, script_pubkey_hex}],
              timestamp, block_height }
statement_signature = BIP340_Schnorr_Sign(SHA256(statement_message), tweaked_reserve_privkey)
binding_signature    = BIP340_Schnorr_Sign(SHA256("Solvent_Reserve_Binding_v1:" || reserve_pubkey || ":" || statement_digest), master_privkey)
```

Verification (`evaluateReserveAttestation`, checks 11-13): structural validity + both signatures (`REFUSE_RESERVE_ATTESTATION_INVALID`) → staleness vs. current chain tip (`REFUSE_RESERVE_ATTESTATION_INVALID`) → per-outpoint independent re-query against a public Esplora API: existence/value/script match (`REFUSE_RESERVE_STATE_MISMATCH`), spent status (`REFUSE_RESERVE_UTXO_SPENT`) → sum of verified unspent value `>= outstanding_balance` (`REFUSE_RESERVE_SHORT`). Implementation: `src/reserve/taproot.ts`, `statement.ts`, `evaluate.ts`, `esplora.ts`, `fetch-and-evaluate.ts`. Evidence: `evidence/reserves/`. Full design rationale and the current live-funding blocker: `docs/reserve-attestation.md`.
