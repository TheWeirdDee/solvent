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

## The exact real call chain (Phase 2 continuation — traced one level deeper)

Confirmed by reading the real code at every hop, not assumed:

```
cdk-axum's router (POST /v1/mint/bolt11)
    ↓
Mint::process_mint_request()          crates/cdk/src/mint/issue/mod.rs:677
    ↓ self.blind_sign(input.outputs().to_vec())
Mint::blind_sign()                    crates/cdk/src/mint/mod.rs:1321
    ↓ self.signatory.blind_sign(blinded_message).await
Arc<dyn Signatory>                     — in cdk-mintd's real deployment, this is embedded::Service
    ↓ Request::BlindSign over an mpsc channel
Service::runner()                     crates/cdk-signatory/src/embedded.rs:62
    ↓ handler.blind_sign(blinded_message).await
DbSignatory::blind_sign()             crates/cdk-signatory/src/db_signatory.rs:346
    ↓ keysets.by_id.get(&keyset_id) → key.keys.get(&amount) → key_pair.secret_key
sign_message(&key_pair.secret_key, &blinded_secret)   crates/cashu/src/dhke.rs:167
```

`sign_pol_receipt()` would follow the identical chain, one new hop at each layer (`Mint::sign_pol_receipt()` → `Signatory::sign_pol_receipt()` → `Request::SignPolReceipt` → `DbSignatory::sign_pol_receipt()` → `key_pair.secret_key.sign(&message)`), reusing every existing isolation layer as-is.

**Questions answered precisely, from the real source:**

1. **What public information uniquely selects the required private amount key?** `keyset_id: Id` + `amount: Amount` — nothing else.
2. **Is selection `keyset_id + amount`, or something else?** Confirmed exactly that: `keysets.by_id.get(&keyset_id)` (a `HashMap<Id, (MintKeySetInfo, MintKeySet)>`) then `key.keys.get(&amount)` (`MintKeySet.keys: MintKeys`, a per-amount map — `crates/cashu/src/nuts/nut02.rs:597-609`).
3. **Can a caller request signing with a nonexistent/inactive/wrong keyset?** The request can be *made*; `DbSignatory` refuses it with typed errors before ever touching key material — see next answer. Applying `blind_sign()`'s identical checks to `sign_pol_receipt()` is not just safe but semantically required: a receipt can only legitimately exist for a keyset/amount that could also have produced a real blind signature, so reusing the exact same gate is correct, not merely convenient.
4. **What validation must occur before signing?** Real code, `db_signatory.rs:361-366`: keyset must exist (`Error::UnknownKeySet`), must be `active` (`Error::InactiveKeyset`), must not be expired (`Error::ExpiredKeyset`), and the requested amount must exist within that keyset (`Error::UnknownKeySet`). `sign_pol_receipt()` reuses all four checks verbatim.
5. **Does the signatory already distinguish active/inactive/expired/historical keysets?** Yes — `MintKeySetInfo.active: bool` and `.is_expired()` (via `final_expiry`) are both real, already-tracked fields; inactive-but-not-expired (historical) keysets remain present in `by_id`, just flagged inactive. This is also the real evidence P2-I14 (retired keysets with outstanding proofs remain part of outstanding liabilities) is buildable against later — the signatory itself never forgets a rotated-out keyset.
6. **What errors are returned?** `Error::UnknownKeySet`, `Error::InactiveKeyset`, `Error::ExpiredKeyset` — real, existing `cdk_common::Error` variants, reused as-is rather than inventing new ones.
7. **Embedded only, or also remote signatory?** Embedded only. The remote/gRPC mode (`crates/cdk-signatory/src/proto/{client,server}.rs`) has its own separate protobuf-defined request/response surface; supporting it would need a matching new RPC method there too — a distinct, additional patch this phase does not make, since Phase 1/2's deployment (`cdk-mintd --work-dir`, no remote signatory endpoint configured) never uses remote mode. Recorded as a known gap, not silently ignored.

## Answer: the smallest safe extension

**Chosen: Option B — minimal `Signatory` trait extension**, not a patch to embedded/protocol plumbing, not a fork:

1. Add one method to the `Signatory` trait: `async fn sign_pol_receipt(&self, keyset_id: Id, amount: Amount, message: Vec<u8>) -> Result<Signature, Error>;`
2. Implement it in `DbSignatory` (`db_signatory.rs`) — a ~5 line body, identical key lookup to `blind_sign()`'s first two lines, then `key_pair.secret_key.sign(&message)`.
3. Add one `Request::SignPolReceipt` variant to `embedded.rs`'s existing `Request` enum and one match arm in `Service::runner()` — mechanical, follows the exact existing pattern for every other method.
4. `proto/{client,server}.rs` (remote signatory mode) is **not** touched — out of scope, since Phase 1/2's deployment uses embedded mode only. Recorded here as a known gap for anyone deploying with a remote signatory.
5. **(Continuation, once the draft's synchronous-delivery requirement was confirmed — see below)** `process_mint_request()` (`crates/cdk/src/mint/issue/mod.rs`) additionally calls `sign_pol_receipt()` once per output, alongside `blind_sign()`, before the transaction opens; and `add_blind_signatures()` (`crates/cdk-sql-common/src/mint/signatures.rs`) is extended to accept those receipt signatures and write them into `solvent_pol_receipt` inside the same transaction. The patch surface is three files, not one, once real delivery semantics are taken into account.

This is real, minimal, and reuses 100% existing, already-shipped cryptography (`SecretKey::sign`) and 100% of the existing key-isolation architecture (the same `ArcSwap`, the same actor-model channel boundary). It does not touch `blind_sign()`, does not change any existing wire format, and does not expose `key_pair.secret_key` outside `DbSignatory` at any point — the new method returns only a `Signature` (public output), exactly as `blind_sign()` returns only a `BlindSignature`, never the key itself.

**This is still, unambiguously, a patch to CDK's own source** (unlike the Step 2 database seam, which needed none). It is recorded honestly as such — see `DECISIONS.md`'s Phase 2 Step 8C entry for the reproducibility mechanism (a small, checked-in patch file against the pinned `v0.18.1` source, not a fork, not a rebuild of anything beyond the one crate that changes).

## The atomicity question, answered (revised — the draft requires synchronous, in-response delivery)

**Correction, Phase 2 continuation**: re-reading `pol.md`'s "Signed Transactional Proof of Liability Receipts" section directly (not the Phase-1 fixture summary) found: *"the mint **MUST** return a signed PoL receipt for every spent input and returned output"*, delivered *nested in `pol_receipt` of each `BlindSignature` inside the same `/v1/mint/{method}` response* (see `docs/draft-alignment.md`'s correction table). An asynchronous, separately-signed-later outbox does not satisfy this — the receipt must exist by the time the mint's own HTTP response is constructed. The design below replaces the earlier async-worker sketch.

**Can the signed receipt be generated before the economic DB transaction commits?** Yes — by mirroring how `blind_sign()` itself already works: `process_mint_request()` (`issue/mod.rs`) calls `blind_sign()` *before* `tx.begin_transaction()`, and the resulting `BlindSignature`s are inert, in-process-only values until they're returned in the final `Ok(MintResponse { signatures, .. })` *after* `tx.commit().await?` succeeds. `sign_pol_receipt()` is called the same way, at the same point, for the same reason: if commit never happens, the already-computed signature is simply dropped, never sent over the network.

**The real remaining question is not "before or after commit" (both signatures are computed before commit, exactly like `blind_sign()` already does) — it's "who writes the already-computed receipt signature into `solvent_pol_receipt`, and when."** A passive SQL trigger cannot do this: it only ever sees columns already present on the row that fired it, and by the time `add_blind_signatures()` issues its `INSERT`/`UPDATE` on `blind_signature`, the receipt signature has already been computed in Rust but has nowhere to land in that statement. The patch therefore extends `add_blind_signatures()` itself (`crates/cdk-sql-common/src/mint/signatures.rs`) to accept the already-computed receipt signatures alongside the blind signatures, and — using the exact same already-open `self.inner` connection that function already writes `blind_signature` rows through — issue one additional `UPDATE solvent_pol_receipt SET status = 'signed', signature_hex = ... WHERE liability_id = (SELECT id FROM solvent_issued_liability WHERE blinded_message_hex = ...)` per output, in the exact same transaction. The trigger still creates the `pending` row (unchanged, no CDK-side awareness of SOLVENT's schema needed for that part); the patch's one new statement flips it to `signed` before that same transaction commits. No separate worker, no separate crash window between "signed" and "durable" — signing and durability land in the same commit, because both now happen through the same connection CDK's own write already uses.

**Accounting-fact atomicity (Step 2/7, unchanged) and receipt-signing durability (this section) are still conceptually two different guarantees** — the first from a passive trigger requiring zero CDK awareness, the second from a small, explicit patch that does require CDK's own write path to carry the already-computed signature through — but they now land in the *same* transaction rather than two separate ones. Full schema: `docs/accounting-model.md`.

## Signing-oracle audit (Phase 2 Step 8 closure)

Confirmed by re-reading the final patch set as a whole, not assumed:

- **`sign_pol_receipt()` is never reachable via any public HTTP route.** `crates/cdk-axum`'s router (`crates/cdk-axum/src/lib.rs`) has exactly one new route, `GET /v1/solvent/pol-receipt/{blinded_message}` (`patches/cdk/0005-*.patch`), and its handler (`get_solvent_pol_receipt`) calls `Mint::get_pol_receipt()` — a **read-only lookup** of an already-signed row. Nothing in the new route ever calls `sign_pol_receipt()`, `Mint::sign_pol_receipt()`, or the signatory. Signing happens in exactly two places, both entirely server-side, both unreachable from any request body a caller controls: `process_mint_request()` (`crates/cdk/src/mint/issue/mod.rs`, called only from CDK's own existing `/v1/mint/{method}` handlers) and `recover_pending_pol_receipts()` (`crates/cdk/src/mint/mod.rs`, called only from `cdk-mintd`'s own startup sequence).
- **The message being signed is never caller-supplied.** Both call sites construct it themselves — `format!("Cashu_PoL_Receipt_Issued:{}:0", output.blinded_secret.to_hex())` in `process_mint_request()`, and the exact bytes already durably stored in `solvent_pol_receipt.message` (itself written only by the SQL trigger, from `NEW.blinded_message`) in the recovery path. There is no code path, anywhere in this patch set, where a `POST` body's bytes flow into the `message` argument of `sign_pol_receipt()`. This is not a generic "sign this Schnorr message for me" oracle; the message shape is fixed by the mint's own code, not the caller's.
- **The retrieval endpoint cannot be used to request signing of anything.** It takes one path parameter (a blinded-message hex string) and performs a `SELECT`, never an `INSERT`/`UPDATE`. Querying an unknown or not-yet-signed blinded message returns `{"status": "unknown"}` or `{"status": "pending"}` — it never triggers signing as a side effect.

**Conclusion**: the patch set does not turn the mint into a generic Schnorr signing oracle. The only two callers of `sign_pol_receipt()` are internal, and both construct the message themselves from data the mint's own real NUT-04 operation (or its own durable receipt table) already produced.

## What remains unaudited

`crates/cdk-signatory/src/proto/{client,server}.rs` (the remote/gRPC signatory mode) — not read in this pass, since Phase 1/2's deployment topology never uses it. If a future phase deploys the signatory as a separate process, this trait extension would need a matching protobuf message/RPC added there too; not designed here.
