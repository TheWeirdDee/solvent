# Receipt lifecycle — exact real timeline and crash windows (Phase 2 Step 8 closure)

Traced from the actual patched source (`patches/cdk/0003-wire-pol-receipt-signing-into-nut04-issuance.patch`), not assumed. This document exists specifically to answer, precisely, whether a real process crash can leave a committed Cashu liability permanently without its required receipt — the property Phase 2 Step 8 must actually establish.

## The exact real sequence, for a non-batch NUT-04 mint

```
Mint::process_mint_request()                          crates/cdk/src/mint/issue/mod.rs

  Phase 1-3: validation                                (read-only)

  Phase 4: self.blind_sign(outputs)                    — real signatory call, OUTSIDE any tx
           for each output:
             self.sign_pol_receipt(keyset_id, amount, message)   — real signatory call, OUTSIDE any tx
           → pol_receipt_signatures: Vec<(PublicKey, String)>    — held in process memory only

  Phase 5: tx = self.localstore.begin_transaction()    — BEGIN

    tx.add_blinded_messages(quote_id, outputs, op)      — INSERT blind_signature (c = NULL)
    tx.add_blind_signatures(secrets, signatures, quote) — UPDATE c = <value>
      └─ SQLite trigger fires HERE (AFTER UPDATE OF c ... WHEN NEW.c IS NOT NULL AND OLD.c IS NULL)
           → INSERT solvent_issued_liability (this row now exists, uncommitted)
           → INSERT solvent_pol_receipt (status = 'pending', uncommitted)

    for each output:
      tx.record_pol_receipt_signature(blinded_message, signature_hex)
        → UPDATE solvent_pol_receipt SET status = 'signed', signature_hex = ... (uncommitted)

    mint_quote.add_issuance(...); tx.update_mint_quote(...)
    tx.add_completed_operation(...)

  tx.commit()                                           — COMMIT (single point of durability)

  return Ok(MintResponse { signatures: all_blind_signatures })
```

**The load-bearing fact**: `record_pol_receipt_signature()` is called *inside* the same open transaction as the trigger that creates the `pending` row — both statements execute against the same uncommitted transaction, before `tx.commit()`. This is not incidental; the patch was written this way deliberately (see `DECISIONS.md`'s Phase 2 Step 5 entry).

## Crash windows, evaluated against the real sequence above

| Window | What has happened | On crash, what survives |
| --- | --- | --- |
| **CW-A** — anywhere in Phase 4 (before `begin_transaction()`) | `blind_sign`/`sign_pol_receipt` may have run; results held only in local `Vec`s | **Nothing.** No `begin_transaction()` has even been called; zero database writes exist. Proven trivially — there is nothing to roll back because nothing was ever written. |
| **CW-B** — anywhere inside the open transaction (trigger fires, liability + pending receipt created, `record_pol_receipt_signature` runs, quote updated, operation recorded) | All of the above have executed against the *uncommitted* transaction | **Nothing.** SQLite discards an uncommitted transaction on connection loss/process death — same guarantee the existing atomicity test (`npm run verify:pol-atomicity`) already proves for the liability row; it applies identically to the receipt's `pending`→`signed` transition, because it is statements in the *same* transaction, not a separate one. |
| **CW-C** — after `tx.commit()` returns successfully, before the HTTP response is sent | Everything is durable: `blind_signature.c` set, `solvent_issued_liability` row present, `solvent_pol_receipt` row **already `signed`** | **Everything except the HTTP response itself.** The issuance, the accounting record, and the signed receipt are all already safely committed. Only the caller's confirmation of that fact can be lost — see "Receipt retrieval" below for how a wallet recovers from this specific case. |

**Conclusion, stated plainly**: given this exact code, there is no reachable window where a `solvent_pol_receipt` row is durably committed in `pending` state as a result of a process crash. CW-B is genuinely all-or-nothing, verified by the same mechanism (SQLite transaction atomicity) the Step 7 atomicity test already exercises for the accounting row — extending that same test to also assert the receipt row's absence on rollback (not just the liability row's) closes any remaining doubt about this specific claim; see the crash-drill section below.

## The real residual risk — not crash timing, error tolerance

`record_pol_receipt_signature()`'s implementation (`crates/cdk-sql-common/src/mint/signatures.rs`, added by `patches/cdk/0002-*.patch`) deliberately discards its own result:

```rust
async fn record_pol_receipt_signature(&mut self, blinded_message: &PublicKey, signature_hex: &str) -> Result<(), Self::Err> {
    let _ = query(...)...execute(&self.inner).await;
    Ok(())
}
```

This was written so a mint running *without* SOLVENT's migration applied keeps working normally (the `UPDATE` matches zero rows or errors "no such table," either way silently). The real, honest consequence: if this `UPDATE` ever fails to match a row for *any* other reason too — a bug, an unexpected ordering, a future code change that breaks the `blinded_message_hex` correlation — the surrounding transaction still commits successfully, and the row is left durably `pending` with no error surfaced anywhere. **This is the actual gap**, and it is why a recovery mechanism is still the right fix, even though it is not filling the specific crash-timing window the initial framing assumed. Built in `docs/receipt-lifecycle.md`'s companion work — see `DECISIONS.md`'s recovery-mechanism entry.

## Receipt retrieval — closing CW-C for real wallets

CW-C shows the receipt is always safely durable by the time a crash could plausibly separate a wallet from its HTTP response. What a wallet still needs is a way to *ask for it again*. See `docs/pol-extension.md`'s delivery-semantics section and `src/cli/real-cashu/pol-receipt-verify.ts`/the retrieval endpoint added alongside this document for how that gap is closed — a SOLVENT extension beyond the draft's inline-response requirement, named as such.
