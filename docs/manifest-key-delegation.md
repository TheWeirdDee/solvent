# Mint identity → manifest key delegation (Phase 3B trust root)

SOLVENT epoch manifests are signed by a dedicated **manifest key** (`SOLVENT_MANIFEST_PRIVKEY`, see `docs/epoch-lifecycle.md`). A manifest signature alone proves nothing about *which mint* stands behind it: anyone can generate a key and sign a manifest. This document defines how the mint's own identity authorizes that key, so a wallet can check the chain:

```text
NUT-06 /v1/info "pubkey"  (the mint's identity, compressed secp256k1)
   │  x-only form = its 32-byte x coordinate  (BIP-340 authority)
   ▼
manifest key delegation   (signed by the mint identity key)
   │  authorizes manifest_pubkey from valid_from_epoch
   ▼
epoch manifest            (signed by manifest_pubkey)
```

A manifest is never accepted just because its own signature is valid.

## What the mint identity key is

Traced in the pinned CDK source (v0.18.1, `a056e0f0`):

| Question | Answer | Where |
| --- | --- | --- |
| Where does the NUT-06 `pubkey` come from? | `DbSignatory.xpub`, the public key of the BIP32 **master** key `Xpriv::new_master(Network::Bitcoin, seed)` | `crates/cdk-signatory/src/db_signatory.rs` (`DbSignatory::new`, `keysets_snapshot`) |
| How does it reach `/v1/info`? | `Mint` copies `signatory.keysets().pubkey` into `mint_info.pubkey` when the config leaves it unset | `crates/cdk/src/mint/mod.rs` (the `computed_info.pubkey = Some(keysets.pubkey)` branch) |
| Can a configured pubkey differ from it? | No. cdk-mintd refuses a configured pubkey that is not the signing identity, at import and again at startup | `crates/cdk-mintd/src/config_service.rs` (`validate_authored_mint_pubkey`), `crates/cdk-mintd/src/lib.rs` (`ensure_signatory_identity`) |
| Is it a keyset key? | No. Keyset amount keys are child keys derived from this master | `MintKeySet::generate_from_xpriv` |
| Is it the Lightning node key? | No. That is LND's own key | — |
| Could it sign arbitrary messages before patch 0008? | No. The `Signatory` trait had no method that uses `xpriv` to sign | `crates/cdk-signatory/src/signatory.rs` |

The local regtest mint uses the public BIP-39 test mnemonic `abandon … about`. The BIP32 master pubkey of that seed and the pubkey its `/v1/info` serves are both `03d902f35f560e0470c63313c7369168d9d7df2d49bf295fd9fb7cb109ccee0494`.

## Patch 0008

[`patches/cdk/0008-sign-manifest-key-delegation-with-mint-identity.patch`](../patches/cdk/0008-sign-manifest-key-delegation-with-mint-identity.patch) adds exactly one identity-key capability.

- **`Signatory::sign_manifest_key_delegation(mint_url, manifest_pubkey, valid_from_epoch, created_at)`.** The caller passes typed fields only. The default implementation returns *not supported*, so it fails closed.
- **`DbSignatory` implements it.** It builds the message itself with `manifest_key_delegation_message`, inserting its own `xpub` as the identity, and signs with the master key through the same `SecretKey::sign` (BIP-340 over `SHA256(message)`) used for PoL receipts. It verifies the signature against `xpub` before returning, and returns only the public fields and the signature.
- **The embedded `Service` forwards it** over the same actor channel as every other signatory request.
- **The operator CLI is the only entry point:** `cdk-mintd --work-dir <dir> solvent delegate-manifest-key --manifest-pubkey <66-hex> --valid-from-epoch <N>`. It loads the stored configuration exactly as daemon startup does, builds the same signatory from the same seed, runs `ensure_signatory_identity`, and prints the delegation JSON. There is **no HTTP route and no gRPC RPC**.
- **Remote (gRPC) signatory: not supported.** `SignatoryRpcClient` uses the trait default, so the command fails with *not supported*. Adding a matching RPC would be a separate, deliberate change.

## Canonical encoding

Schema `solvent/manifest-key-delegation/v1`. The signed bytes are:

```text
u16be(len(schema))   || schema                  UTF-8, "solvent/manifest-key-delegation/v1"
u16be(len(mint_url)) || mint_url                UTF-8
mint_identity_pubkey                            33 bytes, compressed SEC1
manifest_pubkey                                 33 bytes, compressed SEC1
u64be(valid_from_epoch)
u64be(created_at)                               Unix seconds
```

- **Signature:** BIP-340 Schnorr over `SHA256(message)`, verified with the x-only form of `mint_identity_pubkey`, which is bytes 1..33 of the compressed key.
- **Domain separation:** the schema string is the first field. Every other SOLVENT signed message begins differently: receipts start with `Cashu_PoL_Receipt_…`, and manifests are colon-joined fields starting with the keyset id. The mint identity key signs nothing else at all.
- **Rules that both encoders enforce:** the mint URL must be a non-empty `http(s)` URL; `valid_from_epoch` must be at least 1 (SOLVENT epochs start at 1); `created_at` must be at least 1; the manifest key must not equal the identity key.
- **Cross-language vector:** the Rust test `canonical_encoding_vector` and `tests/epoch/delegation.test.ts` both pin the same 140-byte hex.

Output JSON (all public):

```json
{
  "schema": "solvent/manifest-key-delegation/v1",
  "mint_url": "http://127.0.0.1:8085",
  "mint_identity_pubkey": "03d902f3…0494",
  "mint_identity_xonly_pubkey": "d902f3…0494",
  "manifest_pubkey": "0394d083…134f",
  "valid_from_epoch": 1,
  "created_at": 1790692123,
  "signature": "d41728b4…2c95"
}
```

`mint_identity_xonly_pubkey` is a convenience copy. The verifier recomputes it from `mint_identity_pubkey` and rejects any mismatch.

## Verification (`src/epoch/delegation.ts`)

`verifyManifestKeyDelegation(delegation, { mintUrl, mintIdentityPubkey, manifestPubkey, epochIndex })` checks, in order:

1. the schema and well-formed fields;
2. that both keys are strict compressed curve points and differ from each other;
3. that `mint_url` equals the mint being verified;
4. that `mint_identity_pubkey` equals that mint's NUT-06 `pubkey`;
5. that the optional x-only copy matches the derived one;
6. the BIP-340 signature over the canonical bytes;
7. that `manifest_pubkey` is the key that signed the manifest;
8. that `epochIndex >= valid_from_epoch`.

`verifyDelegatedManifest(...)` runs these checks and then verifies the manifest signature under the delegated key. It returns a specific reason for each failure (`DELEGATION_*` or `MANIFEST_SIGNATURE_INVALID`).

## Signing-oracle audit

After patch 0008, can an untrusted caller make the mint identity key sign the following?

| Target | Answer | Why |
| --- | --- | --- |
| Arbitrary bytes | **No** | The only identity-signing method takes typed fields, and the signatory builds the message itself |
| An arbitrary hash | **No** | The signed digest is always `SHA256` of a message beginning with the fixed schema |
| A Nostr event | **No** | A Nostr event id is SHA256 of a JSON array beginning with `[0,`, never a length-prefixed schema |
| A reserve statement | **No** | Reserve statements are signed by the reserve key, and bindings by the manifest key. The identity key only ever signs the delegation format |
| A Bitcoin transaction | **No** | Sighash formats are never produced by this code path |
| A Cashu proof or blind signature | **No** | Blind signing uses keyset keys, not the master key, and this method signs nothing blinded |
| Anything outside the delegation domain | **No** | There is no other identity-signing path. Nothing is reachable over HTTP or gRPC, and the CLI needs local access to the mint's work directory and seed configuration |

**Verdict: no signing oracle.** The one remaining power, "issue a delegation for a key of the caller's choice", belongs to whoever already controls the mint's work directory and seed, and that operator could sign anything with the seed anyway.

## Tests

- **Rust** (`cargo test -p cdk-signatory --lib solvent_manifest_key_delegation`):
  - the identity is the seed's master key and equals `keysets().pubkey` (J);
  - a valid delegation verifies (A);
  - every field is bound (B–E) and no other bytes verify (H);
  - an unrelated mint fails (F);
  - invalid fields are refused;
  - the cross-language vector;
  - an unsupported signatory fails closed (I).
- **TypeScript** (`tests/epoch/delegation.test.ts`):
  - A–G, J, K and L;
  - epoch scope and x-only consistency;
  - a fixture signed by a real local patched cdk-mintd (fakewallet Lightning, irrelevant to identity signing), verified against that mint's NUT-06 pubkey, with a different manifest key rejected.
