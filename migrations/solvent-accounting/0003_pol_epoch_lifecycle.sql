-- SOLVENT Phase 3A — real Proof-of-Liabilities epoch lifecycle, applied to
-- the SAME SQLite file cdk-mintd already manages. Apply after 0001 and 0002,
-- on a mint that has not yet issued anything, and before starting the
-- daemon:
--   sqlite3 <work-dir>/cdk-mintd.sqlite < migrations/solvent-accounting/0003_pol_epoch_lifecycle.sql
-- (run it with `sqlite3 -bail`: the guard below deliberately fails the
-- script on a mint that already holds liabilities.)
--
-- Replaces Phase 2's hardcoded `target_epoch = 0` with a real, database-
-- assigned epoch. Full model, race analysis and state machine:
-- docs/epoch-lifecycle.md.
--
-- Semantics, in one paragraph: exactly one PoL epoch is OPEN per mint at any
-- time (epoch indices are global across keysets, as the draft's
-- global_digest requires). Every issued/consumed liability row is stamped,
-- inside CDK's own write transaction, with the index of the epoch that is
-- OPEN at that instant, and its PoL receipt message is built from that same
-- index. Closing epoch N (src/epoch/closer.ts) is one BEGIN IMMEDIATE
-- transaction that writes N's signed per-keyset manifests, flips N to
-- CLOSED and opens N+1. CDK's own SQLite transactions are also BEGIN
-- IMMEDIATE (crates/cdk-sqlite/src/async_sqlite.rs), so a liability write
-- and a close can never interleave: a liability either commits before the
-- close (and the close sees and commits it) or after (and is stamped N+1).
-- A receipt therefore can never promise an epoch that is already closed —
-- and the BEFORE INSERT guards below make that a database invariant, not
-- just a consequence of ordering.
--
-- NOTE: CDK's own `keyset_epoch` table is an unrelated keyset-configuration
-- version counter. SOLVENT's tables are deliberately named `solvent_pol_*`.

-- Guard: this migration defines epoch semantics from the mint's first
-- issuance. A database that already holds liabilities stamped under the
-- Phase 2 epoch-0 placeholder would carry receipts no epoch can honour.
CREATE TEMP TABLE solvent_migration_0003_guard (existing_liabilities INTEGER CHECK (existing_liabilities = 0));
INSERT INTO solvent_migration_0003_guard
    SELECT (SELECT count(*) FROM solvent_issued_liability) + (SELECT count(*) FROM solvent_consumed_liability);
DROP TABLE solvent_migration_0003_guard;

-- Phase 2's never-populated TEXT placeholder is replaced by a typed column.
ALTER TABLE solvent_issued_liability DROP COLUMN epoch_id;
ALTER TABLE solvent_consumed_liability DROP COLUMN epoch_id;
ALTER TABLE solvent_issued_liability ADD COLUMN target_epoch INTEGER;
ALTER TABLE solvent_consumed_liability ADD COLUMN target_epoch INTEGER;
CREATE INDEX idx_issued_liability_epoch ON solvent_issued_liability(keyset_id, target_epoch, seq);
CREATE INDEX idx_consumed_liability_epoch ON solvent_consumed_liability(keyset_id, target_epoch, seq);

CREATE TABLE solvent_pol_epoch (
    epoch_index             INTEGER PRIMARY KEY CHECK (epoch_index >= 1),
    state                   TEXT NOT NULL CHECK (state IN ('OPEN', 'CLOSED')),
    opened_at               INTEGER NOT NULL,
    closed_at               INTEGER,
    -- Populated exactly when CLOSED (enforced by the CHECK below).
    manifest_timestamp      TEXT,
    previous_global_digest  TEXT,
    global_digest           TEXT,
    keyset_count            INTEGER,
    manifest_pubkey         TEXT,
    CHECK (
        (state = 'OPEN' AND closed_at IS NULL AND manifest_timestamp IS NULL AND previous_global_digest IS NULL
            AND global_digest IS NULL AND keyset_count IS NULL AND manifest_pubkey IS NULL)
        OR
        (state = 'CLOSED' AND closed_at IS NOT NULL AND manifest_timestamp IS NOT NULL AND previous_global_digest IS NOT NULL
            AND global_digest IS NOT NULL AND keyset_count >= 1 AND manifest_pubkey IS NOT NULL)
    )
);
CREATE UNIQUE INDEX solvent_pol_epoch_single_open ON solvent_pol_epoch(state) WHERE state = 'OPEN';

-- One signed manifest per keyset per closed epoch (the draft's per-keyset
-- manifest). Commitments only: the liability rows remain the source of
-- truth, and src/epoch/closer.ts re-derives these roots from them.
CREATE TABLE solvent_pol_epoch_keyset (
    epoch_index             INTEGER NOT NULL REFERENCES solvent_pol_epoch(epoch_index),
    keyset_id               TEXT NOT NULL,
    unit                    TEXT NOT NULL,
    issued_mmr_size         INTEGER NOT NULL,
    issued_mmr_root_hash    TEXT NOT NULL,
    issued_mmr_root_sum     INTEGER NOT NULL,
    spent_mmr_size          INTEGER NOT NULL,
    spent_mmr_root_hash     TEXT NOT NULL,
    spent_mmr_root_sum      INTEGER NOT NULL,
    outstanding_balance     INTEGER NOT NULL CHECK (outstanding_balance = issued_mmr_root_sum - spent_mmr_root_sum),
    active                  INTEGER NOT NULL CHECK (active IN (0, 1)),
    deactivation_epoch      INTEGER NOT NULL,
    manifest_digest         TEXT NOT NULL,
    manifest_signature      TEXT NOT NULL,
    PRIMARY KEY (epoch_index, keyset_id)
);

-- Operator-side record of the explicit, opt-in broken-promise demo mode
-- (SOLVENT_OMIT_PROMISED_ISSUANCE — see docs/epoch-lifecycle.md). Never
-- written unless an operator deliberately requests an omission. It is what
-- keeps an omitted issuance omitted from every later epoch too, so the
-- adversarial mint's issued sum-MMR stays append-only consistent — the
-- attack is a consistent lie, not a detectable rewrite. Not published.
CREATE TABLE solvent_pol_epoch_omission (
    liability_id        TEXT PRIMARY KEY REFERENCES solvent_issued_liability(id),
    omitted_from_epoch  INTEGER NOT NULL REFERENCES solvent_pol_epoch(epoch_index),
    recorded_at         INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- Epoch state machine invariants
-- ---------------------------------------------------------------------------

-- New epochs are only ever opened, contiguously (N+1 after N).
CREATE TRIGGER solvent_pol_epoch_insert_guard
BEFORE INSERT ON solvent_pol_epoch
WHEN NEW.state != 'OPEN'
  OR NEW.epoch_index != (SELECT COALESCE(MAX(epoch_index), 0) + 1 FROM solvent_pol_epoch)
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: epochs are only opened, contiguously');
END;

-- A CLOSED epoch is immutable.
CREATE TRIGGER solvent_pol_epoch_closed_immutable
BEFORE UPDATE ON solvent_pol_epoch
WHEN OLD.state = 'CLOSED'
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: a closed epoch is immutable');
END;

-- OPEN -> CLOSED is the only transition, and only once every keyset manifest
-- for the epoch has been written.
CREATE TRIGGER solvent_pol_epoch_close_guard
BEFORE UPDATE ON solvent_pol_epoch
WHEN OLD.state = 'OPEN'
  AND (NEW.state != 'CLOSED'
       OR NEW.epoch_index != OLD.epoch_index
       OR NEW.opened_at != OLD.opened_at
       OR NEW.keyset_count != (SELECT count(*) FROM solvent_pol_epoch_keyset WHERE epoch_index = OLD.epoch_index))
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: an open epoch may only be closed, with all of its keyset manifests');
END;

CREATE TRIGGER solvent_pol_epoch_no_delete
BEFORE DELETE ON solvent_pol_epoch
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: epochs are never deleted');
END;

-- Keyset manifests are written only while their epoch is still OPEN (i.e.
-- inside the closing transaction), and never changed or removed afterwards.
CREATE TRIGGER solvent_pol_epoch_keyset_insert_guard
BEFORE INSERT ON solvent_pol_epoch_keyset
WHEN (SELECT state FROM solvent_pol_epoch WHERE epoch_index = NEW.epoch_index) IS NOT 'OPEN'
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: keyset manifests are only written while closing an open epoch');
END;

CREATE TRIGGER solvent_pol_epoch_keyset_immutable
BEFORE UPDATE ON solvent_pol_epoch_keyset
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: keyset manifests are immutable');
END;

CREATE TRIGGER solvent_pol_epoch_keyset_no_delete
BEFORE DELETE ON solvent_pol_epoch_keyset
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: keyset manifests are never deleted');
END;

CREATE TRIGGER solvent_pol_epoch_omission_immutable
BEFORE UPDATE ON solvent_pol_epoch_omission
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: omission records are immutable');
END;

-- ---------------------------------------------------------------------------
-- Liability rows: stamped with the OPEN epoch, never re-targeted
-- ---------------------------------------------------------------------------

-- Fails CDK's own issuance/swap transaction closed if there is no open epoch
-- to promise — a SOLVENT mint never issues ecash it cannot target.
CREATE TRIGGER solvent_issued_liability_epoch_guard
BEFORE INSERT ON solvent_issued_liability
WHEN NEW.target_epoch IS NULL
  OR NOT EXISTS (SELECT 1 FROM solvent_pol_epoch WHERE epoch_index = NEW.target_epoch AND state = 'OPEN')
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: an issued liability must target the currently open PoL epoch');
END;

CREATE TRIGGER solvent_consumed_liability_epoch_guard
BEFORE INSERT ON solvent_consumed_liability
WHEN NEW.target_epoch IS NULL
  OR NOT EXISTS (SELECT 1 FROM solvent_pol_epoch WHERE epoch_index = NEW.target_epoch AND state = 'OPEN')
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: a consumed liability must target the currently open PoL epoch');
END;

CREATE TRIGGER solvent_issued_liability_epoch_immutable
BEFORE UPDATE ON solvent_issued_liability
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: issued liability rows are immutable');
END;

CREATE TRIGGER solvent_consumed_liability_epoch_immutable
BEFORE UPDATE ON solvent_consumed_liability
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: consumed liability rows are immutable');
END;

-- A receipt's signed message is fixed at creation; only its signing status
-- may change afterwards.
CREATE TRIGGER solvent_pol_receipt_message_immutable
BEFORE UPDATE OF message, liability_kind, liability_id, keyset_id, amount ON solvent_pol_receipt
BEGIN
    SELECT RAISE(ABORT, 'SOLVENT: a PoL receipt message is immutable');
END;

-- ---------------------------------------------------------------------------
-- Phase 2 accounting triggers, re-created to stamp the open epoch
-- ---------------------------------------------------------------------------
-- Identical conditions and CDK write paths to 0001/0002 (see those files for
-- the source trace); the only change is target_epoch, and the receipt
-- message's epoch suffix, now come from solvent_pol_epoch instead of the
-- Phase 2 constant 0.

DROP TRIGGER solvent_issued_liability_on_insert;
DROP TRIGGER solvent_issued_liability_on_update;
DROP TRIGGER solvent_consumed_liability_on_spent;

CREATE TRIGGER solvent_issued_liability_on_insert
AFTER INSERT ON blind_signature
WHEN NEW.c IS NOT NULL
BEGIN
    INSERT INTO solvent_issued_liability
        (id, blinded_message_hex, operation_id, operation_kind, keyset_id, amount, signature_c_hex, target_epoch, created_at)
    VALUES
        (lower(hex(randomblob(16))), lower(hex(NEW.blinded_message)), NEW.operation_id, COALESCE(NEW.operation_kind, 'mint'),
         NEW.keyset_id, NEW.amount, lower(hex(NEW.c)),
         (SELECT epoch_index FROM solvent_pol_epoch WHERE state = 'OPEN'),
         CAST(strftime('%s','now') AS INTEGER));

    INSERT INTO solvent_pol_receipt
        (id, liability_kind, liability_id, keyset_id, amount, message, status, created_at)
    SELECT
        lower(hex(randomblob(16))), 'issued', il.id, il.keyset_id, il.amount,
        CAST('Cashu_PoL_Receipt_Issued:' || il.blinded_message_hex || ':' || il.target_epoch AS BLOB),
        'pending', CAST(strftime('%s','now') AS INTEGER)
    FROM solvent_issued_liability il
    WHERE il.blinded_message_hex = lower(hex(NEW.blinded_message));
END;

CREATE TRIGGER solvent_issued_liability_on_update
AFTER UPDATE OF c ON blind_signature
WHEN NEW.c IS NOT NULL AND OLD.c IS NULL
BEGIN
    INSERT INTO solvent_issued_liability
        (id, blinded_message_hex, operation_id, operation_kind, keyset_id, amount, signature_c_hex, target_epoch, created_at)
    VALUES
        (lower(hex(randomblob(16))), lower(hex(NEW.blinded_message)), NEW.operation_id, COALESCE(NEW.operation_kind, 'mint'),
         NEW.keyset_id, NEW.amount, lower(hex(NEW.c)),
         (SELECT epoch_index FROM solvent_pol_epoch WHERE state = 'OPEN'),
         CAST(strftime('%s','now') AS INTEGER));

    INSERT INTO solvent_pol_receipt
        (id, liability_kind, liability_id, keyset_id, amount, message, status, created_at)
    SELECT
        lower(hex(randomblob(16))), 'issued', il.id, il.keyset_id, il.amount,
        CAST('Cashu_PoL_Receipt_Issued:' || il.blinded_message_hex || ':' || il.target_epoch AS BLOB),
        'pending', CAST(strftime('%s','now') AS INTEGER)
    FROM solvent_issued_liability il
    WHERE il.blinded_message_hex = lower(hex(NEW.blinded_message));
END;

CREATE TRIGGER solvent_consumed_liability_on_spent
AFTER UPDATE OF state ON proof
WHEN NEW.state = 'SPENT' AND OLD.state != 'SPENT' AND NEW.operation_kind IN ('swap', 'melt')
BEGIN
    INSERT INTO solvent_consumed_liability
        (id, proof_y_hex, operation_id, operation_kind, keyset_id, amount, target_epoch, created_at)
    VALUES
        (lower(hex(randomblob(16))), lower(hex(NEW.y)), NEW.operation_id, NEW.operation_kind,
         NEW.keyset_id, NEW.amount,
         (SELECT epoch_index FROM solvent_pol_epoch WHERE state = 'OPEN'),
         CAST(strftime('%s','now') AS INTEGER));
END;

-- The mint's first epoch. Index 1, so that no real receipt can ever share
-- the retired Phase 2 placeholder value 0.
INSERT INTO solvent_pol_epoch (epoch_index, state, opened_at)
VALUES (1, 'OPEN', CAST(strftime('%s','now') AS INTEGER));
