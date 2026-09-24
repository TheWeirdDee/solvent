# Privacy — what SOLVENT's Phase 2 accounting and receipts expose

Phase 2 Step 6/17's privacy audit, referenced from `docs/accounting-model.md` and `INVARIANTS.md`'s P2-I13. Written against the actual schema and the actual patched-CDK endpoints, not a design intent.

## What is written into SOLVENT's own accounting tables

`solvent_issued_liability` and `solvent_pol_receipt` (`migrations/solvent-accounting/`) store: the blinded message (`B_`, already public — it is the value the mint returns in its own NUT-04 response), the keyset ID, the amount, the operation ID CDK itself assigned, and (for receipts) the signed message and its signature. None of these rows store:

- a raw proof secret (`secret`) — only ever the blinded output `B_`, which is not linkable to a spent proof's secret without the wallet's own blinding factor, exactly the same unlinkability property Cashu's blind-signature scheme already provides for the underlying protocol
- wallet identity, account identifier, session identifier, or any other correlation handle
- receiver/payer identity
- IP address or other request-metadata

This matches CDK's own `blind_signature` table, which SOLVENT's triggers read from — SOLVENT does not have access to, and does not store, anything CDK itself doesn't already persist for its own accounting.

## The receipt retrieval endpoint's lookup key

`GET /v1/solvent/pol-receipt/{blinded_message}` (`patches/cdk/0005-*.patch`) is keyed on the blinded message hex — the same public value a wallet already receives back from a normal `/v1/mint/{method}` response, and the same value `blind_signature.B_` already stores unencrypted in CDK's own database. Looking a receipt up does not require, and the endpoint does not accept, any proof secret, account identifier, or wallet-identifying credential. This means:

- **Anyone who observes a blinded message in transit (e.g. a wallet developer's own request) can query its receipt.** This is not a new leak — the same blinded message is already visible to the mint and to the wallet that generated it; the endpoint adds no new party to that visibility set.
- **The mint operator can already see every blinded message it ever signed** (it is the signatory); the retrieval endpoint does not give the mint operator any new information it didn't already have by virtue of being the mint.
- **A third party who did not generate the blinded message and does not observe it in transit cannot look up a receipt for it** — the space of valid blinded messages is a full secp256k1 point, not brute-forceable.

This is the same "public but unguessable" model CDK's existing NUT-07 (`check_state`) already uses for looking up a proof's spent/unspent state by `Y`. The retrieval endpoint does not introduce a new privacy primitive; it reuses CDK's existing one.

## What is deliberately NOT exposed

- `sign_pol_receipt()` has no HTTP route (`docs/cdk-signatory-audit.md`'s signing-oracle audit) — it cannot be invoked directly, only reached through the real NUT-04 issuance path or the recovery scan, both of which construct the signed message themselves rather than accepting a caller-supplied one.
- The recovery scan (`Mint::recover_pending_pol_receipts()`) and the retrieval endpoint (`Mint::get_pol_receipt()`) are both read/sign-only against rows already keyed by public material; neither accepts or logs anything that would let an operator correlate two different receipts as belonging to the same wallet.

## NUT-03 swap linkage (Phase 2 continuation — Step 20 audit)

**Does SOLVENT's private accounting now record a direct input→output relation for a swap?** Yes, honestly: `solvent_consumed_liability.operation_id` and `solvent_issued_liability.operation_id` both store the same real swap `operation_id` (the UUID CDK's own `Operation::new()` assigns — `docs/cdk-integration-seams.md`'s NUT-03 transaction map), so querying both tables for the same `operation_id` reveals exactly which input proofs were consumed and which replacement outputs were issued by the same swap. This is a real correlation, not a hypothetical one.

**Is this a new leak SOLVENT introduces?** No. CDK's own `proof.operation_id`, `blind_signature.operation_id`, and `completed_operation` tables already store the identical grouping — it is how CDK itself accounts for a swap. SOLVENT's schema mirrors CDK's own real column, it does not derive or invent a new correlation CDK didn't already have. The mint operator already has this linkage by virtue of running the mint, with or without SOLVENT installed.

**Does this linkage ever reach anything public?** Not currently, and by construction, not accidentally: the signed receipt message (`"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch`) never includes `operation_id` — a party holding only a receipt cannot recover which swap produced it, or which inputs were consumed alongside it. No public epoch manifest is built from real CDK/SOLVENT data in Phase 2 (`src/pol/manifest.ts` remains disconnected from the real stack per `ARCHITECTURE.md`), so there is currently no public structure that could expose this linkage even if it wanted to.

**What minimum provenance does accounting actually require?** `operation_id` on each side, for two purposes only: (1) reconciliation against CDK's own `completed_operation` table (already how NUT-04's accounting is independently verified — `docs/accounting-model.md`), and (2) debugging a specific swap's accounting without correlating across unrelated swaps. Neither purpose requires a *direct* consumed↔issued pair table; both are satisfiable from each table independently referencing the same operation, exactly as built — no additional linkage was added beyond this.

**Forward-looking constraint, recorded now so it isn't forgotten later**: if/when a public epoch manifest is eventually built from real swap data (a future phase, not this one), it must aggregate to per-keyset totals for that epoch, not enumerate per-operation input/output pairs — publishing the latter would make swap input↔output linkage public, which nothing in the pinned draft requires and which would be a real, avoidable privacy regression relative to Cashu's own blind-signature unlinkability guarantee.

## Residual privacy considerations, stated honestly

- The mint operator (who already holds the signing keys and sees every blinded message) can trivially correlate which blinded messages were minted in the same NUT-04 request (they share an operation ID in `solvent_issued_liability`). This is inherent to operating a mint, not specific to SOLVENT's accounting — CDK's own `blind_signature` table already groups rows this way.
- SOLVENT has not audited timing-based correlation (e.g. an observer inferring which receipts belong together by request timing against the retrieval endpoint). This is a known, common class of concern for any HTTP endpoint and has not been specifically tested here.
