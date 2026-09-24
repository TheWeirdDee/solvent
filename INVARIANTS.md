# INVARIANTS — Phase 2 mint-native accounting

Hard invariants Phase 2's durable SOLVENT accounting must satisfy against real CDK operations (`docs/cdk-integration-seams.md`, `docs/accounting-model.md`). Written before implementation, per Phase 2 Step 5. Every Phase 2 test should reference the invariant it proves; this file is the index those tests point back to, not a test report itself — see `docs/crash-consistency.md` for the crash-drill evidence and the real CI workflow for where each invariant is actually exercised.

**P2-I1** — Every successfully issued Cashu output has exactly one durable issued-liability accounting record.

**P2-I2** — No issued-liability record exists for a NUT-04 issuance that never committed.

**P2-I3** — Every proof successfully consumed by a swap or successful melt has exactly one durable consumed-liability record.

**P2-I4** — A failed swap creates no successful issued/spent accounting transition.

**P2-I5** — A failed melt does not finalize a consumed liability.

**P2-I6** — Every replacement output created by a successful swap becomes a new issued liability.

**P2-I7** — With fees disabled, a swap conserves net outstanding liability.

**P2-I8** — Successful melt reduces outstanding liability by exactly the consumed amount, with returned Cashu change treated as newly issued liability.

**P2-I9** — Retrying an already-committed operation cannot duplicate accounting.

**P2-I10** — Restart cannot lose committed accounting.

**P2-I11** — A successful Cashu operation cannot create spendable value without a durable SOLVENT accounting obligation.

**P2-I12** — Mint private amount keys never leave the mint/signatory boundary.

**P2-I13** — Receiver secrets, proof secrets, and wallet identity are not written into public accounting evidence.

**P2-I14** — Retired keysets with outstanding proofs remain part of outstanding liabilities.

## NUT-03 swap invariants (Phase 2 continuation)

**P2-S1** — Every proof successfully consumed by a real NUT-03 swap creates exactly one durable consumed-liability record.

**P2-S2** — Every replacement output created by that swap creates exactly one durable issued-liability record.

**P2-S3** — Every replacement output receives exactly one durable mint-native PoL receipt.

**P2-S4** — A failed swap creates neither successful consumed-liability state nor successful replacement-liability state.

**P2-S5** — With input fees disabled: `sum(consumed inputs) = sum(replacement issued outputs)`.

**P2-S6** — With input fees enabled: `sum(consumed inputs) = sum(replacement outputs) + explicit accounted protocol fees`, using CDK's own fee equation (`docs/cdk-integration-seams.md`'s NUT-03 transaction map: `input_amount = output_amount + fee_breakdown.total`).

**P2-S7** — A swap cannot commit consumed inputs without its replacement liabilities being durably accounted (both land in `finalize()`'s single transaction — see `docs/cdk-integration-seams.md`).

**P2-S8** — A swap cannot commit replacement liabilities without corresponding consumed input accounting (same transaction, same reasoning as P2-S7).

**P2-S9** — Restart cannot alter the net outstanding liability.

**P2-S10** — Retry/double-submit cannot duplicate consumed or issued accounting.

**P2-S11** — Old input proofs are SPENT after a successful swap.

**P2-S12** — Replacement proofs are UNSPENT after a successful swap.

**P2-S13** — Replacement receipts verify against the correct amount keys.

**P2-S14** — The swap does not link wallet identity into public accounting.

## Status

**NUT-04 (mint issuance) — verified against the real, patched CDK stack.** `docs/cdk-integration-seams.md`'s SQL-trigger architecture makes P2-I1, P2-I2, P2-I9, and P2-I10 hold by construction for issuance: the trigger fires inside CDK's own commit, so there is no window for CDK to commit without the corresponding row, no separate "later" write to lose on crash, and no separate retry path to duplicate it — proven by a real transaction-abort test, a real reconciliation against CDK's own `blind_signature` table, a real duplicate-mint-attempt rejection, and a real process restart. The same reasoning extends to the PoL receipt obligation added for Step 8 closure: `record_pol_receipt_signature()` is called inside that *same* open transaction (`docs/receipt-lifecycle.md`'s crash-window table), and the added recovery scan (`Mint::recover_pending_pol_receipts()`) closes the remaining risk — proven by a real `kill -9` mid-transaction crash drill (identical before/after row counts) and a real restart-recovery test (3 seeded pending receipts, recovered, idempotent across two restarts). P2-I12 is now verified directly: signing happens exclusively inside `DbSignatory` (the one real `Signatory` implementor exercised here), reached only through `Mint::sign_pol_receipt()`, which has no HTTP route — confirmed by the signing-oracle audit in `docs/cdk-signatory-audit.md` and by 4 direct Rust unit tests (`cargo test -p cdk-signatory --lib sign_pol_receipt`) exercising the boundary without any external reachability. P2-I13 holds for the receipt retrieval endpoint added this closure: it is keyed by blinded-message hex (public output material), not proof secret, account, or wallet identity — see `docs/draft-alignment.md`'s delivery correction and `docs/privacy.md`.

**NUT-03 (swap) — in progress this continuation.** `patches/cdk/0006-*.patch` wires real PoL receipt signing into `finalize()`'s same transaction, mirroring NUT-04; `migrations/solvent-accounting/0002_nut03_consumed_liability.sql` adds the consumed-liability trigger on `proof`'s `state` transition to `SPENT`. P2-S1/S2/S3/S7/S8 hold by construction for the same reason NUT-04's issued-liability trigger does (single-transaction commit, traced not assumed — see `docs/cdk-integration-seams.md`'s NUT-03 transaction map). P2-S4 is additionally backed by two real, pre-existing CDK mechanisms this continuation did not need to build: in-process `compensate_all()`/`RemoveSwapSetup` and startup `Mint::recover_from_incomplete_sagas()`. Real-CI proof for the rest (P2-S5/S6/S9/S10/S11/S12/S13/S14) is tracked against the real swap test run — see `docs/receipt-lifecycle.md`'s NUT-03 section for results as they land.

**NUT-05 (melt) — not started.** P2-I5, P2-I8, and P2-I14 depend on correctly distinguishing a saga's *provisional* commits (e.g. `setup_melt()` locking proofs as pending) from its *terminal* commit (`finalize()`) — see `docs/cdk-integration-seams.md`'s NUT-05 section for exactly which CDK transaction is which. This work has not started, per the explicit instruction not to begin it until NUT-03 is reviewed. P2-I11 is the composite property the whole architecture exists to guarantee and remains partial until melt lands.
