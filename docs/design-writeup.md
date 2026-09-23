# Design write-up

## Why liabilities are modeled as issued mint proofs minus burn proofs

Cashu is a blind-signature ecash system: the mint never sees a wallet's final spendable token, only a blinded message it signs. There is no server-side "list of tokens currently in wallets" to publish — that data structurally doesn't exist at the mint. What the mint *can* honestly publish is what it has signed (issuance) and what has come back to it as spent (redemption). Outstanding liabilities is the natural derived quantity:

```
outstanding liabilities = issued ecash - burned/redeemed ecash
```

This follows Calle's Cashu proof-of-liabilities proposal, which explicitly frames liabilities this way and explicitly does not claim perfect global accountability — a caveat SOLVENT keeps front and center (`docs/trust-assumptions.md`).

## Why the mint-proof leaf is tied to `C'`, not an opaque ID

A mint could publish a report listing "token #4471: 30,000 sats, included" — but a made-up integer ID proves nothing on its own; the mint could assign IDs however it likes and a holder has no way to check that ID actually corresponds to *their* ecash. NUT-12 gives a receiver a way to independently reconstruct the mint's original blind signature `C'` from a proof they actually hold, using only public data plus the blinding factor `r`. Binding the leaf to `(keyset_id, amount, C')` means the holder's own cryptography — not the mint's say-so — determines which leaf they're allowed to check. There is no field in this scheme a mint could quietly swap out to make a fabricated leaf ID say "included" for the wrong token.

## How NUT-12 lets the receiver validate origin and reconstruct `C'`

When a mint signs a blinded message `B'` with its private key `a` for amount-key `A = a·G`, it can also produce a DLEQ proof `(e, s)` showing `C' = a·B'` was computed with the same key as `A`, without revealing `a`. A holder who has the original secret and blinding factor `r` (or receives `r` alongside the proof, which is what SOLVENT requires — see below) can locally recompute `B' = Y + r·G` and `C' = C + r·A` from their own unblinded proof, then run the identical DLEQ verification equation the mint's original counterparty ran. SOLVENT's `src/cashu/dleq.ts` does exactly this, calling straight into `@cashu/cashu-ts`'s real implementation (`hasValidDleq`, `verifyDLEQProof_reblind`) rather than reimplementing elliptic-curve math — the formulas were cross-checked against the official [NUT-12 test vectors](https://github.com/cashubtc/nuts/blob/main/tests/12-tests.md) in `src/cashu/dleq.test.ts`.

This is also why SOLVENT requires `r` in the presented proof: NUT-12 only makes `r` available to the *original* minting wallet by default. A proof without `r` cannot be independently reconstructed by a third party, so SOLVENT treats it as unsupported and fails closed to RED (see `docs/trust-assumptions.md`).

## Why Merkle-sum

A plain Merkle tree proves set membership. It says nothing about the *amounts* involved unless a verifier separately trusts a number written next to the root — which is exactly the kind of unverified claim SOLVENT exists to eliminate. A Merkle-sum tree binds the amount into every hash: `combine(left, right)` hashes both children's hashes *and* their sums, so a verifier who checks an inclusion path also, for free, checks that the amounts add up correctly all the way to the root. There is no way to present a valid inclusion path for a leaf whose amount doesn't match what's baked into the root sum.

Implementation notes (`src/proof/merkle-sum.ts`):

- Domain-separated leaf vs. internal-node hashing (the RFC 6962 / Certificate Transparency pattern) prevents an attacker from passing a leaf off as an internal node or vice versa.
- Odd leaf counts promote the unpaired node unchanged to the next level, rather than duplicating the last leaf — the historical Bitcoin Merkle tree duplication bug (CVE-2012-2459) is a structural non-issue here by construction.
- All amounts are canonically length-prefixed and big-endian encoded (`src/encode/canonical.ts`) so no two different field splits can ever hash to the same bytes.

## Why Nostr instead of mint-HTTP only

An HTTP endpoint the mint controls can be taken down, edited after the fact, or served differently to different requesters, with no record. A signed, timestamped, replaceable Nostr event published to multiple independent relays gives a verifiable, hard-to-quietly-alter publication trail: the signature ties the report to a specific key, and once relays have propagated it, the mint can't unpublish a report it doesn't like without that being detectable (a new event simply supersedes the old one under the same `d` tag, but the old one doesn't just vanish from relays that already have it).

## Why RED on missing/stale/invalid rather than yellow

A three-state system invites a UI (and a user) to treat "yellow" as "probably fine." Every failure mode in SOLVENT — an expired event, a missing relay response, a DLEQ that doesn't verify, an inclusion path that doesn't check out — means the same practical thing: *this specific check could not be verified as true right now*. Collapsing all of those into RED keeps the accept gate's contract simple and matches the "fail closed" requirement: the Accept button is enabled only when every required check independently passed.

## Why a stub/fixture mint instead of a Nutshell patch

Patching a real mint implementation to expose mint-proof/burn-proof commitments is real, valuable future work, but it's a different, larger engineering task than the protocol and verifier this hackathon phase is about. A controlled fixture mint lets SOLVENT exercise the *entire* real cryptographic path — real blind signing, real DLEQ, real Merkle-sum commitments, real Nostr signing and relay publication — while keeping full control over which issuances get published, which is exactly what's needed to construct the omitted-liability hero-demo case truthfully and repeatably. See `docs/trust-assumptions.md` for exactly what "fixture" means here and what it doesn't.

## Why Phase 1 doesn't claim full liability completeness

A single holder's inclusion check can only ever prove "my issuance was (or wasn't) counted." It structurally cannot prove that *every* issuance was counted, because SOLVENT never sees the mint's full internal issuance ledger — only what the mint chooses to publish plus whatever this one holder happens to check. Claiming otherwise would be dishonest about what the cryptography actually establishes. The omitted-issuance demo case exists specifically to make this visible and testable rather than glossed over.

## Why fake-burn resistance isn't fully solved in Phase 1

Nothing in Phase 1 stops a mint from asserting a burn record for a secret it fabricated, inflating `burn_root.sum_sats` to understate liabilities. Catching that requires a protocol where the *actual* holder whose token was allegedly burned can contest the claim within some epoch window — a genuine additional protocol layer (holder-side burn challenges, epoch finalization) that's explicitly future work, not a Phase 1 gap that can be closed by more code in the time available.

## What's next after 05 Oct

- Live on-chain (or Lightning-channel) proof-of-reserves, replacing the `demo-reserve` fixture.
- A real mint integration (Nutshell) that exports genuine mint-proof/burn-proof records instead of a fixture.
- Epoch finalization and a burn-challenge protocol for stronger fake-burn resistance.
- A documented, versioned event schema stable enough for a second, independent wallet implementation to consume without reading SOLVENT's source.
- Wallet integrations (Cashu.me, Minibits) calling the same verify() rule as an accept gate.
