-- SOLVENT Phase 2 mint-native accounting — NUT-04 issued-liability + receipt
-- outbox, applied to the SAME SQLite file cdk-mintd already manages.
--
-- Apply this once, after `cdk-mintd --work-dir <dir> config init ...` and
-- before starting the daemon:
--   sqlite3 <work-dir>/*.sqlite < migrations/solvent-accounting/0001_nut04_issued_liability.sql
--
-- CDK itself is not modified by this file — it only adds new tables and
-- triggers to the same database file. See docs/accounting-model.md and
-- docs/cdk-integration-seams.md for the full architecture and the exact
-- CDK source (crates/cdk-sql-common/src/mint/{quotes.rs,signatures.rs})
-- this file's trigger conditions are derived from.

CREATE TABLE solvent_issued_liability (
    seq                 INTEGER PRIMARY KEY AUTOINCREMENT,
    id                  TEXT NOT NULL UNIQUE,
    blinded_message_hex TEXT NOT NULL UNIQUE,
    operation_id        TEXT,
    -- Real values confirmed from crates/cdk-common/src/mint.rs's
    -- `impl fmt::Display for OperationKind`: "mint", "swap", "melt",
    -- "batch_mint" — not guessed. A swap's replacement outputs and a
    -- melt's change outputs are real issued liabilities too, tagged with
    -- their own real operation kind, not silently relabelled as "mint".
    operation_kind      TEXT NOT NULL CHECK (operation_kind IN ('mint', 'swap', 'melt', 'batch_mint')),
    keyset_id           TEXT NOT NULL,
    amount              INTEGER NOT NULL CHECK (amount > 0),
    signature_c_hex     TEXT NOT NULL,
    epoch_id            TEXT,
    created_at          INTEGER NOT NULL
);
CREATE INDEX idx_issued_liability_keyset ON solvent_issued_liability(keyset_id);

CREATE TABLE solvent_consumed_liability (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    proof_y_hex     TEXT NOT NULL UNIQUE,
    operation_id    TEXT,
    operation_kind  TEXT NOT NULL CHECK (operation_kind IN ('swap', 'melt')),
    keyset_id       TEXT NOT NULL,
    amount          INTEGER NOT NULL CHECK (amount > 0),
    epoch_id        TEXT,
    created_at      INTEGER NOT NULL
);
CREATE INDEX idx_consumed_liability_keyset ON solvent_consumed_liability(keyset_id);

CREATE TABLE solvent_pol_receipt (
    seq             INTEGER PRIMARY KEY AUTOINCREMENT,
    id              TEXT NOT NULL UNIQUE,
    liability_kind  TEXT NOT NULL CHECK (liability_kind IN ('issued', 'consumed')),
    liability_id    TEXT NOT NULL,
    keyset_id       TEXT NOT NULL,
    amount          INTEGER NOT NULL,
    message         BLOB NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'signed', 'failed')) DEFAULT 'pending',
    signature_hex   TEXT,
    attempts        INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    signed_at       INTEGER,
    UNIQUE (liability_kind, liability_id)
);
CREATE INDEX idx_pol_receipt_status ON solvent_pol_receipt(status);

-- Real CDK write path 1: a blinded message inserted already-signed in one
-- shot (crates/cdk-sql-common/src/mint/signatures.rs's "Unknown blind
-- message" branch — the batch-mint path).
CREATE TRIGGER solvent_issued_liability_on_insert
AFTER INSERT ON blind_signature
WHEN NEW.c IS NOT NULL
BEGIN
    INSERT INTO solvent_issued_liability
        (id, blinded_message_hex, operation_id, operation_kind, keyset_id, amount, signature_c_hex, created_at)
    VALUES
        (lower(hex(randomblob(16))), lower(hex(NEW.blinded_message)), NEW.operation_id, COALESCE(NEW.operation_kind, 'mint'),
         NEW.keyset_id, NEW.amount, lower(hex(NEW.c)), CAST(strftime('%s','now') AS INTEGER));

    INSERT INTO solvent_pol_receipt
        (id, liability_kind, liability_id, keyset_id, amount, message, status, created_at)
    SELECT
        lower(hex(randomblob(16))), 'issued', il.id, il.keyset_id, il.amount,
        CAST('Cashu_PoL_Receipt_Issued:' || lower(hex(NEW.blinded_message)) || ':0' AS BLOB),
        'pending', CAST(strftime('%s','now') AS INTEGER)
    FROM solvent_issued_liability il
    WHERE il.blinded_message_hex = lower(hex(NEW.blinded_message));
END;

-- Real CDK write path 2: a blinded message inserted unsigned first
-- (add_blinded_messages, c = NULL), then updated with the real signature
-- (add_blind_signatures). This is the path a normal, single-quote NUT-04
-- mint actually takes — confirmed by reading process_mint_request() in
-- crates/cdk/src/mint/issue/mod.rs, which calls add_blinded_messages()
-- then add_blind_signatures() in that order for the non-batch case.
CREATE TRIGGER solvent_issued_liability_on_update
AFTER UPDATE OF c ON blind_signature
WHEN NEW.c IS NOT NULL AND OLD.c IS NULL
BEGIN
    INSERT INTO solvent_issued_liability
        (id, blinded_message_hex, operation_id, operation_kind, keyset_id, amount, signature_c_hex, created_at)
    VALUES
        (lower(hex(randomblob(16))), lower(hex(NEW.blinded_message)), NEW.operation_id, COALESCE(NEW.operation_kind, 'mint'),
         NEW.keyset_id, NEW.amount, lower(hex(NEW.c)), CAST(strftime('%s','now') AS INTEGER));

    INSERT INTO solvent_pol_receipt
        (id, liability_kind, liability_id, keyset_id, amount, message, status, created_at)
    SELECT
        lower(hex(randomblob(16))), 'issued', il.id, il.keyset_id, il.amount,
        CAST('Cashu_PoL_Receipt_Issued:' || lower(hex(NEW.blinded_message)) || ':0' AS BLOB),
        'pending', CAST(strftime('%s','now') AS INTEGER)
    FROM solvent_issued_liability il
    WHERE il.blinded_message_hex = lower(hex(NEW.blinded_message));
END;
