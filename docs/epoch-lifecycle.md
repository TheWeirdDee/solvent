# Real PoL epoch lifecycle (Phase 3A)

Phase 2 gave every real CDK output a real signed PoL receipt, but every receipt promised the constant epoch `0` and no epoch ever closed. Phase 3A replaces that with a real lifecycle, driven by the real mint's own database:

```text
OPEN epoch N
  -> real NUT-04 / NUT-03 accounting rows stamped N, receipts signed "…:N"
close N   (one BEGIN IMMEDIATE transaction)
  -> issued + spent sum-MMR per keyset, derived from those rows
  -> outstanding = issued - spent
  -> one manifest per keyset, signed with the mint's manifest key
  -> global digest chained to N-1
  -> N becomes CLOSED (immutable), N+1 is OPEN
```

Nostr publication of a closed epoch and binding it to the live reserve are Phase 3B. They are not part of this milestone.

## Pieces

| Piece | File |
| --- | --- |
| Schema, triggers, invariants | [`migrations/solvent-accounting/0003_pol_epoch_lifecycle.sql`](../migrations/solvent-accounting/0003_pol_epoch_lifecycle.sql) |
| In-transaction receipt signing over the DB-stamped epoch | [`patches/cdk/0007-sign-pol-receipts-over-the-open-epoch.patch`](../patches/cdk/0007-sign-pol-receipts-over-the-open-epoch.patch) |
| Closer, audit, per-issuance evidence | [`src/epoch/closer.ts`](../src/epoch/closer.ts) |
| Operator CLI (`npm run pol:epoch-close`) | [`src/cli/real-cashu/pol-epoch-close.ts`](../src/cli/real-cashu/pol-epoch-close.ts) |
| Real-mint end to end (`npm run verify:pol-epoch`) | [`src/cli/real-cashu/pol-epoch-e2e.ts`](../src/cli/real-cashu/pol-epoch-e2e.ts) |
| Tests against the real CDK schema | [`tests/epoch/closer.test.ts`](../tests/epoch/closer.test.ts) |

The closer reuses `src/pol/mmr.ts`, `src/pol/manifest.ts` and `src/pol/receipt.ts` unchanged. These are the modules validated against the draft's official vectors.

## Schema

The existing liability tables stay the source of truth. The epoch tables only store commitments to those rows.

- `solvent_issued_liability.target_epoch` and `solvent_consumed_liability.target_epoch` (`INTEGER`) record the epoch a liability was promised to. They replace Phase 2's never-populated `epoch_id TEXT` placeholder, which is dropped.
- `solvent_pol_epoch` holds `epoch_index`, `state` (`OPEN`/`CLOSED`), `opened_at` and `closed_at`, and, once closed, `manifest_timestamp`, `previous_global_digest`, `global_digest`, `keyset_count` and `manifest_pubkey`.
- `solvent_pol_epoch_keyset` holds one row per keyset per closed epoch: the issued and spent MMR sizes, root hashes and sums, `outstanding_balance`, `active`, `deactivation_epoch`, `manifest_digest` and `manifest_signature`.
- `solvent_pol_epoch_omission` is an operator-side record of the broken-promise demo mode (see below). It is empty unless an operator explicitly requests an omission, and it is never published.

CDK already has an unrelated `keyset_epoch` table, a keyset-configuration version counter. That's why SOLVENT's tables are named `solvent_pol_*`.

## State machine

```text
            migration 0003
                 |
                 v
   +-------> [N OPEN] --close N--> [N CLOSED]   (immutable forever)
   |                                   |
   +------------ open N+1 <------------+   (same transaction)
```

The database enforces these rules, not just the closer:

- **Exactly one OPEN epoch.** A partial unique index on `state = 'OPEN'` guarantees it. Epoch 1 is seeded by the migration.
- **Epochs are only opened, and contiguously.** A new row must be `OPEN` with index `max + 1`.
- **OPEN → CLOSED is the only transition, and it happens once.** Closing requires every closed-state field to be set (a `CHECK`), and requires `keyset_count` to equal the number of keyset manifests written.
- **CLOSED is immutable.** No update, no delete. Keyset manifests can be inserted only while their epoch is still OPEN, which means inside the closing transaction, and are never updated or deleted.
- **Liability rows are immutable and must target the open epoch.** A `BEFORE INSERT` guard aborts the whole CDK transaction if a row's `target_epoch` is not the currently OPEN epoch, including when no epoch is open at all. A SOLVENT mint never issues ecash it cannot target.
- **A receipt's message never changes.** Only its `status`, `signature_hex` and `signed_at` can be updated.

The first epoch is **1**, so no real receipt can share Phase 2's retired placeholder value `0`. The migration refuses to run on a database that already holds liabilities, because those carry `…:0` receipts that no epoch could honour.

## Current-epoch semantics and the race

"Current epoch" means the epoch that is OPEN at the moment CDK's own write transaction runs the SOLVENT trigger.

1. CDK's SQLite transactions all begin with `BEGIN IMMEDIATE` (`crates/cdk-sqlite/src/async_sqlite.rs`), which takes the database write lock up front.
2. Inside that transaction, `add_blind_signatures` fires SOLVENT's trigger. The trigger stamps `target_epoch = (the OPEN epoch)` on the liability row and builds the receipt message `Cashu_PoL_Receipt_Issued:<B_>:<target_epoch>` from the same value.
3. Patch 0007's `Mint::sign_pol_receipts_in_tx` then reads that message through the same transaction's connection, signs it with the per-amount key, and records the signature. All of this happens before the transaction commits.
4. The closer also uses `BEGIN IMMEDIATE`.

So a close and an issuance can never interleave. Either the issuance commits first, and the close reads and commits its row, or the close commits first, and the issuance is stamped N+1. If a close holds the lock, CDK waits up to its 10-second `busy_timeout`, and the closer does the same the other way round. A test demonstrates this directly: while the closer holds the lock, a second `BEGIN IMMEDIATE` fails.

In Phase 2 the receipt was signed *before* the transaction, over a hardcoded `0`. Patch 0007 moves signing inside the transaction, because the promised epoch only exists once the trigger has run.

**A receipt never promises an epoch after it has closed.** This follows from the lock ordering above, and the liability `BEFORE INSERT` guard makes it a hard database invariant.

## Commitments

For keyset K at epoch N:

- **Issued leaves** are every row in `solvent_issued_liability` with `keyset_id = K` and `target_epoch <= N`, joined to CDK's `blind_signature` row with `c IS NOT NULL`, in `seq` order (the order the mint recorded them), minus any row omitted from an epoch `<= N`. Each leaf is `(SHA256(B_), amount)`.
- **Spent leaves** are every row in `solvent_consumed_liability` with `keyset_id = K` and `target_epoch <= N`, joined to CDK's `proof` row with `state = 'SPENT'`, in `seq` order. Each leaf is `(SHA256(Y), amount)`.
- **Outstanding** is `issued_root_sum - spent_root_sum`. The database also checks this as a `CHECK` on the manifest row.

The MMRs are cumulative, so epoch N+1's MMR extends epoch N's. That is the draft's append-only property, and a test checks it.

The joins to CDK's own tables mean a liability row with no real CDK write behind it can never enter a commitment. The Phase 2 synthetic recovery fixture (`pol-seed-pending-receipts.ts`, tagged `batch_mint`) is such a row. The closer reports these as `unbackedIssuedRowsExcluded` / `unbackedConsumedRowsExcluded` instead of silently dropping them.

`auditClosedEpoch()` independently re-derives every closed epoch from the rows. It checks roots, sums, sizes, the outstanding arithmetic, manifest digests and signatures, the global digest, and the chain to the previous epoch.

## Manifest key

The manifest (the draft's "master key" signature) is signed by an operator-held secp256k1 key, supplied to the closer as `SOLVENT_MANIFEST_PRIVKEY`. It is deliberately **not** CDK's signatory seed, so no new signing path into the signatory is added (see `docs/cdk-signatory-audit.md`). The public key is stored on every closed epoch.

The closer refuses to close an epoch with a different key than the previous one signed with. A silent key change would break every verifier's continuity.

Publishing this key where a wallet can bind it to the mint, for example in the mint's NUT-06 info, is part of Phase 3B.

`deactivation_epoch` is `0` ("none scheduled") for an active keyset. For an inactive keyset it is the first epoch that recorded the keyset as inactive. The draft's keyset-lifecycle invariants are still not enforced by the verifier (`docs/draft-alignment.md`).

## Broken-promise demo mode (explicit opt-in)

```text
SOLVENT_OMIT_PROMISED_ISSUANCE=<blinded message hex>  npm run pol:epoch-close -- <db>
```

This mode is never on by default. It applies to one close only, and the closer refuses it unless the issuance was promised to the epoch being closed. The real mint issues the ecash, signs a receipt promising epoch N, and records the accounting row. The close then leaves exactly that leaf out of N's issued commitment, still signs a valid manifest, and still closes and chains the epoch.

The token, the receipt and the liability row are untouched. The omission is recorded in `solvent_pol_epoch_omission`, so later epochs keep leaving it out. The adversarial mint's MMR therefore stays append-only consistent: it tells a consistent lie, not a detectable rewrite.

The central verifier refuses the holder's ecash with `REFUSE_ISSUANCE_OMITTED`, even though every signature and the arithmetic verify.

## Crash and restart

- **Crash during a close.** The whole close, including the omission record, the manifests, the flip to CLOSED and the next OPEN epoch, is one transaction. A test kills the closer process with a real SIGKILL while the close is fully staged and blocked before `COMMIT` (`SOLVENT_TEST_DELAY_BEFORE_EPOCH_COMMIT_MS`). The epoch is still OPEN afterwards, no manifests exist, and a normal close then succeeds and passes the audit.
- **Restart.** Epoch state is ordinary committed SQLite state in the mint's own database file. `npm run verify:pol-epoch -- <db> --audit-only` re-audits every closed epoch after a real mint restart.
- **Receipt recovery.** Patch 0004's startup recovery signs the stored message, which now carries the real epoch, so recovered receipts promise the epoch their row was stamped with.

## Demo cadence

`npm run pol:epoch-close -- <db> --every 45` closes an epoch every 45 seconds. That cadence is only for the test-network demo mint, so a judge doesn't wait long for the promised epoch. Production mints choose their own cadence.
