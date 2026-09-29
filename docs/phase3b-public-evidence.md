# Phase 3B — real public solvency evidence

Phase 3A produced real closed epochs from the real CDK mint's database (`docs/epoch-lifecycle.md`). Phase 3B turns one closed epoch into public evidence that a wallet can verify end to end, before accepting ecash:

```text
real closed CDK epoch
  -> authorized manifest key      (mint NUT-06 identity delegation)
  -> real reserve statement       (live Mutinynet UTXO, reserve-control key)
  -> manifest-key reserve binding (this reserve <-> this exact epoch)
  -> kind 8181 Nostr event        (published, ACKed, fetched back by id)
  -> central verifySubmission()/verify()
  -> ACCEPT_VERIFIED / REFUSE_*
```

## Four keys, four jobs

| Key | Signs | Proves |
| --- | --- | --- |
| Mint identity (NUT-06 `pubkey`, the signatory master key) | the manifest key delegation (`docs/manifest-key-delegation.md`) | **authority**: this manifest key speaks for this mint |
| Manifest key (`SOLVENT_MANIFEST_PRIVKEY`) | epoch manifests; the reserve binding | **accounting integrity**, and which reserve backs which epoch |
| Reserve-control key (the Taproot output key of the reserve UTXO) | the reserve statement | **control** of the declared UTXO |
| Nostr key (fresh per run, never stored) | the transport event | **publication integrity** only. It grants no authority |

No key substitutes for another. Authority comes from the delegation chain, never from whoever published the Nostr event.

## When Phase 3B rules apply

They apply whenever the bundle's `mint` is an **http(s) URL**, meaning a real Cashu mint. SOLVENT's reference fixtures use plain labels (`solvent-fixture-mint`) and keep their original, documented semantics. A real mint cannot opt out: a bundle naming a mint URL is always held to every rule below.

For a real mint, `verify()` additionally requires:

1. **The mint's NUT-06 identity, observed independently.** `verifySubmission` fetches `<mint>/v1/info` itself and never reads the identity from the bundle. If it can't be observed, the result is `REFUSE_UNVERIFIABLE`.
2. **A valid delegation, checked right after the manifest signature.** A valid manifest signature is never enough on its own. The failure reasons are `REFUSE_DELEGATION_MISSING`, `…_MALFORMED`, `…_INVALID_SIGNATURE`, `…_MINT_IDENTITY_MISMATCH`, `…_MANIFEST_KEY_MISMATCH` and `…_EPOCH_OUT_OF_SCOPE`.
3. **Exactly one keyset in the epoch.** The global digest is only recomputed for single-keyset epochs. More than one gives `REFUSE_UNSUPPORTED_MULTI_KEYSET_STATE`, and a missing count gives `REFUSE_UNVERIFIABLE`. The live command also checks the mint's own `/v1/keysets` before building any evidence.
4. **A reserve bound to this epoch** (next section). Otherwise `REFUSE_RESERVE_BINDING_INVALID`.
5. **The exact published event fetched back**, and its content must commit to the delegation and reserve-binding digests. A different event carrying the same state gives `REFUSE_NOSTR_STATE_MISMATCH`.

The hero check is ordered after all of these, so a broken promise is reported as `REFUSE_ISSUANCE_OMITTED` even when every signature, the reserve and the publication are valid.

## Reserve evidence

The reserve is built from a **live** Esplora query of the existing Mutinynet reserve outpoint. It is never a configured number.

- **Statement:** network, reserve pubkey, the outpoint with its value and script, a timestamp, and the tip height. The reserve-control key signs it (`src/reserve/statement.ts`, unchanged).
- **One reserve verifier** (`evaluateReserveAttestation`), extended with two checks:
  - the statement's network must be the network actually queried;
  - every declared outpoint must be a P2TR key-path output of the attesting key (`scriptPubKey = 5120 ‖ reserve_pubkey`). Before this, any key could attest to someone else's UTXO.
- **Existing checks, unchanged:** the statement signature, the legacy key binding, block-height freshness, existence, spent state, and value/script equality against the live chain.
- **Coverage** is recomputed as the verified on-chain value against the manifest's outstanding balance. It is never read from evidence.

### `solvent/reserve-binding/v1`

The manifest key signs this binding (`src/reserve/binding.ts`) with BIP-340 over SHA256 of:

```text
u16be(len schema)||"solvent/reserve-binding/v1"  u16be(len mint_url)||mint_url
mint_identity_pubkey(33)  u64be(epoch_index)  manifest_digest(32)  global_digest(32)
reserve_statement_digest(32)  reserve_pubkey(32, x-only)
u16be(len reserve_network)||reserve_network  u64be(created_at)  u64be(valid_until)
```

It uses the same length-prefixed, fixed-width convention as the delegation. The verifier checks the signature under the **delegated** manifest key, checks every field against the decision's own values, and checks `created_at ≤ now ≤ valid_until`. A reserve statement therefore cannot be moved onto another epoch, manifest, mint or network.

## Nostr event (kind 8181, `solvent/pol/v2`)

The existing schema is unchanged. Phase 3B adds optional fields (`docs/nostr-schema.md`):

- `mint_nut06_pubkey`
- `manifest_key_delegation_digest` (SHA256 of the delegation's canonical signed bytes)
- `reserve_binding_digest`
- `previous_global_digest`
- `keyset_count`

`mint_identity` still means the manifest pubkey, which is what the `#M` tag filters on.

**Publication counts as successful only when all of the following hold:**

1. at least one relay ACKs;
2. an independent query **by event id** returns the exact event;
3. the fetched event's id recomputes and its signature verifies;
4. its content commits to the expected digests.

**The locally built event is then discarded.** The bundle given to `verifySubmission` carries the *fetched* event, and `verifySubmission` queries the relays again independently. `REFUSE_NOSTR_EVENT_NOT_FOUND` (relays reachable, event absent) and `REFUSE_NOSTR_UNAVAILABLE` (no relay reachable) stay distinct.

**Relays** are the documented `POL_RELAYS` (damus, nos.lol, nostr.band) unless `SOLVENT_NOSTR_RELAYS` overrides them. Nothing adds relays silently.

## Evidence validity is not epoch length

The demo epoch cadence (about 30 seconds, via `pol:epoch-close --every`) controls how fast a judge sees issuance turn into a closed epoch. **`SOLVENT_EVIDENCE_VALIDITY_SECONDS`** (default **3600**) controls how long signed public evidence stays inspectable. The two are independent, and the validity window is a parameter, never a constant inside a signature primitive.

## Commands

| Command | What it does |
| --- | --- |
| `cdk-mintd --work-dir … solvent delegate-manifest-key --manifest-pubkey <key> --valid-from-epoch <first epoch it signed>` | produces the delegation JSON (operator, local only) |
| `npm run phase3b:live -- <cdk-mintd.sqlite>` | the only command that publishes. It runs the honest, broken-promise, not-found and unavailable cases against a running patched mint and writes `evidence/real-pol/<run>/phase3-*.json` |
| `npm run verify:phase3b-evidence -- <dir>` | offline, deterministic replay of every recorded decision through `verifySubmission` with the recorded observations. It independently recomputes the delegation, manifest chain, global digest, reserve signature, binding, coverage, Nostr id and signature, and content bindings, and scans for secrets |

`npm test` never touches relays or the chain. `tests/epoch/phase3b.test.ts` injects those network boundaries and exercises every rule above with real cryptography.

## What the local run is and is not

`evidence/real-pol/phase3b-local-fakewallet/` was produced from:

- a real patched `cdk-mintd` (patches 0001–0008) and its real database, receipts, epochs and MMRs;
- the real mint identity delegation;
- the real Mutinynet reserve;
- real public relays and real fetch-back.

Lightning settlement was CDK's **fakewallet**. Every artifact records `lightning_backend: "fakewallet"`, and this is **not** real-LND evidence.

The verify-input bundles include the holder's proofs, which offline replay needs. Every such proof is **spent before the run ends** (swapped away, then confirmed SPENT through NUT-07, and recorded in `phase3-proofs-spent.json`), so no artifact carries live ecash. In this local fixture they were worthless fakewallet ecash from a local test mint in any case. Every artifact, including the labelled verify-input bundles (`_evidence.lightning_backend`), records its backend.

**Settlement mode is derived, not declared.** When `LND_SOURCE_REST_URL` and `LND_SOURCE_MACAROON_HEX` are set, every mint invoice is paid over real Lightning and the evidence says `lnd`. Otherwise the mint must run fakewallet and the evidence says `fakewallet`. A conflicting `SOLVENT_LIGHTNING_BACKEND` aborts the run.

Publication uses **bounded retries**: up to 3 rounds, re-sending only to relays that have not ACKed, with a 2 s and then 4 s backoff. The exact-id fetch-back is tried up to 5 times, 2 s apart. If no relay ACKs or the event can't be fetched back, the gate fails. It is never satisfied from a local copy.
