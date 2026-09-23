# PoL extension — mapping the draft onto real CDK operations (Phase 2)

`docs/draft-alignment.md` documents what SOLVENT's existing fixture-based code (`src/pol/*`) already implements byte-exact to Cashu PR #388's draft (`github.com/cashubtc/nuts/pull/388`, semantic content at `github.com/a1denvalu3/nuts/blob/pol-spec/pol.md`, head `8fc2d3fcd33e1b6ba9b21497c2e71bd8ec60b685`). This document is forward-looking: which of the draft's required fields Phase 2 can source from **real CDK operations**, and which still need new design work.

## Sourced from real CDK state (via the SQL-trigger seam — `docs/cdk-integration-seams.md`)

| Draft field | Real CDK source |
| --- | --- |
| `B_` (blinded message, issued-liability leaf input) | CDK's `blind_signature` table — the exact same value the mint actually signed and returned in a NUT-04/03/05 response |
| `Y` (hash-to-curve of the spent proof's secret, consumed-liability leaf input) | CDK's `proof` table — already tracked as the primary NUT-07 lookup key (confirmed via `NotificationId::ProofState(p.y)` in `crates/cdk/src/event.rs`) |
| amount, keyset id | Both tables, directly |
| issued vs. consumed classification | Which table/trigger fired — `blind_signature` insert = issued, `proof` state transition to `SPENT` = consumed |
| operation linkage (which NUT-04/03/05 call produced this row) | CDK's `completed_operation` table (confirmed to exist via the `20251119000000_add_completed_operations.sql` migration) |

A trigger-populated SOLVENT table can hold all of the above the instant CDK's own transaction commits — see `docs/accounting-model.md` for the schema. This gives Phase 2 real, durable, correctly-timed **raw liability facts**.

## NOT yet sourced — receipt signing is a separate, unsolved problem

The draft's signed transactional receipt (`"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch`, BIP-340 Schnorr, **signed with the keyset's own per-amount key** — the same key CDK uses for blind signing) cannot be produced by a SQL trigger. Signing needs the mint's real amount private key, which lives in `crates/cdk-signatory` — a crate `docs/cdk-integration-seams.md` explicitly flagged as **not yet audited**.

This is the real content of Phase 2 Step 9 ("receipt signing inside the mint"), and it is not solved by the Step 2 architecture decision. Two honest open questions, not yet answered:

1. Does `cdk-signatory` expose any general-purpose "sign this exact message with keyset X's amount key" operation, or only the specific BDHKE blind-signing operation NUT-04/03/05 already use? If only the latter, PoL receipt signing (a *different* message format, not a blinded point) cannot reuse it as-is.
2. If no such generic signing entrypoint exists, is the smallest safe addition a minimal, narrowly-scoped patch to `cdk-signatory` itself (the one place Phase 2 Step 2's "no patch needed" finding does *not* necessarily extend to — Step 2's finding was specifically about the *database* transaction boundary, not the *signatory* boundary)? Or can SOLVENT's accounting worker legitimately hold its own *separate* signing identity, and the draft's "signed with the keyset's amount key" requirement gets satisfied a different way? Both have real trade-offs and neither has been decided.

**This document deliberately does not answer these questions** — doing so without first auditing `cdk-signatory`'s real source (the same standard `docs/cdk-integration-seams.md` held itself to for NUT-04/03/05) would mean guessing at an architecture decision, exactly what this whole project has been built to avoid. Recorded here as explicit, tracked scope for the next step of Phase 2 work, not silently deferred.

## What this means for Phase 2's build order

Consistent with Phase 2 Step 8's own instruction ("do NOT implement mint + swap + melt simultaneously... first milestone: real NUT-04"), and given the finding above: the **liability-fact recording** half of NUT-04 accounting (trigger-populated `solvent_issued_liability` rows, real amounts, real keysets, real linkage — see `docs/accounting-model.md`) can be built, migrated, and proven in real CI *before* receipt signing is solved, since it does not depend on the signatory audit. Receipt signing is a distinct, separately-gated follow-on step once `cdk-signatory` has been read with the same rigor NUT-04/03/05 already received.
