# CDK v0.18.1 integration seams — Phase 2 Step 1 audit

Real source audit of the exact pinned CDK release used by `.github/workflows/real-cashu-integration.yml`. Not guessed: cloned directly from upstream at the pinned tag and read.

- **Upstream repository**: `github.com/cashubtc/cdk`
- **Pinned tag**: `v0.18.1`
- **Exact upstream commit**: `a056e0f0f69e94f431b1aeb90d883f18c61ea4c6`
- **Date retrieved**: 2026-09-23

This document traces the real execution path for NUT-04/NUT-03/NUT-05, the database transaction/signing architecture, and what extension points CDK actually exposes — as a prerequisite for Phase 2 Step 2's integration-architecture decision. All file paths below are relative to the CDK repo root at the pinned commit.

## Crate layout relevant to Phase 2

| Crate | Role |
| --- | --- |
| `crates/cdk-common` | Shared types + the **public, pluggable** database trait definitions (`database::mint::{Database, Transaction, DbTransactionFinalizer}`) |
| `crates/cdk` | Core mint/wallet logic — `Mint`, `MintBuilder`, NUT-04/03/05 orchestration, the signatory client |
| `crates/cdk-signatory` | Signing — holds/uses the mint's amount private keys |
| `crates/cdk-sql-common` | Shared SQL schema/migrations (SQLite + Postgres variants), query implementations |
| `crates/cdk-sqlite` | Concrete SQLite `Database` implementation (what `cdk-mintd --work-dir` actually uses) |
| `crates/cdk-postgres`, `crates/cdk-redb` | Alternative concrete `Database` implementations — proof the trait is genuinely pluggable, not SQLite-specific |
| `crates/cdk-axum` | HTTP layer (`/v1/mint/...`, `/v1/swap`, `/v1/melt/...`) — thin, calls straight into `cdk::Mint` methods |
| `crates/cdk-mintd` | The batteries-included binary Phase 1 downloads prebuilt — wires a fixed `cdk-sqlite`/`cdk-postgres` database and `cdk-axum` router together from a TOML/DB-backed config |

## NUT-04 (mint/issue) — `crates/cdk/src/mint/issue/mod.rs`

HTTP: `cdk-axum`'s router (`router_handlers.rs`) → `Mint::get_mint_quote()` (quote creation) and `Mint::process_mint_request()` (issuance).

`process_mint_request()` (`issue/mod.rs:677-1049`) is the authoritative issuance path:

1. Validate input structure, quote state, amounts, NUT-20 signature (`issue/mod.rs:681-923`) — all pure/read-only, no lock held yet.
2. **`self.blind_sign(input.outputs().to_vec())`** (`issue/mod.rs:926`) — signing happens *outside* any database transaction. Stateless BDHKE signing against the mint's amount keys via the signatory.
3. **`let mut tx = self.localstore.begin_transaction().await?;`** (`issue/mod.rs:934`) — the single authoritative transaction begins.
4. Inside `tx`: `tx.get_mint_quotes_by_ids(...)` (row-locking re-validation), `tx.add_blinded_messages(...)`, `tx.add_blind_signatures(...)`, `mint_quote.add_issuance(...)` + `tx.update_mint_quote(...)`, `tx.add_completed_operation(...)`.
5. **`tx.commit().await?;`** (`issue/mod.rs:1011`) — the real economic commit. Everything before this line is either read-only or pure computation; everything the mint is durably on the hook for happens between step 3 and this line.
6. *After* commit: pubsub notifications only (`tokio::spawn`, best-effort, fire-and-forget — not a durability mechanism).

**This is the seam**: any accounting write coupled to step 4 (inside the same `tx`, before `tx.commit()`) is genuinely atomic with issuance. Anything hooked after `tx.commit()` (e.g. the pubsub notification, or an HTTP response) is not — a crash there loses nothing CDK itself promised, but would lose a naively-placed SOLVENT accounting write.

## NUT-03 (swap) — `crates/cdk/src/mint/swap/`

`process_swap_request` (`swap/mod.rs:16-77`) is a thin entry point: `verify_inputs()` → `verify_spending_conditions()` → `SwapSaga::new()` → `setup_swap()` → `sign_outputs()` → `finalize()`. The saga (`swap/swap_saga/mod.rs`) is CDK's own answer to "signing happens outside the DB transaction, so what if it fails after we've locked inputs" — a real, already-shipped crash-consistency mechanism, not something Phase 2 needed to build.

### NUT-03 transaction map (Phase 2 continuation — exact source trace, not guessed)

1. **`setup_swap()`** (`swap_saga/mod.rs:143-264`, TX1) — `verify_outputs()`, `verify_transaction_balanced()` (calls `get_proofs_fee()`, asserts `input_amount == output_amount + fee_breakdown.total` — the exact CDK-defined conservation equation), builds `Operation::new(operation_id, OperationKind::Swap, total_issued, total_redeemed, fee, None, None)`, opens `tx` (line 182):
   - `tx.add_proofs(input_proofs, quote_id, &operation)` (`cdk-sql-common/src/mint/proofs.rs:129-188`) — `INSERT INTO proof (..., state, operation_kind, operation_id) VALUES (..., 'UNSPENT', :operation_kind, :operation_id)`. **`operation_kind`/`operation_id` are set here, at insertion, from the real `Operation` — not re-derived later.**
   - `Mint::update_proofs_state(&mut tx, &mut new_proofs, State::Pending)` (`cdk/src/mint/proofs.rs:21-39`, after `check_state_transition` validates Unspent→Pending) → `cdk-sql-common/src/mint/proofs.rs:202-236`: `UPDATE proof SET state = 'PENDING' WHERE y IN (:ys)`.
   - `tx.add_blinded_messages(quote_id, blinded_messages, &operation)` (`cdk-sql-common/src/mint/quotes.rs:697-750`) — `INSERT INTO blind_signature (..., c, ..., operation_kind, operation_id, ...) VALUES (..., NULL, ..., :operation_kind, :operation_id, ...)`. Same real-`Operation`-at-insertion pattern.
   - `tx.add_saga(&saga)` — persists CDK's **own** real saga-recovery record (`Saga::new_swap(operation_id, SwapSagaState::SetupComplete)`).
   - **`tx.commit()`** (line 238). Inputs are now durably PENDING; outputs durably present with `c = NULL`; a saga row exists recording this exact state.
2. **`sign_outputs()`** (`swap_saga/mod.rs`, patched by `patches/cdk/0006-*.patch`) — `self.mint.blind_sign(blinded_messages)`, stateless, no transaction (identical property to NUT-04's `blind_sign` call). **Phase 2 continuation addition**: immediately after, for each output, `self.mint.sign_pol_receipt(keyset_id, amount, message)` — also stateless, no transaction, mirroring NUT-04's issue path exactly. Failure at either step runs `compensate_all()` before returning the error.
3. **`finalize()`** (`swap_saga/mod.rs`, TX2) — opens a **second** `tx`:
   - `tx.add_blind_signatures(&blinded_secrets, &signatures, None)` (`cdk-sql-common/src/mint/signatures.rs:53-...`) — `UPDATE blind_signature SET c = :c, ... WHERE blinded_message = :blinded_message` (the row already exists from step 1, `c` was NULL). **This UPDATE is the exact same real write NUT-04 uses, and fires the existing `solvent_issued_liability_on_update` trigger (`migrations/solvent-accounting/0001_nut04_issued_liability.sql`) automatically — no new trigger needed, confirmed by tracing that `operation_kind` was already set to `'swap'` at step 1's INSERT and is never overwritten by this UPDATE.**
   - **Phase 2 continuation addition**: `tx.record_pol_receipt_signature(blinded_message, signature_hex)` per output, immediately after — writes the receipt's `pending`→`signed` transition inside this same transaction, mirroring NUT-04.
   - `tx.get_proofs(&ys)`, then `Mint::update_proofs_state(&mut tx, &mut proofs, State::Spent)` (after `check_state_transition` validates Pending→Spent) → `UPDATE proof SET state = 'SPENT' WHERE y IN (:ys)`. **This is the authoritative consumed-liability event** — fires the new `solvent_consumed_liability_on_spent` trigger (`migrations/solvent-accounting/0002_nut03_consumed_liability.sql`).
   - `tx.add_completed_operation(&operation, &fee_breakdown.per_keyset)`.
   - `tx.delete_saga(&operation_id)` — best-effort; a failure here is logged, not fatal, and does not roll back the swap (see recovery below).
   - **`tx.commit()`**. This single commit is the swap-equivalent of NUT-04's single commit: consumed-liability, new issued-liability, and the signed receipt all land in it together.
4. **`compensate_all()`** (`swap_saga/mod.rs`) — runs `RemoveSwapSetup::execute()` (`swap_saga/compensation.rs:34-77`) if signing or finalize fails: `tx.delete_blinded_messages(blinded_secrets)` (matches rows where `c IS NULL` — safe, since a signed row would never match), `tx.remove_proofs(input_ys, None)` (deletes the proof rows outright, excluding any already SPENT), `tx.delete_saga(operation_id)`, all in one transaction. Because the SOLVENT triggers only fire on `c` transitioning non-NULL or `state` transitioning to `SPENT`, and compensation runs *before* either happens, **no SOLVENT accounting row is ever created for a compensated swap** — confirmed by tracing the trigger conditions against this exact code path, not assumed.

### Real, already-shipped swap-saga crash recovery — `Mint::recover_from_incomplete_sagas()`

`crates/cdk/src/mint/start_up_check.rs:251-397`, called from `Mint::start()` (`crates/cdk/src/mint/mod.rs:449`) — i.e. it runs automatically on every real `cdk-mintd` startup, at the exact same call site SOLVENT's own `recover_pending_pol_receipts()` hooks into (`patches/cdk/0004-*.patch`). For every saga row still present for `OperationKind::Swap`:
- Looks up `input_ys`/`blinded_secrets` by `operation_id` (via `get_proof_ys_by_operation_id`/`get_blinded_secrets_by_operation_id`).
- If the inputs are **not** all `Spent`: `Compensate` — runs the identical `RemoveSwapSetup` used by in-process failure, restoring pre-swap state. This is the real, existing answer to "the mint crashed after `setup_swap()`'s TX1 committed but before `finalize()`'s TX2 committed."
- If the inputs **are** all `Spent` and the outputs are **all** signed: the swap actually finished; only the best-effort `delete_saga` inside `finalize()`'s TX2 failed to remove the row. Recovery deletes the now-orphaned saga row and does **not** touch the (already-correct) economic state.
- If inputs are `Spent` but outputs are **not** all signed: CDK's own code logs this as requiring manual intervention and explicitly skips both compensation and cleanup — a state its own author considered anomalous enough not to auto-resolve. Documented here, not silently assumed impossible.

### Real, already-shipped response-loss recovery — NUT-09 `POST /v1/restore`

`crates/cdk-axum/src/lib.rs:110`, `router_handlers.rs::post_restore` → `Mint::restore(RestoreRequest { outputs })`. A wallet that lost the swap's HTTP response (but not the transaction — the swap committed) can resubmit the exact same blinded outputs and receive back the exact same real signatures, already durable in `blind_signature`. Phase 2's Step 16 uses this real, existing mechanism rather than inventing a new one — see `docs/receipt-lifecycle.md`'s NUT-03 section for the real end-to-end proof, and note that the receipt-retrieval endpoint (`patches/cdk/0005-*.patch`) already works unmodified here too, since it is keyed by the same public blinded-message value the restore response also returns.

**This is the seam**: `finalize()`'s transaction is the swap-equivalent of NUT-04's single commit — consumed-liability (input proofs SPENT), new issued-liability (replacement blind signatures), and the signed receipt all land in that one `tx.commit()`. Unlike NUT-04, this seam is additionally protected by two real, pre-existing CDK crash-recovery mechanisms (`recover_from_incomplete_sagas()` and NUT-09 restore) that Phase 2 did not need to build.

## NUT-05 (melt) — `crates/cdk/src/mint/melt/`

Substantially more complex than mint/swap because it drives a real, possibly slow, possibly ambiguous Lightning payment. `melt()` (`melt/mod.rs:879`) also delegates to a saga (`melt/melt_saga/mod.rs`) with **five** separate transactions across the lifecycle, not one:

1. **`setup_melt()`** (`melt_saga/mod.rs:203-407`, commit at 407) — locks/reserves input proofs as pending, same idea as swap's `setup_swap()`.
2. **`make_payment()`** (line 677) → **`attempt_internal_settlement()`** (opens/commits its own `tx` at 501/617, for mint-to-mint melts) or **`attempt_external_payment()`** (opens/commits at 775/785, for the real Lightning payment via the configured backend — `lnd` in Phase 1's case). This is where the real, possibly-slow, possibly-failing external payment attempt happens.
3. **`persist_external_payment_state()`** (commit at 1039) / **`persist_paid_payment()`** (commit at 1092) — record the payment outcome (paid/failed/ambiguous) durably before proceeding.
4. **`finalize()`** (`melt_saga/mod.rs:1174-1213`, commit at 1213) — the authoritative terminal commit: input proofs become SPENT, any returned change is signed and added as new blind signatures, fees are reconciled.
5. **`compensate_all()`** (line 1298) — rollback path if the saga fails before reaching `finalize()`.

**This is the seam, but it is genuinely multi-step**: unlike NUT-04/03, a melt has real durable intermediate states (`pending`, `payment in flight`, `ambiguous`) that already exist as CDK's own saga states before Phase 2 adds anything. Phase 2's accounting must treat `finalize()`'s commit as the point where consumed/issued liability becomes real, and must not treat `setup_melt()`'s commit (input proofs merely *pending*) as a consumed liability — a failed/ambiguous payment can still resolve back to unspent. This directly informs `INVARIANTS.md`'s P2-I5 ("a failed melt does not finalize a consumed liability").

## The database trait layer — `crates/cdk-common/src/database/mint/mod.rs`

This is the finding that determines Phase 2's integration architecture. The traits are **public** and **already CDK's own supported extension point** — not an internal implementation detail:

```rust
// mod.rs:696-707
pub trait Database<Error>:
    KVStoreDatabase<Err = Error> + QuotesDatabase<Err = Error> + ProofsDatabase<Err = Error>
    + SignaturesDatabase<Err = Error> + SagaDatabase<Err = Error> + CompletedOperationsDatabase<Err = Error>
{
    async fn begin_transaction(&self) -> Result<Box<dyn Transaction<Error> + Send + Sync>, Error>;
}
pub type DynMintDatabase = std::sync::Arc<dyn Database<Error> + Send + Sync>;
```

```rust
// mod.rs:676-687
pub trait Transaction<Error>:
    DbTransactionFinalizer<Err = Error> + QuotesTransaction<Err = Error> + SignaturesTransaction<Err = Error>
    + ProofsTransaction<Err = Error> + KVStoreTransaction<Error> + SagaTransaction<Err = Error>
    + CompletedOperationsTransaction<Err = Error>
{ ... }
```

```rust
// database/mod.rs:238-247
pub trait DbTransactionFinalizer {
    type Err: Into<Error> + From<Error>;
    async fn commit(self: Box<Self>) -> Result<(), Self::Err>;
    async fn rollback(self: Box<Self>) -> Result<(), Self::Err>;
}
```

`MintBuilder::new(db: DynMintDatabase)` (confirmed in `crates/cdk/src/mint/issue/mod.rs`'s own test helpers, e.g. `Arc::new(cdk_sqlite::mint::memory::empty().await.unwrap())` passed straight into `MintBuilder::new(db.clone())`) accepts **any** implementation of this trait. `cdk-sqlite`, `cdk-postgres`, and `cdk-redb` are three independent, real implementations of the exact same public trait — proof this is a genuine, already-exercised plugin point, not something that only happens to be theoretically possible.

**What this rules out**: a same-Rust-object decorator (a struct implementing `Database`/`Transaction` that wraps a real `cdk-sqlite` instance and adds extra calls around `commit()`) *can* observe every mutating call and *can* choose to fail the whole operation, but it cannot make its own writes part of the **same underlying SQL transaction** as `cdk-sqlite`'s, because `cdk-sqlite`'s concrete `Transaction` implementation owns its own opaque `sqlx` connection/transaction handle that a decorator sitting at the trait-object level has no access to. A decorator gets "coupled at the Rust call boundary" (can refuse to let CDK's commit succeed if SOLVENT's own write fails first), not "coupled at the single-SQL-COMMIT level."

**What actually achieves single-SQL-COMMIT atomicity, with zero CDK source changes**: `cdk-mintd --work-dir <dir>` with `[database] engine = "sqlite"` puts the mint's entire durable state in one SQLite file. SQLite triggers execute *inside the firing statement's own transaction* — this is a normal, well-supported SQLite guarantee, not a CDK-specific behavior. A `CREATE TRIGGER ... AFTER INSERT ON blind_signature BEGIN INSERT INTO solvent_issued_liability ... END;` fires as part of the exact same transaction `finalize()`/`process_mint_request()` already commits — no Rust code changes, no patch, no fork, no custom binary. This is real same-transaction atomicity achieved entirely in SQL, applied to CDK's own unmodified sqlite file as a one-time migration step.

## Schema — `crates/cdk-sql-common/src/mint/migrations/sqlite/`

The schema has evolved across **30+** incremental migrations (initial creation through renames, the saga-support migration, completed-operations, etc. — the most recent in this history dated as late as 2026-04). The relevant tables by name, confirmed to exist via migration filenames (`20250924215800_migrate_blinded_messages_to_blind_signatures.sql`, `20251010144317_add_saga_support.sql`, `20251119000000_add_completed_operations.sql`, `20250822104351_rename_blind_message_y_to_b.sql`): `blind_signature`, `proof`, `mint_quote`, `melt_quote`, `keyset`, `saga`, `completed_operation`.

**Not yet extracted**: the exact final column set of each table after all 30+ migrations are applied — composing that by hand from incremental `ALTER TABLE` diffs risks a transcription error. The reliable way to get it is `sqlite3 <mint.db> ".schema"` against a real mint database produced by the pinned `cdk-mintd` (i.e., run the Phase 1 stack once, then inspect `/tmp/regtest/mint/*.sqlite` before it's torn down) — this is Phase 2 Step 2/Step 7's first concrete implementation task, not guessed here.

## Signatory — `crates/cdk-signatory`

Not yet audited in depth (deferred to Phase 2 Step 9, "receipt signing inside the mint"). Confirmed to exist as its own crate, separating signing from the mint's HTTP/database logic — consistent with `process_mint_request()`'s `blind_sign()` call being a method on `Mint` that delegates to a signatory client rather than touching key material directly in `issue/mod.rs`. Full trace of the signatory boundary (in-process vs. RPC-separated signing, where exactly the amount private keys live) is required reading before Step 9's receipt-signing design and is explicitly **not yet done** — recorded here so it isn't silently skipped.

## Existing event/notification mechanism — `crates/cdk/src/event.rs`

CDK has a pub/sub notification system (NUT-17 WebSocket subscriptions: `MintEvent<T>`, `pubsub_manager.publish(...)`) used to push quote/proof-state updates to connected WebSocket clients. This is **not** a durable outbox — it's an in-memory, best-effort, post-commit broadcast (see `issue/mod.rs`'s `tokio::spawn` after `tx.commit()`). It answers "notify anyone currently listening," not "guarantee this event is eventually processed exactly once." Confirmed unsuitable as Phase 2's accounting coupling mechanism for that reason — recorded here so the (reasonable) question "doesn't CDK already have an event system?" has an honest, sourced answer: yes, but it solves a different problem.

## Conclusion feeding Step 2

No CDK source patch and no fork are required for same-transaction atomicity. The narrowest safe integration seam is a **SQL migration adding SOLVENT-owned tables and triggers directly to the same SQLite database file `cdk-mintd` already manages** — triggers on `blind_signature` (issued liability) and `proof` state transitions (consumed liability), firing inside CDK's own existing transactions. This uses CDK entirely unmodified, requires no custom Rust binary, and is fully reproducible from a clean checkout as a `.sql` file applied once after `cdk-mintd ... config init`. See `DECISIONS.md`'s Phase 2 Step 2 entry for the formal decision record.
