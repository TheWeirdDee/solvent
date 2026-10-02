# Verification bundle schema

The verification bundle is the exact, canonical input SOLVENT's browser verifier consumes — `SubmissionBundle` in `src/app/submission.ts`. There is no separate, simplified schema for the UI: the bundle you paste or upload into /verify's "Verify evidence" is this type, serialized to plain JSON.

**Users are not expected to manually construct this bundle.** A SOLVENT-compatible mint exports it with the ecash. "Load live example" in "Verify evidence" loads the published reference case (`evidence/nostr/live-demo.json`), and the developer reference mint lab (`#/lab`) can export locally generated ones. This page exists so you can read what you're pasting, not so you can hand-write one.

A mint that cannot supply every required field below cannot be fully verified by SOLVENT. See the [FAQ](#/docs?doc=faq) — "Can SOLVENT verify any Cashu token?"

## Why this is raw evidence, not a pre-computed verdict

An earlier version of this bundle carried `reserve: { verified: boolean }` / `nostr: { verified: boolean }` — the *result* of checking those two legs, supplied by whoever built the bundle. That is fine when the code calling `verify()` is the same code that ran the real checks (the CLI and the attack corpus both do this). It is not fine for a bundle pasted by an unknown party: nothing would stop someone from writing `"reserve": { "verified": true, "reserveSats": 999999999 }` by hand and getting `ACCEPT` for a reserve that never existed.

So the bundle you see below carries `reserveAttestation` and `nostrEvent` — the **raw signed evidence itself**, never a claim about its own validity. `verifySubmission()` (`src/app/submission.ts`) independently re-derives `verified`/`reasonCode` from that raw evidence before `verify()` ever runs:

- **`reserveAttestation`** → a real, live Esplora re-query of its declared outpoints, right now, against the actual Bitcoin Signet chain — never anything the bundle itself claims about their state.
- **`nostrEvent`** → a real, live fetch attempt from public relays for this exact `(mint_identity, epoch)` right now. Whether `verify()` treats this leg as satisfied depends **only** on what a public relay actually returns — never on the bundle's own private copy alone. See "The two-tier Nostr guarantee" below.

If you edit a pasted bundle to add a `reserve` or `nostr` field back in, it is simply ignored — `verifySubmission()` never reads those keys.

## The two-tier Nostr guarantee: what "Event: FOUND" vs "NOT FOUND" means

Every verification queries public relays for the bundle's own `(mint_identity, epoch)` evidence — a real network call, not a cached assumption — and keeps two facts strictly separate:

- **`Provided copy: CRYPTOGRAPHICALLY VALID/INVALID`** — informational only. Is the bundle's own private copy of the event a genuine, internally consistent BIP-340 signature over this bundle's own manifest/reserve digests? This never by itself allows `ACCEPT`.
- **`Public publication: VERIFIED/NOT VERIFIED`** — the actual gate. True only when a public relay genuinely returns this evidence (`Exact event: FOUND (public relay)`) and it's cryptographically valid there. A bundle whose event cannot be found publicly gets **one of two distinct, never-collapsed reason codes** — **even when its own private copy is perfectly valid.**

`Relay: REACHABLE/UNREACHABLE` is reported separately from `Exact event: FOUND/NOT FOUND`, because "a relay was reachable but simply doesn't have this event" and "no relay could be reached at all" are different facts with different remedies, and SOLVENT never compresses them into one:

| Reason code | Relay reachable? | Event found? | Meaning | UI badge |
| --- | --- | --- | --- | --- |
| `REFUSE_NOSTR_EVENT_NOT_FOUND` | Yes | No | Public relays answered, but none returned this event. The expected result for locally generated (lab) evidence; for a fresh publication it can also mean "not retrievable yet". | **Could not complete** (amber): "PUBLIC EVIDENCE NOT FOUND" — nothing accepted, *Retry verification* offered. Not a finding that the mint broke its promise. |
| `REFUSE_NOSTR_UNAVAILABLE` | No | — | No configured relay could be reached (directly, or through the HTTPS relay fetch) — a network problem, not a claim about publication. | **Could not complete** (amber): "RELAYS UNREACHABLE" — nothing accepted, *Retry verification* offered. |

For a bundle generated locally in the **reference mint lab**, `REFUSE_NOSTR_EVENT_NOT_FOUND` is *expected and correct*: SOLVENT does not publish throwaway events to production relays, so there is nothing for a relay to find. The UI shows it as **could not complete** (amber): "PUBLIC EVIDENCE NOT FOUND", nothing accepted, with "Local cryptography: VALID" as a secondary fact — a private signed copy, however valid, does not satisfy SOLVENT's actual claim that the accounting record is publicly checkable. **Re-check published evidence** (and "Load live example" here) uses the one identity whose evidence genuinely was published via `npm run live-demo` — its event is found live and, while its reserve attestation is fresh, it reaches a real `ACCEPT_VERIFIED`. A bundle from a real external mint that published its own evidence to Nostr would be found and verified the same way.

If every configured relay is simply unreachable (offline, CORS failure, relay outage), that is `REFUSE_NOSTR_UNAVAILABLE` instead — a materially different fact from "checked and not found," and SOLVENT never presents one as the other. See `docs/trust-boundaries.md`'s "The two-tier Nostr guarantee" section for the same table with the exact `REASON_TEXT` strings.

## Is this ecash real?

The reference case and the lab both call `@cashu/cashu-ts`'s real `getEncodedToken()` — the exact function a real Cashu wallet uses — so their `token` strings **are** standards-compliant, NUT-00-encoded Cashu tokens. Any NUT-00-compliant parser can decode them.

What it is not: spendable anywhere. Its `mint` field is a SOLVENT-internal label (`solvent-fixture-mint` in the currently published reference case, `solvent-reference-lab` in the lab), not a resolvable HTTP mint URL. There is no live mint server behind it. A real wallet could parse the token and read its amount/secret/signature, but there is nothing to redeem or swap it against. The cryptography is real and the issuance is real, but the mint behind it is SOLVENT's reference implementation, not a production Cashu mint — never "a real Cashu token you can spend.

## Two shapes: captured reference bundle vs real HTTP mint bundle

The same verifier accepts both, but they are not the same structure:

| | **A. Captured reference bundle** | **B. Real HTTP mint bundle** (the public Railway mint, the CI runs) |
|---|---|---|
| Where it comes from | `evidence/nostr/live-demo.json`, the lab, the attack corpus | The SOLVENT evidence service: `GET /v1/solvent/issuance/<B_>` plus the holder's own proof |
| `mint` | a reference label, not a URL | the mint's public `https://` URL |
| Mint identity | none; the manifest key *is* the identity | the NUT-06 key, fetched by the verifier from `<mint>/v1/info`, **never read from the bundle** |
| `masterPublicKeyHex` | the reference identity | the **manifest signer**: a separate key, authorized by `delegation` |
| `delegation` | absent | required (see below) |
| `reserveBinding` | absent | required: the epoch-scoped reserve binding |
| `epochKeysetCount` | absent | required (`1`; multi-keyset epochs are refused) |

A real HTTP mint bundle missing `delegation`, `reserveBinding` or `epochKeysetCount` is refused: `REFUSE_DELEGATION_MISSING`, `REFUSE_RESERVE_BINDING_INVALID`, or `REFUSE_UNVERIFIABLE` respectively.

### The extra fields of a real HTTP mint bundle

```ts
  // --- Phase 3B: who may sign this mint's manifests (required for an https:// mint) ---
  delegation: {
    schema: "solvent/manifest-key-delegation/v1";
    mint_url: string;                  // must equal `mint`
    mint_identity_pubkey: string;      // the NUT-06 key — must equal what <mint>/v1/info serves now
    mint_identity_xonly_pubkey: string;
    manifest_pubkey: string;           // must be the key behind masterPublicKeyHex
    valid_from_epoch: number;          // must be <= manifest.epoch_index
    created_at: number;
    signature: string;                 // BIP-340, by the NUT-06 identity (patches/cdk/0008)
  };
  reserveBinding: {
    schema: "solvent/reserve-binding/v1";
    mint_url: string; mint_identity_pubkey: string;
    epoch_index: number; manifest_digest: string; global_digest: string;   // binds THIS epoch's accounting
    reserve_statement_digest: string; reserve_pubkey: string; reserve_network: string;
    created_at: number; valid_until: number;
    signature: string;                 // BIP-340, by the manifest key
  };
  epochKeysetCount: number;            // keysets in the closed epoch; 1 is supported
```

The Nostr event of a real mint also commits to `mint_nut06_pubkey`, `manifest_key_delegation_digest`, `reserve_binding_digest`, `previous_global_digest` and `keyset_count` (`docs/nostr-schema.md`). A real example is `evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-honest-verify-input.json`. It is a real-LND bundle whose proof is recorded as spent; its `_evidence` label is metadata, ignored by the verifier.

## Where the bundle comes from

Every field is produced by a real gate in the protocol:

| Field | Produced by | Gate | Trusted, or independently checked? |
| --- | --- | --- | --- |
| `proof` | The mint's real blind-signed Cashu issuance (NUT-12) | Gate 0 | Independently checked — `verify()` recomputes the holder's own `B'`/`C'` and validates the DLEQ; a mint cannot hand you a fake identity. |
| `mint`, `keysetId`, `amountPublicKeyHex` | The mint's keyset identity | Gate 0 | Checked against `proof`/`receipt`/`manifest` consistency. |
| `receipt` | The mint's signed Proof-of-Liabilities receipt | Gate 1 | Independently checked — BIP-340 signature verified against `amountPublicKeyHex`. |
| `manifest`, `manifestSignature`, `masterPublicKeyHex` | The mint's signed, closed epoch; `masterPublicKeyHex` is the manifest signer | Gate 2 | Independently checked — BIP-340 signature verified against `masterPublicKeyHex`; liability arithmetic recomputed. For a real mint, `masterPublicKeyHex` must also be the key the NUT-06 identity delegated. |
| `issuedMmrSize`, `inclusionProof` | The epoch's issued sum-MMR | Gate 2 / Gate 3 | Independently checked — inclusion recomputed from the committed tree size, never trusted from a claimed index. |
| `reserveAttestation` | The mint's signed reserve statement | Gate 6 | Independently re-derived — see "Why this is raw evidence" above. Raw signed evidence, not a trusted claim. |
| `nostrEvent` | The mint's signed, published Nostr evidence | Gate 5 | Independently re-derived — see "Why this is raw evidence" above. Raw signed evidence, not a trusted claim. |

## Structure

```ts
{
  // --- Cashu / NUT-12 (Gate 0) ---
  proof: {
    id: string;              // keyset id
    amount: number;          // sats
    secret: string;
    C: string;                // hex, compressed point
    dleq: { e: string; s: string; r: string }; // hex — r is required for holder reconstruction
  };
  mint: string;               // mint identifier — a SOLVENT-internal label in this build, see "Is this ecash real?" above
  keysetId: string;
  amountPublicKeyHex: string; // the mint's per-amount public key for proof.amount

  // --- Signed PoL receipt (Gate 1) ---
  receipt: {
    target_epoch: number;
    signature: string;        // hex, BIP-340
  };

  // --- Signed epoch manifest (Gate 2) ---
  manifest: {
    keyset_id: string;
    unit: string;
    epoch_index: number;
    timestamp: string;                 // RFC 3339 UTC
    previous_global_digest: string;    // hex, 32 zero bytes for epoch 0
    issued_mmr_size: number;
    issued_mmr_root_hash: string;      // hex
    issued_mmr_root_sum: number;
    spent_mmr_size: number;
    spent_mmr_root_hash: string;       // hex
    spent_mmr_root_sum: number;
    outstanding_balance: number;       // issued_mmr_root_sum - spent_mmr_root_sum
    active: boolean;
    deactivation_epoch: number;
  };
  manifestSignature: string;   // hex, BIP-340, signed by the manifest key
  masterPublicKeyHex: string;  // the manifest signer (reference bundles: the reference identity; real mints: the delegated manifest key)

  // --- Inclusion (Gate 2 / Gate 3) ---
  issuedMmrSize: number;
  inclusionProof: {
    leafIndex: number;
    siblingPath: { hash: string; sum: string; isLeft: boolean }[]; // sum is a decimal string (u64 range)
    peaks: { hash: string; sum: string }[];
  } | null;                    // null: no inclusion proof for this issuance — the hero case (REFUSE_ISSUANCE_OMITTED); an invalid one is REFUSE_MMR_PROOF_INVALID

  // --- Reserve (Gate 6) — raw signed evidence, or null if the mint supplied none ---
  reserveAttestation: {
    statement: {
      network: string;               // e.g. "bitcoin-signet-mutinynet" — never claim mainnet for test-network data
      reserve_pubkey: string;        // x-only tweaked Taproot output pubkey, hex
      outpoints: { txid: string; vout: number; value_sats: number; script_pubkey_hex: string }[];
      timestamp: string;
      block_height: number;
    };
    statementSignature: string;      // hex, BIP-340, signed by the reserve key
    bindingSignature: string;        // hex, BIP-340, signed by the manifest signer (masterPublicKeyHex)
    masterPublicKeyHex: string;
  } | null;

  // --- Nostr (Gate 5) — raw signed event, or null if the mint published none ---
  nostrEvent: {
    kind: number;                    // 8181
    created_at: number;
    tags: string[][];
    content: string;                 // JSON string, schema "solvent/pol/v2" — see docs/nostr-schema.md
    pubkey: string;
    id: string;
    sig: string;
  } | null;
}
```

### Required fields (as keys — a value may legitimately be `null`)

`proof`, `mint`, `keysetId`, `amountPublicKeyHex`, `receipt`, `manifest`, `manifestSignature`, `masterPublicKeyHex`, `issuedMmrSize`, `inclusionProof`, `reserveAttestation`, `nostrEvent`. A bundle missing any of these *keys* is reported as **INCOMPLETE BUNDLE**. `inclusionProof`/`reserveAttestation`/`nostrEvent` may be explicitly `null` — that is a real, honest "this evidence was not supplied" case, not a missing field, and SOLVENT fails closed to `REFUSE_UNVERIFIABLE` for whichever leg is missing.

### A note on JSON types

`proof.amount` is a plain JSON number (sats). `inclusionProof.{siblingPath,peaks}[].sum` are decimal **strings**, not numbers — the underlying sum-MMR uses 64-bit integers that can exceed `Number.MAX_SAFE_INTEGER` in principle, so the exported bundle encodes them as strings to stay lossless; SOLVENT's own bundle reader converts these back exactly. If you're hand-constructing a bundle, use decimal strings for these two fields.

## Complete example — the captured reference case (shape A)

This is `evidence/nostr/live-demo.json`'s actual bundle — generated and published for real by `npm run live-demo` (`src/cli/live-demo.ts`), not a hand-written illustration. Unlike a `createTestEcash()` bundle, this one's Nostr event is genuinely, publicly retrievable, so pasting it into "Verify your evidence" (or clicking "Load example bundle", which loads exactly this) reaches a real `ACCEPT_VERIFIED` — for as long as the evidence stays fresh. **The binding constraint is the reserve attestation's block-height freshness window, not the Nostr event's own (much longer) validity window** — see `docs/trust-boundaries.md`'s "Effective expiry — the real number, not an assumption" section for the exact rule and the current computed value, or run `npm run verify:live-demo` for a live, current PASS/FAIL/expiry readout.

Every value below — the event id, the mint identity, the reserve outpoint, the digests, the encoded token — is a **live snapshot that changes every time `npm run live-demo` is re-run**. Don't treat any specific value on this page as still current: the canonical, always-current source is `evidence/nostr/live-demo.json` itself, which is what "Load example bundle" actually loads (never a static string baked into this page). This section shows the *shape* of a real bundle, not a value to copy by hand.

The verification bundle (structure — field names are stable, values are not; see `evidence/nostr/live-demo.json` for the current real values):

```json
{
  "mint": "solvent-fixture-mint",
  "keysetId": "<see evidence/nostr/live-demo.json>",
  "masterPublicKeyHex": "<see evidence/nostr/live-demo.json — bundle.masterPublicKeyHex>",
  "manifest": {
    "epoch_index": 12,
    "outstanding_balance": 70000,
    "issued_mmr_root_sum": 70000
  },
  "reserveAttestation": {
    "statement": {
      "network": "bitcoin-signet-mutinynet",
      "outpoints": [
        { "txid": "<see evidence/nostr/live-demo.json>", "vout": 0, "value_sats": 1000000 }
      ]
    }
  },
  "nostrEvent": {
    "kind": 8181,
    "id": "<see evidence/nostr/live-demo.json — bundle.nostrEvent.id>"
  }
}
```

`epoch_index: 12`, `outstanding_balance`/`issued_mmr_root_sum: 70000`, and `value_sats: 1000000` are structurally stable across regenerations (the demo always uses the same honest amounts); everything shown above as `<see evidence/nostr/live-demo.json>` is re-derived fresh on every `npm run live-demo` run (new event id, new mint identity, new digests, a re-signed reserve outpoint binding) and is never worth hardcoding here. The complete, exact JSON — including `proof`/`receipt`/`manifestSignature`/`inclusionProof`/all signatures — is in `evidence/nostr/live-demo.json`'s `bundle` field. See `docs/trust-boundaries.md` for the full disclosed record (relays published to, fetch-back confirmation, manifest/global digests, etc).

## Error taxonomy (manual "Verify your evidence")

Pasted text goes through the following classification, in order, before any verification runs:

| Category | Meaning | Example |
| --- | --- | --- |
| **INVALID JSON** | The text can't even be parsed, or parses to something other than an object. | Empty textarea, a trailing comma, a stray quote. |
| **INCOMPLETE BUNDLE** | Valid JSON, but one or more of the required top-level fields (listed above) is entirely absent. | `{ "proof": {...} }` with nothing else. |
| **INVALID BUNDLE** | Every required field is present, but one is structurally wrong (e.g. `proof.amount` isn't a number). | A hand-edited bundle with a typo'd field. |
| **UNSUPPORTED MINT** | Structurally valid, but `verify()` itself reports the keyset/token format isn't one SOLVENT supports. | `REFUSE_UNSUPPORTED_KEYSET` / `REFUSE_MALFORMED_TOKEN`. |
| **`REFUSE_*`** | Structurally valid and supported, but a real protocol check failed. | `REFUSE_ISSUANCE_OMITTED`, `REFUSE_RESERVE_SHORT`, etc. — see `docs/nostr-schema.md` and the reason-code table in `#/protocol`. |
| **COULD NOT COMPLETE** | A dependency (public relays, the reserve API) couldn't be reached or didn't return the evidence yet. Nothing is accepted; *Retry verification* is offered. | Offline, Esplora down, relays unreachable, evidence just published. Never reported as a shortfall or as a broken promise. |

None of these ever calls the acceptance side effect — `accept()` only ever runs after an explicit `ACCEPT_VERIFIED` decision and an explicit click on "Accept ecash."

## Unsupported mints

If a mint's evidence doesn't match this schema — missing a required field, or a field verify() can't validate against its keyset — "Verify your evidence" reports **UNSUPPORTED MINT** rather than guessing at partial support. SOLVENT does not verify arbitrary Cashu ecash from arbitrary mints; only mints that publish this exact evidence chain.
