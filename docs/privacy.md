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

## Residual privacy considerations, stated honestly

- The mint operator (who already holds the signing keys and sees every blinded message) can trivially correlate which blinded messages were minted in the same NUT-04 request (they share an operation ID in `solvent_issued_liability`). This is inherent to operating a mint, not specific to SOLVENT's accounting — CDK's own `blind_signature` table already groups rows this way.
- SOLVENT has not audited timing-based correlation (e.g. an observer inferring which receipts belong together by request timing against the retrieval endpoint). This is a known, common class of concern for any HTTP endpoint and has not been specifically tested here.
