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

## Receipt signing — resolved by the Step 8B signatory audit

**Update, Step 8B/8C**: the two questions this section originally left open have since been answered by actually auditing `cdk-signatory`'s real source — see `docs/cdk-signatory-audit.md` in full. Short answer: no, `cdk-signatory` does not expose a generic signing operation today (confirmed, not assumed); yes, the smallest safe addition is a minimal `Signatory` trait extension (`DECISIONS.md`'s Phase 2 Step 8C entry) — one new trait method reusing the exact same already-loaded per-amount key `blind_sign()` already uses, calling an already-shipped BIP-340 helper (`SecretKey::sign()`) that CDK already uses elsewhere (NUT-11/14/20/29). This is a real, small, checked-in patch against CDK's `cdk-signatory` crate specifically — unlike Step 2's database seam, which needed none.

The draft's signed transactional receipt (`"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch`, BIP-340 Schnorr, signed with the keyset's own per-amount key) is producible this way, using the real mint key, without that key ever leaving `cdk-signatory`'s existing isolation boundary.

**Accounting-fact atomicity and receipt-signing durability remain two separate mechanisms**, not one: the SQL trigger (Step 2) gives the liability *fact* single-commit atomicity; the signed receipt still needs a small transactional outbox (`pending` → `signed`, written by the same trigger, processed by an idempotent worker) because signing happens in a separate step after the CDK transaction commits. Full reasoning: `docs/cdk-signatory-audit.md`'s "atomicity question, answered" section. Full schema: `docs/accounting-model.md`.

## What this means for Phase 2's build order

Consistent with Phase 2 Step 8's own instruction ("do NOT implement mint + swap + melt simultaneously... first milestone: real NUT-04"): the **liability-fact recording** half of NUT-04 accounting (trigger-populated `solvent_issued_liability` rows) and the **receipt-signing** half (the `Signatory` trait extension + outbox worker) are both now architecturally resolved and can be built together for NUT-04 specifically, proven in real CI, before any swap or melt accounting work begins.
