# Accounting model — Phase 2 durable SOLVENT journal

Schema and migration for SOLVENT's mint-native accounting, coupled to CDK's own SQLite database via triggers (`docs/cdk-integration-seams.md`, `DECISIONS.md`'s Phase 2 Step 2 entry) and to CDK's signatory via a minimal trait extension (`docs/cdk-signatory-audit.md`, Step 8C). First milestone: **NUT-04** (Phase 2 Step 8, complete). Second milestone: **NUT-03** (this continuation) — `solvent_consumed_liability` is now populated by a real trigger (`migrations/solvent-accounting/0002_nut03_consumed_liability.sql`); melt-specific population remains deferred, per the explicit instruction not to start NUT-05 yet.

## Where this lives

All three SOLVENT tables below are created in the **same SQLite file** `cdk-mintd --work-dir` already manages — not a separate database. This is what makes trigger-based atomicity possible (SQLite triggers only run inside the transaction of the statement that fired them, on tables in the same database connection/file).

## CDK's real schema — confirmed, not guessed

Extracted by actually building `cdk-sqlite` from the pinned `v0.18.1` source (a local Rust harness — `cdk_sqlite::mint::MintSqliteDatabase::new(path)` — constructing a real, fully-migrated file-backed database, then reading `sqlite_master`) rather than composed by hand from the 47 incremental SQLite migrations in `crates/cdk-sql-common/src/mint/migrations/sqlite/`. Full dump kept as evidence at `evidence/real-pol/cdk-schema-v0.18.1.sql` (see that file for all 14 tables). The two tables Step 7's NUT-04 triggers touch:

```sql
CREATE TABLE "blind_signature" (
    blinded_message BLOB PRIMARY KEY,   -- this IS B_, the draft's issued-liability leaf input — not a separate id column
    amount INTEGER NOT NULL,
    keyset_id TEXT NOT NULL,
    c BLOB NULL,                        -- the real blind signature C_ — NULL until actually signed
    dleq_e TEXT,
    dleq_s TEXT,
    quote_id TEXT,
    created_time INTEGER NOT NULL DEFAULT 0,
    signed_time INTEGER,
    operation_kind TEXT,
    operation_id TEXT,                  -- FK-equivalent to completed_operations.operation_id
    order_index INTEGER DEFAULT 0
)

CREATE TABLE completed_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    operation_kind TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    total_issued INTEGER NOT NULL,
    total_redeemed INTEGER NOT NULL,
    fee_collected INTEGER NOT NULL,
    payment_amount INTEGER,
    payment_fee INTEGER,
    payment_method TEXT
)
```

**Critical real-source finding, not assumed**: `add_blinded_messages()` (`crates/cdk-sql-common/src/mint/quotes.rs:697`) does `INSERT INTO blind_signature (..., c, ...) VALUES (..., NULL, ...)`. `add_blind_signatures()` (`crates/cdk-sql-common/src/mint/signatures.rs:53`) then either does a fresh `INSERT` with `c` already populated (only when no row exists yet — the batch-mint path) **or** an `UPDATE blind_signature SET c = ..., dleq_e = ..., dleq_s = ..., signed_time = ... WHERE blinded_message = ...` (when a `c IS NULL` row already exists — this is the path `process_mint_request()` actually takes for a normal, single-quote NUT-04 mint, since it calls `add_blinded_messages()` then `add_blind_signatures()` in that order). **This means the real "this became a genuinely signed liability" event, for the exact operation Phase 1's `real-cashu-foundation.ts` exercises, is an `UPDATE` of `c` from `NULL` to non-`NULL` — not the initial `INSERT`.** A trigger firing only on `AFTER INSERT ... WHEN NEW.c IS NOT NULL` would silently miss every real single-quote mint. Two triggers are required to cover both real code paths — see Step 7's migration file.

## SOLVENT-owned tables

### `solvent_issued_liability`

One row per Cashu output that became a real, mint-signed liability — NUT-04 issuance and NUT-03 swap replacement outputs now (the same trigger captures both, since both flow through CDK's real `add_blind_signatures()` write — see `docs/cdk-integration-seams.md`'s NUT-03 transaction map); NUT-05 melt change outputs later.

```sql
CREATE TABLE solvent_issued_liability (
    id                      TEXT PRIMARY KEY,      -- SOLVENT-generated UUID
    blinded_message_hex     TEXT NOT NULL,          -- hex of blind_signature.blinded_message (B_) — the real CDK row this came from
    operation_id            TEXT,                    -- blind_signature.operation_id, when present — FK-equivalent to completed_operations
    operation_kind          TEXT NOT NULL CHECK (operation_kind IN ('mint', 'swap', 'melt', 'batch_mint')),
    keyset_id               TEXT NOT NULL,
    amount                  INTEGER NOT NULL CHECK (amount > 0),
    signature_c_hex         TEXT NOT NULL,          -- hex of blind_signature.c (C_) — auxiliary evidence, not the leaf-hash input
    sequence                INTEGER PRIMARY KEY AUTOINCREMENT REFERENCES solvent_issued_liability(id), -- see note below; real column is a separate INTEGER
    epoch_id                TEXT,                   -- NULL until Phase 3 assigns it
    created_at              INTEGER NOT NULL,       -- unix time, set by the trigger — real commit time, not client-reported
    UNIQUE (blinded_message_hex)                     -- idempotency: one accounting row per CDK blind_signature row, ever
);
CREATE INDEX idx_issued_liability_keyset ON solvent_issued_liability(keyset_id);
```

(SQLite only allows one `INTEGER PRIMARY KEY AUTOINCREMENT` per table and it must be the table's actual rowid alias — the migration file's real DDL uses a separate integer `id` as that autoincrement rowid and a `TEXT` `uuid` column for the idempotency-facing identifier; written informally above for readability, exact DDL is the migration file, not this prose.)

**Real bug found and fixed by the first real CI reconciliation run**: the trigger's first version hardcoded the literal string `'mint'` for every row's `operation_kind`, instead of reading the real `NEW.operation_kind` value CDK's own `blind_signature` row already carries. Real CI caught this immediately and correctly: a single real lifecycle run (mint 1000 sat, swap 1000 sat, melt with ~100 sat change) produced 15 issued-liability rows totalling 2100 sats against a real mint of only 1000 — because the swap's replacement outputs and the melt's change outputs were being mislabeled as `'mint'` too. `crates/cdk-common/src/mint.rs`'s `impl fmt::Display for OperationKind` confirms the real values are `"mint"`, `"swap"`, `"melt"`, `"batch_mint"` — not the guessed `"melt_change"`. Fixed by using `COALESCE(NEW.operation_kind, 'mint')` in both triggers, verified locally against a simulated mint+swap+melt sequence before re-running real CI.

### `solvent_consumed_liability` (populated for NUT-03; NUT-05 population still deferred)

```sql
CREATE TABLE solvent_consumed_liability (
    id                  TEXT PRIMARY KEY,
    proof_y_hex         TEXT NOT NULL,          -- hex of proof.y — the draft's consumed-liability leaf input, and CDK's own NUT-07 lookup key
    operation_id        TEXT,
    operation_kind      TEXT NOT NULL CHECK (operation_kind IN ('swap', 'melt')),
    keyset_id           TEXT NOT NULL,
    amount              INTEGER NOT NULL CHECK (amount > 0),
    epoch_id            TEXT,
    created_at          INTEGER NOT NULL,
    UNIQUE (proof_y_hex)
);
CREATE INDEX idx_consumed_liability_keyset ON solvent_consumed_liability(keyset_id);
```

Real CDK reference confirmed: `proof` table's primary key is `y BLOB PRIMARY KEY` (`crates/cdk-sql-common`'s migrated schema), with a `state` column constrained to `('SPENT', 'PENDING', 'UNSPENT', 'RESERVED', 'UNKNOWN')`. The consumed-liability trigger (`migrations/solvent-accounting/0002_nut03_consumed_liability.sql`) fires on any transition into `SPENT` (not narrowed to `PENDING`→`SPENT`, since `Unspent`→`Spent` is also a real, valid CDK transition — `crates/cdk-common/src/state.rs`), gated to `operation_kind IN ('swap', 'melt')` so it stays inert for melt until that population is actually built.

### `solvent_pol_receipt`

The durable record of each receipt's signing obligation and, once signed, its signature (`docs/cdk-signatory-audit.md`'s "atomicity question, answered"; `docs/receipt-lifecycle.md` for the real same-transaction signing path and the startup recovery scan that handles the residual case). One row per issued or consumed liability that needs a signed PoL receipt — currently populated for issued liabilities only (NUT-04 and NUT-03 replacement outputs); consumed-liability receipts are out of scope for this milestone (`docs/pol-extension.md`).

```sql
CREATE TABLE solvent_pol_receipt (
    id                  TEXT PRIMARY KEY,
    liability_kind      TEXT NOT NULL CHECK (liability_kind IN ('issued', 'consumed')),
    liability_id        TEXT NOT NULL,          -- references solvent_issued_liability.id or solvent_consumed_liability.id (no cross-table FK in SQLite; the trigger that inserts it also fixes this reference)
    keyset_id           TEXT NOT NULL,
    amount              INTEGER NOT NULL,
    message             BLOB NOT NULL,          -- the exact draft receipt message bytes, fixed at insert time
    status               TEXT NOT NULL CHECK (status IN ('pending', 'signed', 'failed')) DEFAULT 'pending',
    signature_hex        TEXT,                   -- NULL until status = 'signed'
    attempts             INTEGER NOT NULL DEFAULT 0,
    created_at            INTEGER NOT NULL,
    signed_at             INTEGER,
    UNIQUE (liability_kind, liability_id)
);
CREATE INDEX idx_pol_receipt_status ON solvent_pol_receipt(status);
```

## Triggers — NUT-04 scope (Step 7)

Two triggers, both covering the real, confirmed CDK write paths above:

1. `AFTER INSERT ON blind_signature WHEN NEW.c IS NOT NULL` — covers the batch-mint / already-signed-on-insert path.
2. `AFTER UPDATE OF c ON blind_signature WHEN NEW.c IS NOT NULL AND OLD.c IS NULL` — covers the normal single-quote NUT-04 path, which is what `npm run verify:cashu-real` actually exercises.

Both bodies insert one `solvent_issued_liability` row and one `solvent_pol_receipt` row (`status = 'pending'`), in the same transaction as the firing statement. Exact `CREATE TRIGGER` SQL lives in the migration file (`migrations/solvent-accounting/0001_nut04_issued_liability.sql`) rather than duplicated here, so this document and the executable migration cannot silently drift apart.

**Honest gap, surfaced rather than papered over**: the draft's exact receipt message is `"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch` (`docs/draft-alignment.md`). `target_epoch` refers to a closed accounting epoch — epoch closure is explicitly Phase 3's job (`DECISIONS.md`'s "Why SOLVENT is not yet connected" entry), not implemented in Phase 2. Rather than silently invent an epoch value or silently drop the field (both forbidden by Phase 2 Step 4), Phase 2 makes an explicit, named convention: **all Phase 2 activity is treated as epoch `0`**, a single implicit, never-closed epoch, until Phase 3 adds real epoch closure. Every receipt's `target_epoch` is literally the string `0` under this convention, and `epoch_id` stays `NULL` in the liability tables (meaning "not yet assigned to a closed epoch," which epoch `0` — perpetually open — trivially satisfies). This makes the receipt's message format genuinely draft-compliant byte-for-byte today, while being explicit that Phase 2 has not implemented multi-epoch accounting.

## Constraints and idempotency, explained

- **`UNIQUE (blinded_message_hex)`** is P2-I1/P2-I9's enforcement mechanism: even if the two triggers above ever both matched the same row (they structurally cannot — `NEW.c IS NOT NULL` on `INSERT` vs. `OLD.c IS NULL` on `UPDATE` are mutually exclusive for a single row's lifetime), the second insert fails rather than duplicating the liability.
- **No accounting row without a real CDK commit** (P2-I2) is structural, not a runtime check: the trigger's body is entirely inside the `INSERT`/`UPDATE` statement that only exists if that statement is part of a transaction that reaches `COMMIT`; a rolled-back transaction rolls the trigger's writes back with it, same as any other write in that transaction.
- **The rowid-based autoincrement sequence** gives P2-I9/committed-order a real, queryable total order independent of wall-clock time (which can repeat or go backward under NTP adjustment); reconciliation (`npm run verify:pol-ledger`, not yet built) sums in this order, not by `created_at`.

## What is intentionally excluded

Per Phase 2 Step 6/17: no wallet identity, no receiver identity, no raw proof secret (only its hash-derived `Y`, which CDK already treats as public/queryable via NUT-07), no IP address, no unrelated quote metadata. Full privacy reasoning is `docs/privacy.md`'s job — this schema is designed to make that audit easy, not to substitute for it.
