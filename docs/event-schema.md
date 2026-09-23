# SOLVENT solvency event — schema

## Event kind

**Kind `31111`** — a parameterized-replaceable event per [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) (the 30000–39999 range). Relays and clients keep only the latest event per `(pubkey, kind, d-tag)` triple.

## Tags

```json
[
  ["d", "<mint identity, e.g. \"mint-a\">"],
  ["keyset", "<cashu keyset id>"],
  ["epoch", "<epoch number as a string>"]
]
```

The `d` tag is the replacement key. A verifier that fetches "the latest event for mint-a" is really fetching the latest event with `(pubkey = mint's Nostr pubkey, kind = 31111, d = "mint-a")`.

## Content (JSON-encoded string)

```json
{
  "schema": "solvent/v1",
  "mint_pubkey": "<hex, same as the event's own pubkey>",
  "keyset_id": "<cashu keyset id>",
  "epoch": 1,
  "mint_root": { "hash": "<hex sha256>", "sum_sats": 30000 },
  "burn_root": { "hash": "<hex sha256>", "sum_sats": 5000 },
  "liabilities_sats": 25000,
  "reserve_sats": 40000,
  "reserve_kind": "demo-reserve",
  "ratio": 1.6,
  "issued_at": 1700000000,
  "valid_until": 1700086400,
  "proof_uri": "local://fixtures/mint-a.json",
  "notes": "Phase 1 fixture mint"
}
```

Field notes:

- `mint_pubkey` — the same hex pubkey that signs the event. SOLVENT Phase 1 uses one Nostr keypair as the mint's whole identity (see `docs/trust-assumptions.md` for what this binding does and doesn't prove).
- `liabilities_sats` — MUST equal `mint_root.sum_sats - burn_root.sum_sats`. A verifier recomputes this; it never trusts the field at face value (PRD 10.4 check #8).
- `reserve_kind` — always the literal string `"demo-reserve"` in Phase 1. Never presented as live proof-of-reserves.
- `ratio` — presentation-only. `Infinity` when `liabilities_sats` is 0. The actual accept/reject decision uses integer `reserve_sats >= liabilities_sats`, never the float ratio.
- `valid_until` — required. A verifier checks `issued_at <= now <= valid_until`; anything outside that window is RED.
- `proof_uri` — where the proof bundle for a specific issuance's inclusion path can be found. Phase 1 fixtures use a `local://` URI resolved against the local `fixtures/` directory rather than a live HTTP endpoint (see trust-assumptions.md).

## Signing / verification

- Signed with [NIP-01](https://github.com/nostr-protocol/nips/blob/master/01.md) Schnorr signatures via `nostr-tools`' `finalizeEvent`/`verifyEvent` — no custom signature code.
- `src/nostr/event.ts` implements `signSolvencyEvent` / `verifySolvencyEvent`, plus offline shape/schema validation of the parsed content.
- The verifier (`src/verifier/rules.ts`) additionally requires: the event's `pubkey` matches the mint fixture's documented `nostrPubkeyHex`, `content.mint_pubkey` matches the event's own `pubkey`, and the `d` tag matches the mint identity being checked.

## Relays used for the demo

SOLVENT publishes to:

- `wss://relay.damus.io`
- `wss://nos.lol`
- `wss://relay.nostr.band`

In testing, `relay.damus.io` and `nos.lol` reliably accepted the event; `relay.nostr.band` occasionally timed out. The publisher CLI (`npm run publish:event`) reports per-relay success/failure on every run — see its output for which relays actually accepted a given publish, per the PRD's "test relays, don't assume" rule.
