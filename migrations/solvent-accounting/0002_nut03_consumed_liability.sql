-- SOLVENT Phase 2 — NUT-03 consumed-liability accounting, applied to the
-- SAME SQLite file cdk-mintd already manages. Apply after
-- 0001_nut04_issued_liability.sql (which creates the solvent_consumed_liability
-- table this trigger populates) and before starting the daemon:
--   sqlite3 <work-dir>/*.sqlite < migrations/solvent-accounting/0002_nut03_consumed_liability.sql
--
-- CDK itself is not modified by this file — it only adds a trigger to the
-- same database file. See docs/cdk-integration-seams.md's "NUT-03
-- transaction map" for the full real source trace this trigger's condition
-- is derived from.
--
-- Real CDK write path: SwapSaga::finalize()
-- (crates/cdk/src/mint/swap/swap_saga/mod.rs) calls
-- Mint::update_proofs_state(&mut tx, &mut proofs, State::Spent)
-- (crates/cdk/src/mint/proofs.rs), which — after Rust's own
-- check_state_transition() has already validated the transition against
-- the row's previously-read state — executes
-- `UPDATE proof SET state = 'SPENT' WHERE y IN (:ys)`
-- (crates/cdk-sql-common/src/mint/proofs.rs) inside the SAME transaction as
-- the replacement outputs' signature write. This single real UPDATE is the
-- authoritative economic event that means "this proof is now consumed by a
-- successful swap" — not proof insertion, not the Pending-state reservation
-- in setup_swap()'s earlier transaction, and not client-side belief that a
-- swap succeeded.
--
-- operation_id/operation_kind are already present on the proof row, set at
-- INSERT time by add_proofs() (crates/cdk-sql-common/src/mint/proofs.rs)
-- from the real Operation the caller constructed (OperationKind::Swap for
-- a real NUT-03 swap) — never re-derived or guessed here. Because these
-- columns are set once at insertion and this trigger only reads NEW.* on
-- an UPDATE of a different column (state), the row's own stored
-- operation_kind is trustworthy regardless of which later code path
-- performs the state UPDATE.
--
-- Only the proof's public Y value is stored (proof_y_hex, hex-encoded) —
-- the exact same public lookup key CDK's own NUT-07 already exposes over
-- HTTP. The raw proof secret (proof.secret, held in cleartext by CDK for
-- its own double-spend verification) is never read by this trigger and
-- never enters SOLVENT's schema. See docs/privacy.md.
--
-- The WHEN clause below requires operation_kind IN ('swap', 'melt') rather
-- than firing unconditionally on any transition into SPENT: if a proof
-- ever reaches SPENT with a NULL or unrecognised operation_kind (a path
-- not exercised or verified by this integration — e.g. a legacy row
-- created before CDK's own saga-support migration added this column),
-- this trigger silently does not fire, rather than violating
-- solvent_consumed_liability's CHECK constraint and failing CDK's own real
-- transaction. This is a known, documented limitation, not an assumed-safe
-- guess — see docs/cdk-integration-seams.md.
--
-- The transition condition is `OLD.state != 'SPENT'` rather than the
-- narrower `OLD.state = 'PENDING'`: cdk-common's check_state_transition
-- (crates/cdk-common/src/state.rs) allows both Unspent->Spent and
-- Pending->Spent as valid transitions into Spent, and Spent is terminal
-- (no valid transition leaves it) — so this condition captures the one
-- real, definitive transition into SPENT regardless of which prior state
-- it came from, without being narrower than the real state machine allows.
CREATE TRIGGER solvent_consumed_liability_on_spent
AFTER UPDATE OF state ON proof
WHEN NEW.state = 'SPENT' AND OLD.state != 'SPENT' AND NEW.operation_kind IN ('swap', 'melt')
BEGIN
    INSERT INTO solvent_consumed_liability
        (id, proof_y_hex, operation_id, operation_kind, keyset_id, amount, created_at)
    VALUES
        (lower(hex(randomblob(16))), lower(hex(NEW.y)), NEW.operation_id, NEW.operation_kind,
         NEW.keyset_id, NEW.amount, CAST(strftime('%s','now') AS INTEGER));
END;
