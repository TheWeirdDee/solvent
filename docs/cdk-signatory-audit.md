# CDK v0.18.1 signatory audit — Phase 2 Step 8B

Real source audit of `crates/cdk-signatory` at the pinned commit `a056e0f0f69e94f431b1aeb90d883f18c61ea4c6` (tag `v0.18.1`, same clone as `docs/cdk-integration-seams.md`). Purpose: determine whether real, mint-native PoL receipt signing (BIP-340 Schnorr over `"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch`, signed with the keyset's per-amount key — `docs/draft-alignment.md`) is possible today, and if not, the smallest safe way to add it.

## Key ownership boundary

`crates/cdk-signatory/src/signatory.rs` defines the `Signatory` trait — the **entire** interface CDK's mint core (`crates/cdk`) is allowed to use to touch key material:

```rust
pub trait Signatory {
    fn name(&self) -> String;
    async fn blind_sign(&self, blinded_messages: Vec<BlindedMessage>) -> Result<Vec<BlindSignature>, Error>;
    async fn verify_proofs(&self, proofs: Vec<Proof>) -> Result<(), Error>;
    async fn keysets(&self) -> Result<SignatoryKeysets, Error>;
    async fn subscribe_keysets(&self) -> Result<tokio::sync::watch::Receiver<SignatoryKeysets>, Error>;
    async fn rotate_keyset(&self, args: RotateKeyArguments) -> Result<SignatoryKeySet, Error>;
}
```

**Finding 1 — no generic signing operation exists today.** `blind_sign()` performs CDK's specific BDHKE blind-signing (`C' = a·B'`, a scalar multiplication of a blinded elliptic-curve point — `crates/cashu/src/dhke.rs:167`), not a general-purpose "sign this message" operation. There is no method on this trait that accepts an arbitrary message and returns a standard signature. **Option A (existing API already supports it) is ruled out by direct inspection, not assumed.**

## Where the real private keys live

`crates/cdk-signatory/src/db_signatory.rs` — `DbSignatory` is "the default signatory implementation for the mint" (its own doc comment). Relevant fields:

```rust
pub struct DbSignatory {
    keysets: ArcSwap<KeysetSnapshot>,   // KeysetSnapshot.by_id: HashMap<Id, (MintKeySetInfo, MintKeySet)>
    rotation_lock: Mutex<()>,
    localstore: Arc<dyn database::MintKeysDatabase<...>>,
    secp_ctx: Secp256k1<secp256k1::All>,
    xpriv: Xpriv,   // master extended private key, derived from the mint's seed
    xpub: PublicKey,
    ...
}
```

`MintKeySet` (inside `KeysetSnapshot.by_id`) holds the actual derived per-amount keypairs. `blind_sign()`'s real implementation (`db_signatory.rs:346-381`):

```rust
let (info, key) = keysets.by_id.get(&keyset_id).ok_or(Error::UnknownKeySet)?;
let key_pair = key.keys.get(&amount).ok_or(Error::UnknownKeySet)?;
let c = sign_message(&key_pair.secret_key, &blinded_secret)?;
```

`key_pair.secret_key` is the exact real per-amount scalar the draft's receipt scheme needs signed with — the same key `blind_sign` itself uses for that amount/keyset. It is loaded once (`boot_load()`) and held in an `ArcSwap` inside `DbSignatory`, never exposed outside this struct.

## Isolation architecture (even in "embedded" mode)

`crates/cdk-signatory/src/embedded.rs` — even CDK's in-process ("embedded") signatory mode is not a direct function call. `Service::new(handler: Arc<dyn Signatory>)` spawns the real `DbSignatory` handler into its **own dedicated tokio task**, and every trait method is proxied through an `mpsc` channel (`Request::BlindSign`, `Request::VerifyProof`, etc. → `oneshot` reply). The mint core never holds a reference to `DbSignatory` itself, only to `Service`, which only forwards typed requests. This is a deliberate, existing isolation layer — the doc comment calls it "an extra layer of security to move the keys to another layer."

`crates/cdk-signatory/src/proto/{client,server}.rs` additionally implement a **remote** signatory mode (gRPC) for running the signatory as a fully separate process/machine. Phase 1/Phase 2's `cdk-mintd --work-dir` configuration uses the embedded mode (single binary, single `--work-dir`, no separate signatory endpoint configured) — the remote mode is real but out of scope here.

## `SecretKey::sign()` already exists — no new cryptography needed

`crates/cashu/src/nuts/nut01/secret_key.rs:87-91`:

```rust
/// Schnorr Signature on Message
pub fn sign(&self, msg: &[u8]) -> Result<Signature, Error> {
    let hash: Sha256Hash = Sha256Hash::hash(msg);
    let msg = Message::from_digest_slice(hash.as_ref())?;
    Ok(SECP256K1.sign_schnorr(&msg, &Keypair::from_secret_key(&SECP256K1, &self.inner)))
}
```

This is exactly `docs/draft-alignment.md`'s scheme: BIP-340 Schnorr over `SHA256(message)`. It is on the **same `SecretKey` type** `key_pair.secret_key` already is (`crates/cashu/src/nuts/nut01/secret_key.rs`, used elsewhere in the same crate for NUT-11/NUT-14/NUT-20/NUT-29 signatures — an already-shipped, already-tested primitive, not new code to write or a new dependency to add).

## Answer: the smallest safe extension

**Chosen: Option B — minimal `Signatory` trait extension**, not a patch to embedded/protocol plumbing, not a fork:

1. Add one method to the `Signatory` trait: `async fn sign_pol_receipt(&self, keyset_id: Id, amount: Amount, message: Vec<u8>) -> Result<Signature, Error>;`
2. Implement it in `DbSignatory` (`db_signatory.rs`) — a ~5 line body, identical key lookup to `blind_sign()`'s first two lines, then `key_pair.secret_key.sign(&message)`.
3. Add one `Request::SignPolReceipt` variant to `embedded.rs`'s existing `Request` enum and one match arm in `Service::runner()` — mechanical, follows the exact existing pattern for every other method.
4. `proto/{client,server}.rs` (remote signatory mode) is **not** touched — out of scope, since Phase 1/2's deployment uses embedded mode only. Recorded here as a known gap for anyone deploying with a remote signatory.

This is real, minimal, and reuses 100% existing, already-shipped cryptography (`SecretKey::sign`) and 100% of the existing key-isolation architecture (the same `ArcSwap`, the same actor-model channel boundary). It does not touch `blind_sign()`, does not change any existing wire format, and does not expose `key_pair.secret_key` outside `DbSignatory` at any point — the new method returns only a `Signature` (public output), exactly as `blind_sign()` returns only a `BlindSignature`, never the key itself.

**This is still, unambiguously, a patch to CDK's own source** (unlike the Step 2 database seam, which needed none). It is recorded honestly as such — see `DECISIONS.md`'s Phase 2 Step 8C entry for the reproducibility mechanism (a small, checked-in patch file against the pinned `v0.18.1` source, not a fork, not a rebuild of anything beyond the one crate that changes).

## The atomicity question, answered

**Can the signed receipt be generated before the economic DB transaction commits?** Yes, safely, by mirroring how `blind_sign()` itself already works: `process_mint_request()` (`issue/mod.rs`) calls `blind_sign()` *before* `tx.begin_transaction()` — the resulting `BlindSignature`s are held as plain in-process Rust values and are only ever returned to the caller in the final `Ok(MintResponse { signatures, .. })`, which is only reached *after* `tx.commit().await?` succeeds. If commit fails, the function returns early via `?` and the already-computed signatures are simply dropped — never sent over the network, never becoming real proofs anyone can spend. `sign_pol_receipt()` can be called the same way, at the same point, with the same safety property: a receipt computed before commit is inert, in-process-only data until commit succeeds.

**But that only solves "no orphan receipt leaks out before commit." It does not solve "the receipt is safely durable after commit."** This is the distinct problem the accounting-fact SQL trigger does *not* cover, because the trigger only fires on CDK's own table writes — a signed receipt computed in Rust-process memory *after* `tx.commit()` returns is not itself written by that trigger. If the mint process crashes in the narrow window between "commit succeeded" and "the receipt bytes are durably persisted," the issuance is real and durably accounted (the trigger already guaranteed that), but the specific receipt for it could be lost.

**Resolution — a small, genuine transactional outbox, layered on top of (not replacing) the trigger:** the trigger that fires on a `blind_signature` insert writes a `solvent_pol_receipt` row with `status = 'pending'` (no signature yet) as part of the *same* CDK transaction — this row's existence is trigger-atomic, same as the liability row itself. A separate, idempotent SOLVENT worker later calls the new `sign_pol_receipt()` signatory method for each `pending` row and updates it to `status = 'signed'` with the resulting signature. If the worker crashes between signing and persisting, it simply retries against the same still-`pending` row on next run — re-signing is safe (the signed message is deterministic even though the Schnorr nonce is not, so a retry produces a different but equally valid signature over the identical message, never a duplicate accounting fact). **Accounting-fact atomicity and receipt-signing durability are solved by two different mechanisms** — exactly the distinction Phase 2 Step 8 required not be hidden. Full schema: `docs/accounting-model.md`.

## What remains unaudited

`crates/cdk-signatory/src/proto/{client,server}.rs` (the remote/gRPC signatory mode) — not read in this pass, since Phase 1/2's deployment topology never uses it. If a future phase deploys the signatory as a separate process, this trait extension would need a matching protobuf message/RPC added there too; not designed here.
