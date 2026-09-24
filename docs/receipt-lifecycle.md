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

This was written so a mint running *without* SOLVENT's migration applied keeps working normally (the `UPDATE` matches zero rows or errors "no such table," either way silently). The real, honest consequence: if this `UPDATE` ever fails to match a row for *any* other reason too — a bug, an unexpected ordering, a future code change that breaks the `blinded_message_hex` correlation — the surrounding transaction still commits successfully, and the row is left durably `pending` with no error surfaced anywhere. **This is the actual gap.**

## Recovery — now built, not just planned

`Mint::recover_pending_pol_receipts()` (`crates/cdk/src/mint/mod.rs`, `patches/cdk/0003-*.patch`) is called once at real `cdk-mintd` startup (`patches/cdk/0004-*.patch`, wired into the real production startup path right after `self.mint.start().await?`, before the HTTP listener binds). It scans `solvent_pol_receipt` for any row still `pending` (self-sufficient by construction — `keyset_id`, `amount`, and the exact canonical `message` bytes are already stored on the row, so no other process state is needed to complete it), signs each one through the real signatory (the identical `sign_pol_receipt()` call path `process_mint_request()` itself uses), independently verifies the signature locally before persisting it, and marks the row `signed`. It is structurally duplicate-safe: it only ever `UPDATE`s an existing, uniquely-identified row — there is no code path by which running it again could create a second row for the same obligation. A failed scan is logged, not fatal — the mint still starts and serves real traffic even if recovery itself has a problem.

**Proven for real** (not just designed) in [run 35961052740](https://github.com/TheWeirdDee/solvent/actions/runs/35961052740): 3 synthetic `pending` receipts (seeded directly against the real database, the same direct-SQL technique the atomicity test already established as valid — see `src/cli/real-cashu/pol-seed-pending-receipts.ts`) were recovered by a real `cdk-mintd` restart, all 3 signed and independently verified against the real mint's real public key. A **second** real restart, with nothing left pending, reported the identical 3 rows unchanged — proving idempotency under repetition, not asserting it.

## The real crash drill — a genuine SIGKILL, not a simulation

**Canonical evidence label: `CRASH_BEFORE_COMMIT_ROLLBACK`.** An earlier informal report used the label `CRASH_AFTER_COMMIT: RECOVERED` for this same result — that label is wrong and has been retired. The real `kill -9` lands *before* `tx.commit()` (inside CW-B, the still-open transaction), not after it. Nothing is "recovered" by this drill, because nothing was ever durably written for the killed attempt to recover — the correct description is a rollback, not a recovery. (The real recovery mechanism, described below, is a separate thing: it handles rows that *did* commit as `pending`, which this drill does not produce.)

`patches/cdk/0003-*.patch` also adds a debug-only, opt-in delay (`SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS`, compiled out entirely in release builds via `#[cfg(debug_assertions)]`) immediately before `tx.commit()` — the exact point in CW-B where everything (blind signature, liability, signed receipt) is fully staged in the still-uncommitted transaction. Real CI sets this env var, starts a real background Lightning-paid mint attempt (`src/cli/real-cashu/pol-trigger-mint-for-crash-drill.ts`), waits for it to genuinely enter the delay window, and sends a **real `kill -9`** to the real mint process — not a caught exception, an actual process termination. Observed for real in the same run: a real quote, a real settled Lightning payment (preimage confirmed), the mint call itself failing with `fetch failed` (the connection was genuinely severed by the real process death), and row counts (`cdk`/`liability`/`signed_receipts`) identical before and after — proving the entire interrupted transaction, receipt state included, left nothing behind. This is `CRASH_BEFORE_COMMIT_ROLLBACK`, not a post-commit case.

CW-C (crash *after* commit, before the HTTP response) is a genuinely different case — everything is already durable there, including the signed receipt; only response delivery is at risk, and it is closed by the retrieval endpoint below, not by this drill.

## Receipt retrieval — closing CW-C for real wallets, now a real endpoint

CW-C shows the receipt is always safely durable by the time a crash could plausibly separate a wallet from its HTTP response. `GET /v1/solvent/pol-receipt/{blinded_message}` (`patches/cdk/0005-*.patch`, `Mint::get_pol_receipt()`) is the real, working answer to "how does a wallet ask for it again" — looked up by the same public blinded-message value NUT-04 already returns, no wallet identity, no account, no proof secret. Proven end to end in [the same run](https://github.com/TheWeirdDee/solvent/actions/runs/35961052740) by `src/cli/real-cashu/pol-wallet-consume-receipts.ts`: a real minimal wallet path pays a real invoice, mints via the low-level client, retrieves each output's receipt over real HTTP, and independently verifies all of them. This is a **named SOLVENT extension** beyond the pinned draft's inline-response requirement (`docs/draft-alignment.md`'s delivery-correction table), not a substitute silently presented as equivalent.
