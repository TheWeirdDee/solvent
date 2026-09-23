# Trust assumptions and honest limits

SOLVENT makes a mint's published state checkable. It does not make a Cashu mint non-custodial, and it does not prove global solvency. Read this before trusting a GREEN.

## What SOLVENT actually checks

For one presented Cashu proof against one signed mint report, SOLVENT verifies, with real cryptography:

1. The proof carries valid NUT-12 DLEQ data and it verifies against the mint's per-amount public key ([`@cashu/cashu-ts`](https://github.com/cashubtc/cashu-ts)'s real `hasValidDleq`/`verifyDLEQProof_reblind`, not a reimplementation).
2. The original blind signature `C'` is reconstructed from the proof (`C' = C + r·A`), independent of any ID the mint might otherwise have handed the holder.
3. A mint-proof leaf derived locally from `(keyset_id, amount, C')` has a valid Merkle-sum inclusion path into the mint's published `mint_root`.
4. The proof bundle's roots equal the roots the mint actually signed in its Nostr event — not just "a" root.
5. `liabilities_sats = mint_root.sum_sats - burn_root.sum_sats`, recomputed, and `burn_root.sum_sats <= mint_root.sum_sats`.
6. `reserve_sats >= liabilities_sats` (integer comparison — the float `ratio` field is presentation-only).
7. The Nostr event's signature is valid, the event is fresh (`issued_at <= now <= valid_until`), and it belongs to the documented mint identity.

GREEN means all of that held for the one issuance checked. It does not mean more than that.

## What SOLVENT does not prove

- **The mint is still a custodian.** GREEN is not "trustless." A GREEN mint can still refuse to redeem ecash, get hacked, or freeze funds. SOLVENT narrows one specific risk — a mint quietly issuing more than it reports — it does not remove custodial risk generally.
- **One inclusion check does not prove total completeness.** A holder who checks their own issuance learns only "my issuance was or wasn't counted." A mint could honestly include this holder's token while omitting other holders' entirely. Completeness requires many holders checking, or a stronger accumulator scheme — future work, not Phase 1.
- **Burn records are asserted by the mint, not independently proven.** Phase 1 commits burn records the fixture mint says it accepted as redeemed. A real, dishonest mint could publish fabricated burn records to inflate `burn_root.sum_sats` and understate liabilities. Detecting that needs an epoch-based challenge protocol where the actual redeeming holders can contest a burn claim — not built in Phase 1. See `docs/design-writeup.md`.
- **`reserve_sats` is a labelled fixture, not proof-of-reserves.** Every SOLVENT event carries `reserve_kind: "demo-reserve"`. The number is whatever the mint operator signs — Phase 1 does not bind it to an on-chain UTXO set, a Lightning channel balance, or any other externally-auditable reserve. Treat a GREEN's reserve coverage as "the mint claims this reserve and its liabilities math checks out," not as chain-verified solvency.
- **Key substitution is out of scope.** The verifier trusts a fixture-level binding between mint identity, Cashu keyset, and Nostr pubkey (see below). Nothing in Phase 1 independently authenticates that binding against a real-world mint operator identity.

## Key separation

Two different keys are in play, deliberately:

- **Cashu mint keyset keys** (one secp256k1 keypair per amount denomination) sign blind signatures — these are what NUT-12 DLEQ verification checks.
- **A Nostr keypair** signs the solvency report event.

Phase 1 binds `mint identity <-> Cashu keyset id <-> Nostr pubkey` through the fixture config file (`fixtures/<mint>.json`'s `keysetId` and `nostrPubkeyHex` fields), not through any on-chain or globally-authenticated mechanism. A real deployment would need the mint operator to publish this binding somewhere a client can authenticate (e.g. the mint's own HTTPS info endpoint, or a NIP-05-style identity proof) — Phase 1 simply asserts it in a local file.

## Fixture keys

`fixtures/<mint>.json`'s `nostrSecretKeyHexDemoOnly` field is a **real, functioning private key** — intentionally checked into the repo so a stranger can clone SOLVENT and run the full publish → verify loop without any setup. It is generated fresh by `npm run generate:fixtures` and is not, and must never be treated as, a production secret. Never reuse a key that has ever lived in a public git repository for anything of value.

## Phase 1 proof-bundle lookup is local, not networked

A real deployment's Nostr event would point `proof_uri` at a live HTTP endpoint a wallet queries for a specific inclusion proof. Phase 1's `proof_uri` is a `local://` reference resolved against the checked-in `fixtures/` directory — the verifier (`src/mint/reports.ts`) rebuilds the mint's Merkle-sum tree in memory and looks up the requested leaf by content. The cryptographic checks performed are identical to what a real endpoint's response would have to satisfy; only the transport is simplified for Phase 1.

## Numeric integrity

All amounts are non-negative integers (sats). SOLVENT never uses floating point for the accept/reject decision — `reserve_sats >= liabilities_sats` is an integer comparison. The `ratio` field exists for human-readable display only.
