# NUT-05 melt accounting (Phase 3C)

A melt destroys ecash. It pays a Lightning invoice from the mint's funds and may return **change** as new ecash. The PoL accounting must follow exactly what the mint really committed:

```text
spent inputs    -> spent commitment   (+inputs)
returned change -> issued commitment  (+change)
net liability change = -(inputs - change) = -(amount paid + fee paid)
```

## CDK v0.18.1 melt lifecycle (pinned `a056e0f0`)

| Stage | Upstream code | What is written | SOLVENT effect |
| --- | --- | --- | --- |
| Quote | `get_melt_quote` | melt quote | none |
| Setup | `MeltSaga::setup_melt` (`crates/cdk/src/mint/melt/melt_saga/mod.rs`) | input proofs via `add_proofs` as PENDING with `operation_kind = 'melt'`; change outputs via `add_blinded_messages` (`c = NULL`, placeholder amount) | none (no SPENT transition, no signature) |
| Payment | `make_payment` / `attempt_internal_settlement` | Lightning payment, or internal settlement | none |
| **TX1** | `finalize_melt_core` (`crates/cdk/src/mint/melt/shared.rs`) | quote set Paid; `Mint::update_proofs_state(inputs, SPENT)` | **consumed liabilities**, via the existing `solvent_consumed_liability_on_spent` trigger (`operation_kind IN ('swap','melt')`), stamped with the OPEN epoch |
| **TX2** | `process_melt_change` → `begin_melt_cleanup_transaction` | `add_blind_signatures(change)` sets `c` and the **final** change amount in one `UPDATE` | **issued liabilities** via the existing issued trigger (`operation_kind = 'melt'`, real amount), and, since **patch 0009**, receipts signed in this same transaction |
| Failure | saga compensation (`compensation.rs`) | removes the PENDING inputs and unsigned outputs | none (nothing ever reached SPENT or was signed) |
| Recovery | `finalize_melt_quote`, the single finalization path for normal, async and startup recovery | re-runs TX1 or TX2 as needed | the trigger conditions make it idempotent (`OLD.state != 'SPENT'`, and signing a signed row is a `Duplicate` error) |

## Patch 0009

Before 0009, change outputs were accounted as issued liabilities, but their PoL receipts stayed `pending` until the startup recovery scan signed them. That's because patch 0007's in-transaction signing ran only on the NUT-04 and NUT-03 paths.

[`patches/cdk/0009-sign-pol-receipts-for-melt-change.patch`](../patches/cdk/0009-sign-pol-receipts-for-melt-change.patch) adds one call, `Mint::sign_pol_receipts_in_tx`, right after `add_blind_signatures` in `process_melt_change`. So change receipts are signed over the epoch the trigger stamped, inside TX2, exactly as for issuance and swaps. A signing failure drops TX2 and leaves the paid melt to CDK's existing finalization recovery, the same way a failed change `blind_sign` is handled. **No schema change** is needed.

## Atomicity

- SOLVENT's rows are written by triggers inside CDK's own transactions. Each CDK write therefore commits together with its accounting, or not at all.
- CDK itself finalizes a melt in **two** transactions, TX1 and TX2. If an epoch closes between them, the spend is committed to epoch N and the change to N+1. Between the two commits, the mint really did owe that change to nobody yet.
- A SIGKILL while TX1 is staged leaves no consumed rows and the inputs still PENDING (tested). Recovery then completes the melt normally.

## Evidence

- **Unit** (`tests/epoch/nut05.test.ts`, real CDK schema, CDK's exact write sequence): 9 tests, covering inputs and change and their epochs and sums, outstanding after a close, exact leaves and the audit, no-change melts, unused blank outputs, a failed payment, double spend and retry, a TX1/TX2 split across an epoch close, a real SIGKILL during TX1 plus reopen, and unchanged NUT-04/NUT-03.
- **Real mint** (`npm run verify:pol-melt -- <db>`): mints 1000 sat, then melts to a real invoice with change. It checks the consumed and issued rows, their epochs, the receipts signed immediately and verified through the retrieval endpoint, and NUT-07 SPENT. It checks that outstanding moves by exactly `1000 − (inputs − change)`. It checks that a melt to an already-paid invoice fails with no accounting and its inputs stay UNSPENT, that melting spent inputs is refused, and that the closed epoch re-derives. The output is `nut05-melt.json`, which contains only public values.
- **CI** runs it over real LND: LND-1 pays an invoice on LND-2, and the destination invoice must be SETTLED.
