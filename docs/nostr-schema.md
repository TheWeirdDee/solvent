# Nostr evidence schema (Gate 5)

Source: `src/nostr/pol-event.ts`, `src/nostr/pol-evidence.ts`. Distinct from SOLVENT v1's `solvent/v1` event (`src/nostr/event.ts`), which is unmodified and still used by the not-yet-rebuilt v1 UI.

## Event kind

**8181** — a regular, immutable Nostr event (NIP-01 kind range 1000-9999), not a parameterized-replaceable one. Chosen deliberately over the addressable 30000-39999 range: PRD §12.2 requires the audit record not depend solely on an event a relay may discard or replace. Checked against the NIP registry (`nostr-protocol/nips/blob/master/README.md`) on 2026-09-22 — unused at that time (see `DECISIONS.md` for the exact nearby-kind survey). The optional "latest state" pointer event PRD §12.2 also mentions is not implemented in this build.

## Schema

`content` is `JSON.stringify()` of:

```ts
{
  schema: 'solvent/pol/v2';
  mint: string;                    // mint URL/name
  mint_identity: string;           // manifest master public key, hex — binds this event to the Cashu-side signing identity
  keyset_id: string;
  epoch_index: number;
  manifest_digest: string;         // hex sha256 of the signed manifest message (src/pol/manifest.ts's manifestDigestHex)
  manifest_signature: string;      // the manifest's own BIP-340 signature, so a verifier never has to trust a separate fetch
  global_digest: string;           // hex — chains previous_global_digest + epoch_index + keyset Merkle root
  issued_mmr_root_hash: string;
  issued_mmr_root_sum: number;
  spent_mmr_root_hash: string;
  spent_mmr_root_sum: number;
  outstanding_balance: number;
  reserve_digest: string;          // hex — commits the Gate 6 reserve attestation used for this epoch's decision
  reserve_sats: number;
  reserve_network: string;
  issued_at: number;               // unix seconds
  valid_until: number;             // unix seconds
  proof_uri: string;               // pointer to the full evidence bundle
}
```

Every field in PRD §12.1's required list is present: mint identity reference, epoch index, manifest digest, issued/spent root hashes+sums, outstanding liability, reserve-attestation digest, reserve amount/network, freshness/expiry, a proof-bundle URI, and schema/version. No token owners or raw owner mappings are published.

## Tags

```
['M', mint_identity]
['E', String(epoch_index)]
['K', keyset_id]
```

Single uppercase letters, not the more readable `mint_identity`/`epoch`/`keyset`. **This is load-bearing, not a style choice**: NIP-01 only requires relays to index single-letter (a-zA-Z) tags for `#<letter>` filtering — multi-character tag filters are legal to send but most relays silently do not match on them. The first real end-to-end run of this build published successfully to two relays but fetch-back returned zero events until the tags were shortened to single letters; see `DECISIONS.md`. `e`/`p`/`d` were deliberately avoided: `e`/`p` filter values must be exact 64-character hex per NIP-01 (this schema's identity/epoch values don't fit that), and `d` implies a parameterized-replaceable event, which kind 8181 is not.

## Signing

The event is signed with a **Nostr identity keypair** (BIP-340 Schnorr via `nostr-tools`' `finalizeEvent`), which is a *different* key from the Cashu manifest master key (`mint_identity`). The event's own signer proves "this Nostr identity published this data"; the `mint_identity` field plus `manifest_signature` is what independently proves the data actually came from the mint's Cashu-side signing key — a verifier checks both, not just the outer event signature.

## Verification (`evaluatePolEvidence`, checks 14-17 of the PRD §14 decision rule)

Given a set of fetched events (from one or more relays, not necessarily deduplicated by the caller):

1. **Dedupe by event id** (the same event commonly arrives from multiple relays).
2. **Re-verify identity/epoch binding independently** — a relay's tag-filtered query result is never trusted as-is; an event whose *verified content* doesn't actually match the expected `mint_identity`/`epoch_index` is discarded before it can participate in any later check. (This closes a gap found during development: relying solely on the relay's own `#M`/`#E` filtering would let a misbehaving relay inject irrelevant events into the candidate set.)
3. **Signature/shape** — every candidate's BIP-340 signature and JSON schema shape must verify, or `REFUSE_NOSTR_SIGNATURE`.
4. **Conflict detection** — group the remaining valid candidates by `(manifest_digest, global_digest, reserve_digest)`; two or more distinct groups for the same identity/epoch is `REFUSE_NOSTR_CONFLICT`.
5. **Freshness** — the (now-unique) valid state must satisfy `issued_at <= now <= valid_until`, or `REFUSE_NOSTR_STALE`.
6. **Digest binding** — its `manifest_digest`/`global_digest`/`reserve_digest` must exactly match what the decision actually used, or `REFUSE_NOSTR_STATE_MISMATCH`.
7. **Nothing found at all** (after steps 1-2 filter everything out, or the fetch itself returned nothing) — `REFUSE_NOSTR_UNAVAILABLE`.

`fetchPolEvidence()` queries every relay in the list via `nostr-tools`' `SimplePool.querySync()`, which merges results from every relay that responds and tolerates individual relay failures — a relay that times out or errors simply contributes nothing, rather than failing the whole fetch (this is what makes "one relay down, the other has valid state" a deterministic success path — PRD's A17).

**Browser-layer refinement:** `evaluatePolEvidence()` above (the mechanism-level Gate 5 function used by the CLI/attack corpus) only ever emits `REFUSE_NOSTR_UNAVAILABLE` for case 7 — it has no visibility into *why* nothing was found. The browser's orchestration layer, `evaluateNostrIndependently()` (`src/app/submission.ts`), tracks relay reachability separately and splits case 7 into two distinct, never-collapsed outcomes: relays that answered but returned nothing become `REFUSE_NOSTR_EVENT_NOT_FOUND` (Create Test Ecash's expected, honest case — UI badge "PUBLICATION NOT FOUND"), while every relay being genuinely unreachable stays `REFUSE_NOSTR_UNAVAILABLE` (UI badge "PUBLIC EVIDENCE COULD NOT BE CHECKED"). See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee" section and `docs/verification-bundle.md` for the full table.

## Relays

`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band` — three independent public relays, satisfying PRD §12's "at least two public relays." A real `npm run gate5` run typically sees 2/3 acknowledge the publish (the third has been observed to time out in this environment) — evidence of the one-relay-tolerance property in ordinary operation, not just in a constructed test.
