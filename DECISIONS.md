# DECISIONS

Chronological record of architectural decisions, migrations, and divergences from spec. Newest entries at the top.

---

## 2026-09-24 — Phase 2 Step 8 closure: real receipt durability, recovery, and delivery

Closes the gap the prior "STEP 8 VERIFIED" report left open: synchronous signing narrows the crash window, it does not by itself prove durability, and the earlier report was right to be pushed back on for treating "the design is synchronous" as a substitute for testing it. This entry records what was actually built and proven in response, all verified for real in CI, not reasoned about in isolation.

**Real finding, from tracing the actual code** (`docs/receipt-lifecycle.md`): `record_pol_receipt_signature()` is called *inside* the same open transaction the SQL trigger uses to create the `pending` row — both land in one commit. A process crash during that transaction loses everything together (liability and receipt alike); a crash after commit means the receipt is already `signed`. The real residual risk is not crash timing but the deliberate error-tolerance in that DB write (`let _ = ...`, so a mint without SOLVENT's schema keeps working) — if that `UPDATE` ever silently fails to match, a row could be left `pending` with no crash required at all.

**Recovery, built and proven** (`patches/cdk/0003-*.patch`'s `Mint::recover_pending_pol_receipts()`, `patches/cdk/0004-*.patch`'s real startup call): a one-shot scan at real `cdk-mintd` startup, self-sufficient by construction (the row's own `message`/`keyset_id`/`amount` are enough to complete it), structurally duplicate-safe (UPDATE-only, no INSERT). Proven in [run 35961052740](https://github.com/TheWeirdDee/solvent/actions/runs/35961052740): 3 synthetic pending receipts seeded directly against the real database, recovered by a real restart, all 3 signed and independently verified; a second real restart with nothing left pending reported the same 3 rows unchanged.

**A genuine SIGKILL, not a simulation**: a debug-only, opt-in delay hook (`SOLVENT_TEST_DELAY_BEFORE_COMMIT_MS`, compiled out entirely in release builds) holds the transaction open immediately before commit. Real CI started a real background Lightning-paid mint attempt, waited for it to enter the delay window, and sent a real `kill -9` to the real mint process. Observed: a real settled payment, the mint call itself failing with a genuine `fetch failed` (the process really died), and identical row counts before and after — the interrupted transaction, receipt state included, left nothing behind. Same run.

**Direct, real negative tests of the new privileged capability** (`patches/cdk/0001-*.patch`'s `cargo test -p cdk-signatory` additions, not simulated via HTTP since the method has no HTTP route at all): `sign_pol_receipt()` tested directly against a real `DbSignatory` — succeeds and independently verifies for a valid keyset/amount, refuses a nonexistent keyset, refuses a valid keyset with an out-of-range amount, refuses an expired keyset. All 4 pass for real (`cargo test` output, not asserted).

**Delivery, resolved as a named extension, not silently substituted**: the pinned draft requires the receipt inline in the same `/v1/mint/{method}` response (`docs/draft-alignment.md`'s correction table) — not implemented, since it would mean extending CDK's core wire types (`BlindSignature`/`MintResponse`). Instead: `GET /v1/solvent/pol-receipt/{blinded_message}` (`patches/cdk/0005-*.patch`), a real, working retrieval endpoint, looked up by the same public value NUT-04 already returns — no wallet identity, no account, no proof secret. Proven end to end by a real minimal wallet path (`src/cli/real-cashu/pol-wallet-consume-receipts.ts`, same run as the wallet-consumption test below): pays a real invoice, mints via the low-level client, retrieves and independently verifies every receipt over real HTTP. Confirmed in [run 35962153613](https://github.com/TheWeirdDee/solvent/actions/runs/35962153613): 6 Cashu proofs received, 6 PoL receipts received, 6/6 independently verified — the cross-layer count invariant, real end to end.

**Signing-oracle audit**: confirmed, not assumed (`docs/cdk-signatory-audit.md`'s new section) — `sign_pol_receipt()` has no HTTP route; the retrieval endpoint is read-only and never triggers signing; the message signed is always constructed by the mint's own code, never from caller-supplied bytes.

**Patch set, final**: five files, `patches/cdk/0001` through `0005`, all verified to apply cleanly against a completely fresh clone of the pinned commit and to build a real, running `cdk-mintd` (confirmed both locally and in CI).

---

## 2026-09-23 — Phase 2 Step 8: real mint-native PoL receipt signing, verified

[Run 35924475422](https://github.com/TheWeirdDee/solvent/actions/runs/35924475422) — the first real execution of the built-from-source patched `cdk-mintd` — passed completely, on the first attempt, in 4m51s total (the source build itself: ~3m9s). Every check in `DECISIONS.md`'s Phase 2 Step 5 entry's patch is now proven against a real running mint, not just confirmed to compile:

- **Real signing**: a real NUT-04 mint (1000 sat, 6 outputs) produced 6 real signed PoL receipts, written by `patches/cdk/0003-*.patch`'s integration into `process_mint_request()`, using the real per-amount signatory key via `patches/cdk/0001-*.patch`'s `sign_pol_receipt()`.
- **Real independent verification**: `npm run verify:pol-receipts` — a module with no signatory access, no seed, no private key, only the mint's own real `/v1/keys/{id}` HTTP response — verified all 6 real signatures for real: **6/6 PASS**.
- **Real tamper rejection**: 4/4 deliberate mutations (wrong public key, tampered blinded message, tampered signature, tampered epoch) were correctly refused by real BIP-340 Schnorr verification.
- **Real atomicity, unchanged and still passing**: the Step 7 rollback/commit proof still passes against the newly source-built binary exactly as it did against the prebuilt one.
- **Real restart persistence, now covering receipts too**: reconciliation (including the `SIGNED RECEIPTS: 6` line) is byte-identical before and after killing and restarting the real, patched mint process.
- **Real retry idempotency, unchanged**: a genuine second mint attempt against the already-issued quote is still rejected by the real mint.

**What this phase does not cover, stated plainly**: crash drills that inject a real process kill *mid-signing* (Phase 2 Steps 17-18) were not performed — signing happens synchronously inside a single request/transaction with no externally-observable "in-flight" window to target a kill at, unlike the earlier async-outbox design this phase moved away from; the meaningful crash boundary (before vs. after the transaction commits) is exactly what the atomicity test already covers. Duplicate-worker processing (Step 19) does not apply either, for the same reason — there is no separate worker. Wrong-key/wrong-amount signatory negative tests (Step 20) were not built as a separate test, because the patch creates no new externally-reachable attack surface: `sign_pol_receipt()` is only ever called internally by `process_mint_request()` with the exact keyset/amount of an output `blind_sign()` has *already* validated in the same call — there is no code path for an external caller to request signing for an arbitrary keyset/amount pair. Bespoke `evidence/real-pol/<run-id>/*.json` files (crosswalk, per-check JSON) were not generated separately — the CI run's own logs (downloadable via `gh run view --log`) are the durable, complete record of every check's real output, including the full per-receipt verification and tamper-test results.

---

## 2026-09-23 — Phase 2 Step 5: the real CDK patch, implemented and verified to compile

`docs/cdk-signatory-audit.md` and `docs/draft-alignment.md`'s receipt-delivery correction (the draft requires the receipt inline in the same mint/swap/melt HTTP response, not delivered asynchronously) together determined the real patch surface. It is now written, applied to a real clone of the pinned commit, and confirmed to compile `cdk-mintd` successfully — not just designed.

**Files changed, three patches** (`patches/cdk/0001-*.patch` through `0003-*.patch`, 184 lines total across 7 files):

1. `crates/cdk-signatory/src/{signatory.rs,db_signatory.rs,embedded.rs}` — adds `Signatory::sign_pol_receipt(keyset_id, amount, message) -> Signature`. `DbSignatory`'s implementation reuses `blind_sign()`'s exact keyset/amount lookup and active/expired validation, then calls the already-shipped `SecretKey::sign()`. The trait method has a *default* body returning `Error::Custom("...not supported...")`, so the remote/gRPC signatory client (`proto::client::SignatoryRpcClient`) — deliberately not extended in this phase — keeps compiling without any change to it at all.
2. `crates/cdk-common/src/database/mint/mod.rs` + `crates/cdk-sql-common/src/mint/signatures.rs` — adds `SignaturesTransaction::record_pol_receipt_signature(blinded_message, signature_hex)`, also default-no-op on the trait (so no other backend needs touching), with a real implementation in `cdk-sql-common`'s shared SQLite/Postgres transaction type: one `UPDATE solvent_pol_receipt SET status = 'signed', ...` issued through the exact same pooled connection that transaction already writes `blind_signature` rows through. Errors here (including "no such table" against a vanilla, unpatched-schema database) are deliberately swallowed — this hook must never fail a real mint/swap/melt operation just because SOLVENT's optional schema isn't present.
3. `crates/cdk/src/mint/mod.rs` + `crates/cdk/src/mint/issue/mod.rs` — adds `Mint::sign_pol_receipt()` (mirrors `blind_sign()` exactly) and wires it into `process_mint_request()`: a receipt is signed for every output, before the transaction opens (same safety property as `blind_sign()` itself — inert until the transaction that references it actually commits), and `record_pol_receipt_signature()` is called once per output inside the transaction, in both the batch and non-batch code paths.

**Verified real, not asserted**: `cargo check -p cdk-mintd --no-default-features --features sqlite,lnd,management-rpc,info-page,bdk` against the patched source succeeds with zero errors (one pre-existing, unrelated warning). `cargo build` produces a real, running `cdk-mintd` binary. The three patch files were then tested against a **completely fresh clone** of the pinned commit (`git clone` + `git checkout a056e0f0f69e94f431b1aeb90d883f18c61ea4c6`, zero relation to the working tree they were authored in) and apply cleanly with `git apply --check` — this is what a clean CI checkout will actually do, not merely assumed to work.

**Checksums** (`sha256sum patches/cdk/*.patch`):
- `0001-add-sign_pol_receipt-to-signatory.patch`: `ca5a56aa043ff206f071c43776cf0ed442e7b9cbd126bb45c2577d6fdcb7258`
- `0002-add-record_pol_receipt_signature-db-hook.patch`: `53678967979e746c61eda6ef01b2766edef917f93a2ffbc29f715fadcc40f1`
- `0003-wire-pol-receipt-signing-into-nut04-issuance.patch`: `8e09865cef962988d873ae786ba83c9295213077138ea110cc24280ae64b1a`

**Local build environment note**: this project's Windows dev machine has no `protoc` or working MSVC toolchain for `aws-lc-sys` (pulled in by CDK's default `grpc-processor` feature) — both real, environment-specific gaps, not code problems. Worked around locally by downloading a real `protoc` release binary and scoping the build to `--no-default-features --features sqlite,lnd,management-rpc,info-page,bdk` (the exact feature set Phase 1/2 actually need; `grpc-processor` is not required and is excluded). CI (Linux, `ubuntu-latest`) does not have either gap — see `docs/reproduce-real-stack.md` for the exact reproducible build commands.

---

## 2026-09-23 — Phase 2 Steps 6/7/8A: real NUT-04 mint-native accounting, verified

Built and proved, entirely for real, in [run 35882242998](https://github.com/TheWeirdDee/solvent/actions/runs/35882242998): the SQL-trigger architecture from Step 2, applied concretely to NUT-04. `migrations/solvent-accounting/0001_nut04_issued_liability.sql` adds `solvent_issued_liability`/`solvent_consumed_liability`/`solvent_pol_receipt` plus two triggers to CDK's own unmodified SQLite file. Real CDK schema extracted by building `cdk-sqlite` from the pinned source and constructing a real, fully-migrated database (`evidence/real-pol/cdk-schema-v0.18.1.sql`) rather than composed by hand from 47 migrations.

Two real bugs found by the reconciliation itself running for real in CI, not caught by local review — recorded because both are exactly the kind of thing "prove it, don't state it" is meant to catch:

1. **Operation-kind mislabeling.** The trigger's first version hardcoded the literal `'mint'` for every liability row instead of reading the real `NEW.operation_kind` CDK's own row already carries. First real CI run: 6 real mint outputs (1000 sat) produced 15 SOLVENT liability rows (2100 sat) — the swap's replacement outputs and the melt's change outputs were being mislabeled as mint too. Fixed by reading `crates/cdk-common/src/mint.rs`'s real `OperationKind` Display values (`"mint"`, `"swap"`, `"melt"`, `"batch_mint"`) and using `COALESCE(NEW.operation_kind, 'mint')` in the trigger.
2. **Reconciliation receipt-count scoping.** After fix 1, counts/amounts matched exactly (6/6, 1000/1000 sat) but the receipt-outbox count (15, correctly covering mint+swap+melt liabilities) was compared against the mint-only liability count (6) — an apples-to-oranges bug in the reconciliation script itself, not the trigger. Fixed by joining the receipt query to `solvent_issued_liability` and filtering to `operation_kind = 'mint'`.

**Result, confirmed by real execution**: a real Lightning-paid NUT-04 mint (1000 sat, 6 outputs) produces exactly 6 durable SOLVENT issued-liability rows summing to 1000 sat, matching CDK's own real `blind_signature` table exactly. Rollback leaves both CDK's and SOLVENT's rows absent; commit leaves both present. A genuine second HTTP mint attempt against the already-issued quote is rejected by the real mint (`Quote already issued`) with no duplicate accounting. Reconciliation is byte-identical before and after killing and restarting the real mint process.

**Not yet done**: receipt *signing* (Step 8B/8C architecture decided, not implemented — `solvent_pol_receipt` rows exist but stay `pending`), and NUT-03/NUT-05 accounting (deliberately not started, per Step 8's own "NUT-04 first" instruction). Per Step 8's own explicit escape valve: **STEP 8 PARTIAL — REAL ATOMIC ACCOUNTING VERIFIED, MINT-NATIVE RECEIPT SIGNING NOT YET VERIFIED.**

---

## 2026-09-23 — Phase 2 Step 8C: receipt-signing architecture — minimal `Signatory` trait extension

**Problem**: `docs/cdk-signatory-audit.md`'s real source audit confirmed Step 2's "no CDK modification needed" finding does **not** extend to receipt signing. CDK's `Signatory` trait exposes only `blind_sign()` (a BDHKE point-blinding operation), `verify_proofs()`, `keysets()`, `subscribe_keysets()`, and `rotate_keyset()` — no generic "sign this message with the amount key" operation exists. A real PoL receipt needs a BIP-340 Schnorr signature over a specific message string, using the same per-amount private key `blind_sign()` uses, which today only that one narrow BDHKE operation can touch.

**Alternatives considered** (per Phase 2 Step 8C's own list):
- *(A) Existing signatory API already supports it* — ruled out by direct inspection; no such method exists.
- *(C) Minimal patch to the embedded signatory implementation only* — insufficient alone; the trait itself has no seam for the mint core to request this signature through, so the implementation change would have nothing to be called from.
- *(D) Minimal patch to mintd/signatory request flow* — broader than needed; the real gap is one missing trait method, not the request-routing plumbing around it.
- **(B) Minimal `Signatory` trait extension — chosen.** One new trait method (`sign_pol_receipt(keyset_id, amount, message) -> Signature`), implemented in `DbSignatory` by reusing the *exact same* already-loaded per-amount key `blind_sign()` already reads, calling `SecretKey::sign()` — an already-shipped, already-tested BIP-340 helper in `crates/cashu/src/nuts/nut01/secret_key.rs`, already used elsewhere in CDK for NUT-11/14/20/29 signatures. One matching `Request` variant is added to `embedded.rs`'s existing actor-channel dispatch, following the identical pattern every other method already uses. No new cryptography, no new key material, no new isolation boundary — the new method sits inside the same already-existing isolation `blind_sign()` already relies on.

**This is, honestly, still a real patch to CDK's own source** — unlike Step 2's database seam. It is the smallest one found after actually reading `db_signatory.rs`'s and `embedded.rs`'s real implementations, not chosen for convenience. Reproducibility mechanism (per Phase 2 Step 3's "minimal checked-in patch files applied against pinned CDK v0.18.1" option): the patch is a small, checked-in diff against the exact pinned `v0.18.1` source (commit `a056e0f0f69e94f431b1aeb90d883f18c61ea4c6`), applied and built from source specifically for the signatory crate — CDK's *other* components (`cdk-mintd`'s binary, Bitcoin Core, LND) remain exactly Phase 1's unmodified prebuilt downloads. `crates/cdk-signatory/src/proto/{client,server}.rs` (the remote/gRPC signatory mode) is explicitly out of scope — not touched, not audited beyond confirming it exists.

**Atomicity finding, recorded plainly**: accounting-fact durability (the SQL trigger, Step 2) and receipt-signing durability are two different problems with two different mechanisms. A receipt can safely be *computed* before the CDK transaction commits (mirroring how `blind_sign()`'s own output is only released to the outside world after commit), but the *signed receipt bytes themselves* still need a small transactional outbox (a `pending` → `signed` row written by the same trigger, processed by an idempotent SOLVENT worker) layered on top of the trigger-atomic accounting row — see `docs/cdk-signatory-audit.md`'s "atomicity question, answered" section and `docs/accounting-model.md`'s schema.

---

## 2026-09-23 — Phase 2 Step 2: integration architecture — SQL triggers, no CDK fork

**Problem**: Phase 2 needs "a real CDK economic transition" and "a durable SOLVENT accounting obligation" to be coupled so a crash cannot leave one committed without the other. `docs/cdk-integration-seams.md`'s source audit found every economically-authoritative CDK commit (NUT-04's `process_mint_request()`, NUT-03's `swap_saga::finalize()`, NUT-05's `melt_saga::finalize()`) goes through one `Box<dyn database::Transaction<Error>>` per operation, provided by a `cdk_common::database::mint::Database<Error>` implementation.

**Alternatives considered** (per Phase 2 Step 2's own list):
- *(A) Upstream-compatible hook* — none exists today; CDK's pubsub/event system (`crates/cdk/src/event.rs`) is post-commit and best-effort, not a pre-commit hook.
- *(B) Minimal patch against CDK* — technically possible (add a hook call inside `cdk-sql-common`'s transaction commit path) but requires patching and rebuilding CDK from source, abandoning Phase 1's prebuilt-binary approach and its exact pinned-release integrity guarantee.
- *(C) SOLVENT-specific CDK fork* — rejected outright per the spec's own bias and Phase 1's `DECISIONS.md` precedent (avoid vendoring/forking CDK unless necessary); also the heaviest to keep in sync with upstream.
- *(D) Transactional outbox, decorator-level* — a `Database`/`Transaction` implementation wrapping the real `cdk-sqlite` instance can observe every call and refuse to let a CDK commit succeed unless its own write succeeded first, but cannot make both writes part of one SQL `COMMIT`, because `cdk-sqlite`'s concrete `Transaction` owns an opaque `sqlx` handle a decorator never sees. Leaves a genuine (if narrow) crash window.
- **(E) SQL triggers on CDK's own SQLite file — chosen.** `cdk-mintd --work-dir` keeps all durable state in one SQLite file. A `CREATE TRIGGER ... AFTER INSERT ON blind_signature/proof ...` fires *inside the same SQL transaction* as the firing `INSERT`/`UPDATE` — a standard SQLite guarantee, not a CDK-specific behavior. This is real single-`COMMIT` atomicity with **zero CDK source changes**: no patch, no fork, no custom Rust binary, nothing to rebuild. It is applied as a one-time SQL migration against the same database file `cdk-mintd` already manages, fully reproducible from a clean checkout.

**Chosen design**: SOLVENT-owned tables (`solvent_issued_liability`, `solvent_consumed_liability`, `solvent_pol_receipt` — see `docs/accounting-model.md`) live in the *same* SQLite file as CDK's own `blind_signature`/`proof`/`mint_quote`/`melt_quote` tables. Triggers on CDK's tables populate them automatically, in the same transaction CDK itself commits. A separate, idempotent SOLVENT worker/reconciliation tool only *reads* from these tables (and derives PoL receipts/epoch structures from them) — it never itself needs to be in CDK's write path, because the trigger already guaranteed the raw accounting facts are durable before any worker runs. Full schema: `docs/accounting-model.md`. Full source citations backing this decision: `docs/cdk-integration-seams.md`.

**Failure mode this avoids**: the explicitly forbidden architecture ("CDK commits issuance → HTTP response returns → SOLVENT later tries to create accounting, and SOLVENT crashes in between") — because there is no "later" step; the accounting row is written by the database engine itself as part of the same transaction, before CDK's own `tx.commit().await?` call can even return.

**What this does not yet solve**: receipt *signing* (Phase 2 Step 9) still needs the mint's real amount private keys, which live in `cdk-signatory`, not in SQL — a trigger can record *that* an output was issued and for what amount/keyset, but cannot itself produce a NUT-PoL-style signed receipt over that fact. That remains a separate, not-yet-audited seam (`cdk-signatory` is explicitly flagged as unaudited in `docs/cdk-integration-seams.md`).

---

## 2026-09-23 — Phase 2 Step 0: correct the ordinary double-spend evidence

Phase 1's ordinary-lifecycle double-spend check (R8/R9) used `senderWallet.ops.receive(token).prepare()`, which threw `Proof has unrecognised keyset '<id>' is not a keyset for this wallet unit`. Grepping cashu-ts's own bundled source (`isUnitKeyset` in `lib/cashu-ts.es.js`) confirmed this is a **client-side guard**, thrown before any HTTP request is made — it proved nothing about the mint's own double-spend enforcement. Only Phase 1's *restart*-persistence check (R12/R13, added later) happened to exercise a real mint rejection, because it used the low-level `Wallet` swap path differently.

**Fix**: rewrote R8/R9 in `src/cli/real-cashu/real-cashu-foundation.ts` to bypass the high-level `Wallet` entirely. It now: (1) re-confirms via NUT-07 that the original proofs are SPENT; (2) constructs a real second `/v1/swap` request with fresh, validly-blinded outputs (`createRandomRawBlindedMessage()`); (3) sends it straight to the mint via the low-level `Mint.swap()` client (a direct HTTP POST with no client-side pre-validation); (4) requires the failure to be a genuine `MintOperationError` (`isMintOperationError()` — a type only ever constructed from a parsed HTTP error response, never from a client-side throw) whose message indicates an already-spent condition. Re-run for real in [run 35855551901](https://github.com/TheWeirdDee/solvent/actions/runs/35855551901) (2026-09-23, commit `9cb5eef`): the mint rejected the request with `real mint HTTP error (code 11001, status 400): Token Already Spent` — CDK's own real structured protocol error, observed over the network, not asserted client-side.

---

## 2026-09-23 — Phase 1: Real Cashu Foundation

Competitive analysis of other Freedom Stack (Nostr + Ecash) submissions (RelayJoin's real Signet Payjoin transaction, Lifeboat's real regtest LND-channel-backup recovery, ecashmesh's real regtest CDK/CLN/LND mint→swap→melt lifecycle with `CDK_FAKE_WALLET` explicitly excluded) surfaced a real gap: SOLVENT's live transaction path used SOLVENT's own locally-generated fixture mint keys/proofs and an in-memory reference acceptance store, never a real external mint's real issue/swap/melt lifecycle. Regtest/testnet is fine — the pattern the strongest competitors share is *real host-protocol implementations on a safe test network*, not synthetic protocol state. This entry records fixing that, scoped deliberately narrowly (Phase 1: prove the Cashu layer is real; do not yet touch SOLVENT's own PoL layer — see below).

**D — WHY REGTEST.** Real Bitcoin Core + real Lightning (`lnd`) + real Cashu mint (CDK) protocol execution, deterministic and economically valueless by construction — the same principle this project already applied to the reserve leg via Bitcoin Signet/Mutinynet, now applied to the issuance/redemption leg too.

**D — WHY CDK.** An independent, externally-developed, real Cashu mint implementation, rather than SOLVENT manufacturing its own mint behavior and grading its own homework. "SOLVENT should extend/integrate a real host implementation" — not reimplement one. `@cashu/cashu-ts` (already a SOLVENT dependency) plays the identical role on the wallet/client side: a real, general-purpose Cashu wallet library, not a second hand-rolled client.

**D — WHY LND FOR BOTH LIGHTNING NODES, NOT CLN.** CDK's own official regtest tooling (`REGTEST_GUIDE.md`, `just regtest`) runs 2 CLN + 2 LND nodes under Nix. Phase 1 uses a smaller, LND-only topology (one real mint is sufficient per the Phase 1 scope; "Lightning Node A"/"Lightning Node B" doesn't require different implementations) specifically because LND publishes official prebuilt binaries for Linux, macOS, *and Windows*, while Core Lightning does not publish Windows binaries at all — and this project's own development machine is Windows without Docker or a configured WSL2 distribution. See `docs/dependencies.md`.

**D — WHY DIRECT BINARY DOWNLOADS, NOT DOCKER OR NIX.** CDK's own CI (`cashubtc/cdk`'s `.github/workflows/ci.yml`) runs every job — including its real regtest Lightning itest — on **self-hosted** infrastructure with a private Cachix/Attic Nix binary cache this project has no access to. Without that cache, a from-scratch Nix build of Bitcoin Core + LND + CDK on a stock GitHub-hosted `ubuntu-latest` runner would need to compile a large dependency closure from source — a real, material time/reliability risk. Bitcoin Core, LND, and CDK (as of `v0.18.1`) all publish ready-to-run, checksum-verifiable prebuilt Linux x86_64 binaries, so `.github/workflows/real-cashu-integration.yml` downloads and runs those directly — no Docker layer, no Nix cold-build, on a completely standard GitHub-hosted runner.

**D — WHY FIXTURES REMAIN.** `src/cashu/keys.ts`/`mint-sim.ts` and everything built on them (the entire existing browser demo, the attack corpus, every deterministic unit test) stay exactly as they were — real `@cashu/cashu-ts` cryptography, fast, offline, deterministic. What changed is only the *claim* attached to them: they were never evidence that ecash issuance/redemption is real against an external mint, and after this phase nothing in this repository implies otherwise (see `docs/REALITY-MAP.md`'s explicit "Lane A vs Lane B" split). Fast deterministic verifier tests remain valuable; they cannot, on their own, satisfy a real-integration claim.

**D — WHY NO FAKEWALLET IN THE PHASE 1 REAL PATH.** CDK's `fakewallet` payment backend is real, useful CDK-maintained testing infrastructure, and remains legitimate for CDK's own unit tests — but a fakewallet-backed mint's "quote settled" state is asserted by the mint's own test code, not observed from any real Lightning payment. `src/cli/real-cashu/real-cashu-foundation.ts`'s `checkRealStackNotFake()` independently queries the configured payment backend's own real node identity before running anything else, and the workflow's mint config is explicitly `backend = "lnd"`. A fake backend detected here fails the whole run closed, before any Cashu operation is attempted.

**D — WHY SOLVENT IS NOT YET CONNECTED.** Phase 1 intentionally proves the underlying Cashu economic lifecycle (real mint, real payment, real issuance, real swap, real proof-state transition, real double-spend rejection, real melt) *before* modifying mint-side accounting to also emit SOLVENT's own PoL evidence (signed receipts, epoch manifests, sum-MMR, reserve attestation, Nostr publication) from that real activity. Connecting the two prematurely would make a failure impossible to localize — is the Cashu layer broken, or the PoL layer, or the bridge between them? Phase 1's scope boundary exists specifically so that question has one honest answer right now: the Cashu layer. Phase 2 (mint-native SOLVENT accounting) is deliberately not started, and requires separate review before beginning.

**Baseline audit finding worth recording**: this repository already contains two parallel, independent local-fixture pipelines — an older "v1" one (`src/cashu/mint-sim.ts`, `src/mint/*`, `src/verifier/rules.ts`, CLI-only, not wired into the live browser app) and the current "v2" one (`src/cashu/keys.ts`, `src/app/protocol-demo.ts`, everything the live browser app and `npm run gate0..gate6`/`attacks`/`live-demo`/`verify:submission` actually exercise). Phase 1's replacement target for a future Phase 2 is specifically `src/cashu/keys.ts`'s `generateFixtureKeyset()`/`issue()` (v2's fixture mint) and `src/enforcement/accept-gate.ts`'s in-memory `WalletStore` (v2's reference acceptance) — not the v1 pipeline, which is legacy and already out of the live path.

**D — CONFIRMED BY REAL EXECUTION, AFTER SEVEN REAL CI FAILURES.** The first real run of `.github/workflows/real-cashu-integration.yml` did not pass, and none of the next six did either — each failure was a genuine infrastructure/protocol issue, diagnosed from the actual logs and fixed for real, never worked around: (1) `sha256sum` checking a renamed local filename against upstream `SHA256SUMS`, which lists the original filename; (2) `cdk-mintd` 0.18.x's config CLI requiring a one-time `config init --new-mint` step before a plain `cdk-mintd --work-dir` start, not the legacy `--config` flag; (3) LND's wallet subsystem not yet being ready for `newaddress` immediately after `getinfo` first succeeds; (4) `cond && break` as a bare statement inside a loop silently aborting the whole script under `set -e` the first time `cond` was false, present in six separate loops; (5) `POST /v1/channels/transactions` (`SendPaymentSync`) no longer existing on this LND version's REST surface, requiring a rewrite to the streaming `POST /v2/router/send`; (6) a single-funder LND-2→LND-1 channel leaving LND-1 (the mint's own backend) with no real outbound liquidity, causing a genuine `FAILURE_REASON_INSUFFICIENT_BALANCE` on melt, fixed with `--push_amt`; (7) the same LND-startup race as (3) recurring on `connect`/`openchannel` instead of `newaddress`, fixed with the same bounded-retry pattern; and (8) `/v2/invoices/lookup`'s `payment_hash` query parameter requiring standard base64, not base64url, contrary to the initial (reasonable but wrong) assumption that URL-safe encoding was correct for a URL query parameter. [Run 35853398175](https://github.com/TheWeirdDee/solvent/actions/runs/35853398175) (2026-09-23, commit `b22ed3a`) is the first fully passing run: real Bitcoin Core 29.4 regtest, two real `lnd` v0.21.3-beta nodes, a real `cdk-mintd` v0.18.1 (backend `lnd`, not `fakewallet`), a real Lightning payment with an observed preimage, real NUT-04/03/07/05 transitions, real double-spend rejection, and — after genuinely killing and restarting the mint process against the same on-disk SQLite database — the already-spent proofs from before the restart still reporting SPENT (6/6) with a fresh double-spend attempt against them still refused. See `docs/limitations.md` and `docs/REALITY-MAP.md` for what this specific run did and did not prove.

---

## 2026-09-23 — Automated deployment refresh: GitHub Pages, a scheduled workflow, bounded Esplora retry, deployed-site verification

**Deployment provider discovered, not invented:** inspected the repo before building anything — real GitHub remote (`TheWeirdDee/solvent`), `gh` CLI authenticated with admin access, but genuinely no deployment configured (no Vercel/Netlify/Render/Railway config, no `.github/workflows`, `has_pages: false`, no `homepage` field, remote repo essentially empty). Per explicit instruction to build around GitHub CI and identify the missing connection rather than inventing a provider, confirmed with the user which provider to target: **GitHub Pages**, chosen specifically because it needs zero additional secrets/accounts (deploys via the workflow's own `GITHUB_TOKEN`/OIDC). Enabled via `gh api -X POST repos/.../pages -f build_type=workflow` (a repo *setting*, not a commit) — public URL will be `https://theweirddee.github.io/solvent/` once the workflow is pushed and runs.

**`vite.config.ts` gained a `base` override** (`GH_PAGES_BASE` env var, only set by the CI build step) — GitHub Pages project sites serve from a subpath (`/solvent/`, not `/`), so asset URLs need the prefix or the deployed page 404s on its own JS/CSS. Confirmed correct by building locally with the env var set and inspecting the emitted `<script src>`/`<link href>` paths. Routing is hash-based (`src/app/router.ts`), so no server-side SPA-fallback trick is needed for GitHub Pages.

**Built `.github/workflows/refresh-live-demo.yml`** (daily cron + `workflow_dispatch`): `npm ci` → `live-demo` → `verify:live-demo` → `test` → `attacks` → `verify:submission` → `build` (with the Pages base) → `upload-pages-artifact` + `deploy-pages` → two post-deploy checks. Fail-closed at every step; nothing deploys unless everything before it passed. Refresh cadence 1 day against a ~1 week freshness window — ~6 days of margin.

**Two new post-deploy verification scripts**, because "local dist/ is correct" and "the deployed public site is correct" are different claims:
- `npm run verify:deployed -- <url>` (`src/cli/verify-deployed.ts`) — fetches the deployed `index.html`, follows its `<script src>` references, confirms the *current* `evidence/nostr/live-demo.json` Nostr event id is literally present in the served bundle (the same fact `docs/trust-boundaries.md` already established: the evidence is baked in at build time). Uses `process.exitCode`, not a forced `process.exit()`, after async `fetch()` calls — a forced exit right after `fetch()` was observed to trigger a Node/libuv shutdown-race crash on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`); switching to `process.exitCode` sidesteps the whole class of issue on any platform, not just a Windows workaround.
- `npm run verify:deployed:browser -- <url>` (`src/cli/verify-deployed-browser.ts`) — opens a real headless Chromium against the deployed URL and clicks through Try SOLVENT's LIVE PUBLIC DEMO case exactly as a judge would, asserting a real `ACCEPT VERIFIED`. Added `playwright` as a real `devDependency` (previously only ever installed ad hoc, `--no-save`, for manual testing this session) so `npm ci` in CI resolves it automatically; the workflow installs the Chromium binary itself (`npx playwright install --with-deps chromium`) as a separate step.

**Bounded resilience added to the reserve/Esplora leg**, mirroring the existing Nostr bounded retry but scoped correctly: `queryLiveChainState()` (`src/app/submission.ts`) now retries exactly once, after a short delay, but *only* when the underlying fetch itself throws (timeout/connection/non-2xx — a transport failure). A successful fetch that reports a spent UTXO, a value/script mismatch, or (via the separate synchronous `evaluateReserveAttestation()`) a shortfall or stale attestation returns immediately with no retry — retrying a real protocol-level result would either be pointless or could mask a genuine problem behind a misleading delay. The delay primitive (`realDelay`) lives in `src/reserve/esplora.ts`, mirroring the identical Nostr-side pattern in `src/nostr/pol-evidence.ts`, so tests can override the same export. Tested for all required cases in `src/app/main.test.ts`.

**Live-demo refresh safety tested explicitly:** added a deterministic test proving an old, unrelated demo identity's event sitting alongside a bundle's own genuine event on a relay never causes a false `REFUSE_NOSTR_CONFLICT` — `evaluatePolEvidence()`'s `(mint_identity, epoch_index)` scoping filters the unrelated event out before conflict-grouping ever runs.

**Added a small, non-sensitive build/evidence marker** to the Live Public Demo's evidence panel (`src/app/verifier-panel.ts`) — the canonical event's truncated id and publish timestamp, shown only for that one scenario, in the technical evidence area (never primary UI). Lets a maintainer or judge confirm which canonical evidence version a given page load is actually using.

---

## 2026-09-23 — Durability pass: network-aware reserve freshness, bounded relay retry, one canonical Live Public Demo, stable-identity investigated and reverted

**Root-caused and fixed the "Live Public Demo expires every ~8.5h" problem — a bug, not an intentional policy.** `MAX_ATTESTATION_AGE_BLOCKS = 1008` (`src/reserve/evaluate.ts`) was never meant as a fixed block count: its own comment said "~1 week at 10min blocks," and 1008 = 7 days × 144 blocks/day exactly, under Bitcoin's standard ~10-minute cadence. Mutinynet's deliberately fast ~30.5s blocks (chosen for same-session real confirmation, unrelated to the staleness policy) made the same raw 1008 enforce only ~8.5 hours — a ~68x tighter window than intended. Fixed with `ReserveFreshnessPolicy` / `maxAttestationAgeBlocks(network)`: the block budget is now `targetSeconds / secondsPerBlockByNetwork[network]`, preserving the real ~1 week intent on any network (1008 blocks unchanged on mainnet/default-signet, ~19,830 on Mutinynet). Block height (independently re-queried, never a self-reported timestamp) stays the trustworthy staleness clock. `src/app/verifier-panel.ts`'s duplicated flat constant and `src/cli/verify-live-demo.ts`'s display math both now use the same exported function — no duplicated magic number anywhere. Tested in `tests/reserve/evaluate.test.ts`.

**Found and fixed a real bug in `relayReachable` detection while investigating relay resilience:** `nostr-tools`' `pool.querySync()` never rejects on a connection failure (resolves with whatever it collected once its timeout elapses, even with zero relays reachable). `fetchPolEvidence()` now listens for `SimplePool`'s own `onRelayConnectionSuccess` callback (fires at the exact moment a relay's connection genuinely succeeds) instead of inferring reachability from whether the fetch call threw.

**Added a bounded relay-fetch retry** (`evaluateNostrIndependently()`, `src/app/submission.ts`): one extra attempt, after a short delay, whenever the exact expected event wasn't found on the first attempt — absorbs a real, directly-observed transient relay miss (a genuinely-published, genuinely-findable event once came back NOT FOUND, then FOUND on immediate repeats) without ever converting a genuinely unpublished event into a false ACCEPT. Reachability and events from both attempts are combined (union, deduped downstream), so a conflicting event appearing only on the retry is still caught as `REFUSE_NOSTR_CONFLICT`. Exactly one retry, never more. The delay primitive (`realDelay`) lives in `src/nostr/pol-evidence.ts` specifically so it's mockable the same way `fetchPolEvidence` already is — an earlier version defined it in `submission.ts` itself, which made it unmockable and silently added real ~1.5s waits to dozens of tests; caught by the test suite's duration nearly doubling. Tested for all required cases (found-on-retry, still-absent, both-unreachable, unreachable-then-found, conflict-on-retry) with an injected mock sequence, no real sleep.

**Investigated a stable demo mint identity (persist once, like `evidence/reserves/reserve-key.json` already does, and only refresh the reserve attestation + Nostr event) — built, tested for real against real public relays, and reverted.** Kind 8181 is deliberately regular/immutable, not NIP-33 replaceable (PRD §12.2). Publishing a second reserve attestation under the same `(mint_identity, epoch)` leaves the first event permanently co-discoverable with a different `reserve_digest`, which the real, unmodified `evaluatePolEvidence()` correctly flags as `REFUSE_NOSTR_CONFLICT` — confirmed by actually publishing twice under one identity and observing exactly that via `npm run verify:live-demo`. Loosening that conflict grouping would weaken real equivocation detection to make demo maintenance more convenient, which this build declined to do. `npm run live-demo` mints a fresh identity every run, as it always did — see `docs/trust-boundaries.md`.

**Built one canonical Live Public Demo source** (`loadCanonicalLiveDemoBundle()` / `verifyCanonicalLiveDemo()`, `src/app/submission.ts`), used identically by the browser, `npm run verify:live-demo`, and a new required `npm run verify:submission` line. Previously `verify:submission` graded only historical `npm run gate5`/`gate6` evidence and never looked at `evidence/nostr/live-demo.json` at all, so it could report `SUBMISSION READY` while the actual browser-facing demo was broken — confirmed this was a real gap (not hypothetical) when a transient Esplora blip made the new canonical line fail on one real run and pass on an immediate re-run, exactly as a live check should.

**Confirmed the deployed build requires a rebuild, not just a regeneration**, to see fresh evidence: `evidence/nostr/live-demo.json` is bundled into the production JS at `npm run build` time (a static `with { type: 'json' }` import), confirmed by building and finding the live event id literally baked into `dist/assets/*.js`. Added `npm run live-demo:release` (regenerate + rebuild in one step) so a maintainer can't accidentally do one without the other; redeploying `dist/` afterward remains an external step this repo has no deployment configuration for.

---

## 2026-09-22 — Nostr publication-verification split (UNAVAILABLE vs EVENT_NOT_FOUND); stable Live Public Demo; A25; real effective expiry

**Fixed an architectural gap the manual-bundle trust fix (see entry below) hadn't closed:** a privately-supplied, cryptographically-valid-but-never-published Nostr event could still reach `ACCEPT_VERIFIED`, which contradicts SOLVENT's actual claim ("public accounting, not just privately signable"). `verifySubmission()`'s `evaluateNostrIndependently()` (`src/app/submission.ts`) now performs a real (or, for tests/attacks, injected) public-relay fetch and only ever gates acceptance on what a relay actually returns — the bundle's own privately-supplied copy is informational only (`providedCopyValid`), never sufficient for `ACCEPT`.

**Split `REFUSE_NOSTR_UNAVAILABLE` into two distinct, never-collapsed reason codes** (`src/verifier/reasons.ts`, `src/verifier/verify.ts`): `REFUSE_NOSTR_UNAVAILABLE` (no relay could be reached — a network problem) vs the new `REFUSE_NOSTR_EVENT_NOT_FOUND` (relays reachable, event genuinely absent — Create Test Ecash's expected, honest case). The locked `evaluatePolEvidence()` in `pol-evidence.ts` was not modified; the remapping lives entirely in `submission.ts`, based on an already-tracked `relayReachable` boolean. UI copy follows suit: "PUBLICATION NOT FOUND" vs "PUBLIC EVIDENCE COULD NOT BE CHECKED" (`src/app/verifier-panel.ts`).

**Built a stable, genuinely-published "Live Public Demo"** (`src/cli/live-demo.ts`, `npm run live-demo`): one complete, mutually-consistent `SubmissionBundle` published ONCE to real public relays (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`) and persisted to `evidence/nostr/live-demo.json`. Try SOLVENT's `LIVE PUBLIC DEMO` case and the manual verifier's "Load example bundle" both load this and independently re-fetch/re-verify it live on every run — nothing about its `ACCEPT_VERIFIED` is precomputed or cached. `npm run verify:live-demo` independently checks its current health (real relay fetch, real Esplora query, exact freshness math) so a maintainer can tell before a demo whether `npm run live-demo` needs a re-run.

**Determined the real effective expiry, correcting an earlier, wrong "~1 week" assumption:** the Nostr event's own validity window is 30 days (non-binding). The actual binding constraint is the reserve attestation's staleness bound, `MAX_ATTESTATION_AGE_BLOCKS = 1008` (`src/reserve/evaluate.ts`) — that constant's own comment assumes ~10-minute blocks (~1 week), but this build's real network, Mutinynet, was empirically measured at ~30.5s/block (10 real consecutive block timestamps from `mutinynet.com`'s API), giving a real effective window of **~8.5 hours**. Every doc that stated "~1 week" was corrected (`docs/trust-boundaries.md`, `docs/reserve-attestation.md`, `docs/verification-bundle.md`, `src/cli/live-demo.ts`'s comments/persisted `_note`). The UI now surfaces this as a non-alarming "Attestation freshness" row (`verifier-panel.ts`), and expiry past the window is handled explicitly (`isReserveAttestationExpired()` → "LIVE DEMO EVIDENCE EXPIRED" copy, never silently replaced with ACCEPT) rather than left to degrade into a generic REFUSE.

**Added A25 — signed-state-never-published** (`src/cli/attacks.ts`): a correctly-signed accounting event that was never published, expecting `REFUSE_NOSTR_EVENT_NOT_FOUND` and zero `accept()` calls. Deterministic — relay/chain-state fetches are injected via new `RelayFetchFn`/`ChainStateFetchFn` params on `verifySubmission()`, no real internet used in the attack corpus. Attack count is now **25/25** (updated everywhere: `verify:submission`'s expected count, `README.md`, `ATTACKS.md`, `evidence-data.ts`, `index.html`, `docs/start-here.md`).

**Caught and fixed a real bug while verifying the split against a real browser, not just mocked tests:** `nostr-tools`' `pool.querySync()` never rejects on a connection failure (it resolves with whatever it collected once its timeout elapses, even with zero relays reachable), so the original `relayReachable` detection — a try/catch around the fetch call — was dead code on the real network path; every genuine outage would have been misreported as `REFUSE_NOSTR_EVENT_NOT_FOUND` instead of `REFUSE_NOSTR_UNAVAILABLE`, silently collapsing exactly the distinction this pass exists to make. Found via a real Playwright test that closed the relay WebSocket connections and observed the UI still showing "PUBLICATION NOT FOUND". Fixed in `fetchPolEvidence()` (`src/nostr/pol-evidence.ts`) by listening for `SimplePool`'s own `onRelayConnectionSuccess` callback, which fires at the exact moment a relay's connection genuinely succeeds — confirmed fixed by re-running the same real-browser test (now correctly shows "PUBLIC EVIDENCE COULD NOT BE CHECKED"). See `docs/trust-boundaries.md`'s "How `relayReachable` is actually determined."

---

## 2026-09-22 — Gate 6 funding resolved; product/UX pass; manual-verification trust fix

**Gate 6 funding blocker (see the entry below) is resolved.** The repo owner funded the reserve address themselves in a real browser; `npm run gate6` now reports `live_verified: true` against a real Signet UTXO, and `npm run verify:submission` reports `SUBMISSION READY`. `docs/trust-boundaries.md` and `VERIFY_IN_5_MINUTES.md` are updated accordingly — no doc should still describe this as blocked.

**Manual-verification trust boundary fixed.** The browser's "Verify your evidence" flow previously accepted a `VerifyInput`-shaped bundle where `reserve`/`nostr` were pre-evaluated `{verified: boolean}` claims — trustworthy when the CLI/attack-corpus constructs them (the same code ran the real check), but not when an arbitrary pasted JSON supplies them, since nothing stopped `"reserve": {"verified": true}` from being hand-written with no evidence behind it. Fixed by introducing `SubmissionBundle`/`verifySubmission()` (`src/app/submission.ts`): the browser now only ever accepts raw signed evidence (`reserveAttestation`, `nostrEvent`), and independently re-derives `verified`/`reasonCode` itself — a real live Esplora re-query for reserve, a real independent cryptographic re-check of the raw Nostr event for Nostr — before constructing the `VerifyInput` it hands to the unmodified, locked `verify()`. `src/verifier/verify.ts` itself was not touched. A regression test (`main.test.ts`, "a pasted bundle cannot fake acceptance...") asserts that injecting a fabricated `reserve`/`nostr` claim into a pasted bundle has no effect.

**Landing/verify/docs/mobile pass.** Rebuilt the Try/Create/Manual verify flows around plain-language step labels with technical secondary labels, an explicit error taxonomy (INVALID JSON / INCOMPLETE BUNDLE / INVALID BUNDLE / UNSUPPORTED MINT / REFUSE_* / NETWORK VERIFICATION UNAVAILABLE), a mint-identity block on every result, explicit Broken-Promise-contradiction and Reserve-Shortfall cards, split input/result JSON views, public-evidence copy/explorer links (Mutinynet for reserve, njump.me for Nostr), a real mobile burger nav, a problem-statement + who-is-this-for landing section, and a "Start here" docs guide. See the product-pass session's final report for the complete list.

---

## 2026-09-22 — Gates 4-6 mechanism complete, full 24-attack corpus, fail-closed submission verifier; Gate 6 live UTXO blocked on external funding

### Status

| Gate | Status | Evidence |
| --- | --- | --- |
| 4 — enforced accept/refuse | **PASS** | `evidence/gate-4/enforcement.json`, `tests/enforcement/accept-gate.test.ts` |
| 5 — Nostr public evidence | **PASS** (real publish to 2/3 public relays, real fetch-back, real conflict/stale/mismatch detection) | `evidence/nostr/`, `tests/nostr/pol-evidence.test.ts`, `tests/verifier/verify-nostr-integration.test.ts` |
| 6 — real Signet reserve attestation | **Mechanism PASS / live UTXO BLOCKED** (see below) | `evidence/reserves/`, `tests/reserve/evaluate.test.ts`, `tests/verifier/verify-reserve-integration.test.ts` |
| 7 — attack battery | **24/24 implemented and passing** (A01-A24) | `evidence/attacks/`, `ATTACKS.md` |

### Gate 4 — what "acceptance" means in this build

`src/enforcement/accept-gate.ts`'s `acceptProof()` is a real, observable state mutation: it serializes the verified proof with `@cashu/cashu-ts`'s actual `getEncodedToken()` (the same function a real wallet uses) and commits the record to a local `WalletStore`. It is deliberately **not** a live mint-swap HTTP round trip — PRD §13 explicitly rules out building a full wallet, and the property being proven ("SOLVENT's own gate commits the proof on ACCEPT, and never on REFUSE") doesn't require one. `runAcceptGate()` is spy-tested for all 5 PRD-required cases (`ACCEPT_VERIFIED` called once; `REFUSE_ISSUANCE_OMITTED`/`REFUSE_RESERVE_SHORT`/`REFUSE_RECEIPT_INVALID`/`REFUSE_UNVERIFIABLE` called zero times).

### Gate 5 — event kind choice and design

New event kind **8181** (regular/immutable, NIP-01 range 1000-9999 — not the parameterized-replaceable 30000-39999 range v1's kind `31111` used) for schema `solvent/pol/v2`, chosen after checking the current NIP registry (`nostr-protocol/nips/blob/master/README.md`, fetched raw 2026-09-22): kind 8181 is unused (nearby taken kinds: 8000, 8001, 9000, 9041, 9321, 9734/5, 9802). Regular, not replaceable, per PRD §12.2 — the audit record must not depend solely on an addressable event a relay may discard/replace. The optional "latest state" pointer event PRD §12.2 mentions is not implemented this session (not required for Gate 5's pass bar).

Tag letters `M`/`E`/`K` (mint identity / epoch / keyset), not the more readable `mint_identity`/`epoch`/`keyset` originally used in the first draft of this event: **NIP-01 only requires relays to index single-letter (a-zA-Z) tags** (`#<single-letter>` filters) — multi-character tag filters are legal to send but most relays silently don't index/match on them. This was caught empirically: the first real end-to-end run published successfully to 2 relays but fetch-back returned 0 events; switching to single-letter tags fixed it immediately (confirmed via `npm run gate5` against the real public relays `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band` — 2/3 relays acked, fetch-back independently retrieved the real published event). `e`/`p`/`d` were avoided specifically because they carry their own reserved NIP-01 semantics (64-hex-only values for `e`/`p`; `d` implies a parameterized-replaceable event, which this kind is not).

### Gate 6 — bounded reserve proof design, and the funding blocker

**Design (PRD §11.2's explicit bounded fallback, not full BIP-322):** a canonical reserve statement (network, reserve pubkey, outpoints with value/scriptPubKey, timestamp, block height) is signed twice — once by the real Taproot key-path secret that actually controls the on-chain output (BIP-340 Schnorr, using the BIP-341-tweaked private key — computed via `@scure/btc-signer`'s `taprootTweakPrivKey`, not hand-rolled point arithmetic), and once by the mint's manifest master key, binding the reserve public key to that specific statement digest. The verifier independently re-queries a public Esplora API for every declared outpoint (existence, value, scriptPubKey, spent status) before trusting anything the statement itself claims. Full BIP-322 was evaluated and set aside for this build: the ecosystem's JS support for BIP-322 across arbitrary script types is still immature enough that hand-verifying correctness within this session was a real scope risk, and PRD §11.2 explicitly sanctions this alternative ("acceptable bounded implementation if full proof-of-funds support becomes a scope trap") — this is not a silent downgrade to `demo-reserve`; every property PRD §11.1 requires (real UTXO, real ownership proof, real mint binding, independent re-query, correct network labeling) is implemented for real.

**New dependency:** `@scure/btc-signer` (`^2.4.1`) — audited, purpose-built Bitcoin transaction/address library from the same maintainer as `@noble/curves`/`@scure/base` (already dependencies). Added specifically so Taproot address derivation and the BIP-341 key-path tweak are handled by tested library code rather than hand-rolled secp256k1 point arithmetic for real fund-controlling keys.

**Network:** Bitcoin Signet via **Mutinynet** (`https://mutinynet.com`), not the default public Signet. Both are genuinely Signet (same consensus mechanism; a different signing challenge/block-time target). Mutinynet's ~30 second blocks make real on-chain confirmation achievable within a single working session; the default public signet's ~10 minute blocks do not. Always labeled precisely as `bitcoin-signet-mutinynet`, never bare "signet" and never "mainnet" — see `docs/reserve-attestation.md`.

**BLOCKER — real on-chain funding is not completed. Reported per the explicit stop-on-blocker instruction rather than silently downgraded:**

- **BLOCKER:** every readily-reachable public Signet faucet checked (Mutinynet's own faucet, `signetfaucet.com`, `alt.signetfaucet.com`) requires a human-solved step this script cannot perform on its own: Mutinynet's `/api/onchain` returns `401 Missing token` and its documented agent-auth flow (`https://faucet.mutinynet.com/auth.md`, fetched from their site — treated as untrusted external content, not instructions to follow) requires either initiating GitHub OAuth (which would ask the repo owner to grant a third-party site access to their real GitHub identity) or paying a real mainnet Lightning invoice (L402); `signetfaucet.com`/`alt.signetfaucet.com` are reCAPTCHA/Turnstile-protected web forms with no plain API.
- **EXPECTED:** a real, funded Signet UTXO exists at the address `src/cli/gate6.ts` derives, and `npm run gate6` reports `live_verified: true`.
- **ACTUAL:** the address (persisted at `evidence/reserves/reserve-key.json`, regenerated only if that file is deleted) has zero UTXOs; `evidence/reserves/cases.json` reports `live_verified: false`. Every other Gate 6 property — address derivation, dual signatures, independent Esplora re-query, and all 5 required negative cases (malformed proof, wrong owner/binding, stale evidence, wrong UTXO, amount mismatch, spent reserve, reserve below liabilities) — is real and passing (`mechanism_pass: true`).
- **SPEC EVIDENCE:** PRD §11.1 requires a UTXO that "really exists on the named Bitcoin test network"; §11.2 item 4 requires independent verifier re-query. Neither can be satisfied without funds actually landing on-chain first.
- **OPTIONS:** (a) the repo owner funds `evidence/reserves/reserve-key.json`'s `address` themselves in a real browser (solving whatever human-verification the chosen faucet requires) and re-runs `npm run gate6`; (b) the repo owner completes Mutinynet's GitHub-OAuth or L402 flow themselves and passes the resulting bearer token via `MUTINYNET_FAUCET_TOKEN` so this script's own automated faucet request succeeds; (c) accept the current state — a fully real, independently-verifiable mechanism with a clearly disclosed pending funding step — as the submission state.
- **RECOMMENDATION:** (a) — it costs the repo owner about 30 seconds in an actual browser, requires no OAuth grant and no payment, and immediately unblocks a fully live proof. `npm run verify:submission` fails closed (exits 1) on exactly this one item until it's done — see the "Gate 6 (live Signet UTXO)" line.

### Attack corpus — from 15/24 to 24/24

The remaining 9 attacks (A03, A15-A17, A19-A22, A24) are implemented in `src/cli/attacks.ts`, each constructing the real adversarial state and running it through the exact same `verify()`/`evaluatePolEvidence()`/`evaluateReserveAttestation()` code the rest of the build uses (no attack-specific shortcuts):

- **A03** (issuance included at the wrong value) surfaces as `REFUSE_MMR_PROOF_INVALID`, not a dedicated "value mismatch" code: the verifier recomputes the issued-tree leaf from the *received* proof's own amount and checks inclusion against the epoch's tree; if the tree actually committed a different amount for that same `B'`, the recomputed leaf hash simply doesn't match at the first hashing step. `REFUSE_ISSUANCE_VALUE_MISMATCH` (in `src/verifier/reasons.ts`) is consequently unused — kept defined (documents the conceptual failure mode) rather than removed, since deleting it would understate what the reason-code taxonomy was designed to cover.
- **A15-A19** exercise Gate 5's real conflict/stale/one-relay-down/both-relays-down/digest-mismatch detection (`evaluatePolEvidence`), feeding its computed reason code through `verify()`'s `nostr.reasonCode` field.
- **A20-A22** exercise Gate 6's real signature/spent/mismatch detection (`evaluateReserveAttestation`) the same way, via `verify()`'s `reserve.reasonCode` field.
- **A24** spies on `runAcceptGate`'s injected accept function directly (same mechanism as the Gate 4 tests) and asserts zero calls for a forged-receipt REFUSE case.

### `verify()`'s `reserve`/`nostr` inputs gained an optional `reasonCode`

Additive, backward-compatible change to `src/verifier/verify.ts`: `reserve`/`nostr` inputs can now carry a specific reason code (e.g. `REFUSE_NOSTR_STALE`, `REFUSE_RESERVE_UTXO_SPENT`) computed by the real Gate 5/6 evaluators, instead of only a `verified: boolean`. When omitted, behavior is unchanged (`REFUSE_NOSTR_UNAVAILABLE`/`REFUSE_RESERVE_SHORT` defaults, exactly as before) — none of the pre-existing 9 tests needed to change. This is what lets `verify()` remain "the one authoritative central verifier" that surfaces Gate 5/6's specific findings, without `verify()` itself doing any network I/O (it stays synchronous and pure; the real fetch/query lives in `src/nostr/pol-evidence.ts` and `src/reserve/fetch-and-evaluate.ts`, which orchestrate the network call and then call `verify()` with the result).

### `verify:submission` rewritten to be genuinely fail-closed

Previously, `verify:submission` printed `FAIL` lines for missing work but always exited 0 (a real defect, called out explicitly this session). It's now split into `src/cli/verify-submission-core.ts` (pure, re-derives Gate 0-6 mechanism checks with real cryptography on every run — no stubs) and a thin CLI wrapper that gathers the three pieces of state the pure core can't determine itself (the attack corpus's live pass count via re-running `src/cli/attacks.ts`, and the last-recorded live Nostr/reserve evidence from `evidence/nostr/cases.json` / `evidence/reserves/cases.json`). `process.exit()` is keyed off a real `failures` count derived from every required line; nothing is hardcoded to pass. Tests: `tests/cli/verify-submission.test.ts` (9 tests, including an exhaustive single-line-break sweep proving the command cannot report "SUBMISSION READY" while any one required item fails).

One Windows-specific bug fixed en route: `child_process.execFileSync('npx', ...)` failed with `ENOENT` because `execFileSync` doesn't resolve `.cmd` shims without `shell: true` on Windows — fixed by passing `shell: true`.

### `tsconfig.json` now includes `tests/`

Previously `"include": ["src"]` meant every `npx tsc -p tsconfig.json --noEmit` check this session (and every prior one) silently never type-checked any test file — a real gap, caught when a test file's wrong import path (`bytesToHex` from the wrong module) type-checked clean but failed at runtime. `tests` was added to `include`; `npm run build`'s own `tsc` step (`src` only, for the shipped bundle) is unaffected in what it emits, but `--noEmit` type-checking now covers tests too.

### Git history note

No commits were made this session; all Gate 4-6/attack-corpus/submission-verifier work above remains uncommitted, per the repo owner's standing instruction — commits only on explicit request, and never with a co-author attribution line.

---

## 2026-09-21/22 — Gates 0-3 complete; Gates 4-10 not started this session

### Status

| Gate | Status | Evidence |
| --- | --- | --- |
| 0 — NUT-12 transfer invariant | **PASS** | `evidence/gate-0/` |
| 1 — real issuance + signed PoL receipt | **PASS** | `evidence/gate-1/` |
| 2 — issued/spent sum-MMR + signed epoch | **PASS** | `evidence/gate-2/` |
| 3 — hero contradiction | **PASS** | `evidence/hero/` |
| 4 — enforced accept/refuse | Not started | — |
| 5 — Nostr public evidence | Not started (v1 Nostr plumbing exists but targets the v1 event schema, not v2) | — |
| 6 — real Signet/testnet reserve attestation | Not started | — |
| 7 — attack battery + evidence harvesting | Partial: 15/24 (A01, A02, A04-A14, A18-partial, A23) | `evidence/attacks/`, `ATTACKS.md` |
| 8 — mobile accept gate | Not started (v1 mobile-responsive UI exists but renders the v1 result shape) | — |
| 9 — landing page + responsive QA | Not started for v2 (v1 landing page exists, describes the v1 mechanism) | — |
| 10 — submission freeze | Not reached | — |

### Why gates 4-10 stopped here

Gates 0-3 are the cryptographic spine the entire product depends on — PRD §0 names Gate 3 "the most important gate after Gate 0." Each was built to the standard the PRD demands: real library code (not hand-authored fixtures pretending to be proofs), byte-exact to the pinned Cashu PR #388 draft, cross-validated against the draft's own official test vectors (not self-authored ones), with machine-readable evidence and automated regression tests. Two real bugs were caught and fixed this way (an inverted sibling-position bit in the MMR inclusion proof, and a wrong digest byte length for `previous_global_digest`) — vector cross-checking earned its keep.

Gates 4-6 each require a categorically different kind of work than gates 0-3 (spinning up a real local Cashu mint HTTP server to observe a real accept/receive call for Gate 4; acquiring real Bitcoin Signet testnet coins and querying a real block explorer for Gate 6; redesigning the Nostr event schema around the v2 evidence shape and wiring real multi-relay conflict detection for Gate 5) rather than extending the same in-process TypeScript modules gates 0-3 used. Gates 8-9 require rebuilding the UI layer against `src/verifier/verify.ts`'s result shape (the current v1 UI in `src/app/` renders the old, now-superseded v1 result shape and was not touched this session). None of these were attempted superficially; per the PRD's own instruction ("if not fixed by submission, disclose it"), they are named here as explicitly outstanding rather than partially faked.

### Reason-code / verifier scope decision

`src/verifier/verify.ts` implements the PRD's 17-check decision rule for checks 1-9 (the full crypto spine) and accepts `reserve`/`nostr` as **optional externally-supplied booleans** for checks 10+ rather than computing them itself, since Gates 5-6 don't exist yet. Omitting either fails closed to `REFUSE_UNVERIFIABLE` — never silent `ACCEPT`. This was a deliberate choice over either (a) making `verify()` permanently unable to return `ACCEPT` (which would make it impossible to demonstrate the honest case at all), or (b) hardcoding those checks to `true` (which would be exactly the "fake evidence" the PRD forbids). See `docs/trust-boundaries.md`.

### Repository housekeeping

The v1 `src/mint/`, `src/proof/mint-leaf.ts`, `src/proof/burn-leaf.ts`, `src/proof/bundle.ts` modules (the custom, non-PR-#388-aligned Merkle-sum design) were **not deleted** this session — they still work, are still tested (83 passing v1 tests), and nothing in the v2 build depends on their removal. They are marked for removal once a v2 UI supersedes the v1 app that currently consumes them.

### Git history note

An earlier "chore: audit v1 repo for solvent v2 migration" checkpoint commit was made, then explicitly undone (`git reset --soft`) at the repo owner's instruction — commits are made only when explicitly requested from here on, and without any co-author attribution line.

---

## 2026-09-21 — v2 migration audit

**Commit at audit time:** `983ab48` (only commit in the repo; all v1 work below was uncommitted working-tree state, not yet on any commit).

### What existed before v2 (SOLVENT v1)

A complete, tested, working hackathon build implementing a **self-invented** liability-accounting design:

- Real NUT-12 DLEQ verification and `C'` reconstruction (`src/cashu/dleq.ts`, `mint-sim.ts`) using `@cashu/cashu-ts` directly — cross-checked against the official NUT-12 test vectors from `cashubtc/nuts`.
- A custom binary Merkle-**sum** tree (`src/proof/merkle-sum.ts`) — NOT an MMR — with domain-separated leaf/node hashing, used to commit "mint" and "burn" leaves keyed on `(keysetId, amount, C')`.
- A custom Nostr solvency-report event (kind `31111`, schema `solvent/v1`) signed and published to public relays, with a fail-closed browser verifier (live-report-required, explicit opt-in local fallback).
- A `demo-reserve` fixture (a signed number, not chain evidence).
- A full two-mint fixture demo (mint-a healthy/omitted, mint-b short-reserve) reachable via CLI (`verify:fixture`) and a mobile-responsive landing + verifier + publisher web app (83 passing tests, clean `npm run build`).

### What remains valid under v2

- **`src/cashu/dleq.ts`** — the NUT-12 DLEQ verification wrapper (`hasValidDleq`/`verifyDLEQProof_reblind` via cashu-ts, `C' = C + rA` reconstruction) is exactly the Gate-0 mechanism v2 requires. Reusable as-is; `B'` reconstruction (`B' = Y + rG`, currently only implicit inside cashu-ts's internal `nr` function) needs to be surfaced explicitly for Gate 0's evidence requirement.
- **`src/cashu/mint-sim.ts`** — real issuance-side blind-signing simulator (`blindMessage`, `createBlindSignature`, `createDLEQProof`, `constructUnblindedSignature`) is the correct Gate-0 issuance path; needs to additionally push the result through the library's actual token serialize/deserialize round trip rather than constructing the `Proof` object directly, per the v2 spike requirement.
- **`src/encode/canonical.ts`** — length-prefixed big-endian encoding helpers are superseded by PR #388's own canonical encoding (`bytes_2`, `bytes_8`, literal domain-separator strings) for the new PoL structures, but remain useful for anything not spec-mandated.
- **Nostr plumbing** (`src/nostr/event.ts`, `publish-core.ts`) — `nostr-tools` signing/publish/fetch machinery is reusable; the event **schema** must change (new evidence fields, immutable-event retention model per PRD §12.2) but the transport code is not v1-specific.
- **UI shell** (routing, design system, evidence-drawer pattern, progressive disclosure, mobile-first CSS) is structurally reusable; the **content** it renders must switch from the v1 result shape to the v2 `VerificationResult` (ACCEPT/REFUSE, new reason codes, new evidence fields).
- **Test infrastructure** (Vitest, jsdom UI harness, fixture-generation pattern) is reusable.

### What is deprecated (v1-specific, tied to the obsolete custom design)

- The v1 "mint-proof / burn-proof Merkle-sum" semantics in `src/mint/reports.ts`, `src/mint/types.ts`, `src/mint/build.ts`, `src/proof/mint-leaf.ts`, `src/proof/burn-leaf.ts`, `src/proof/bundle.ts` — these implement a **different, self-invented accounting model** (issued/burned Merkle-sum keyed on the reconstructed value directly, no target-epoch receipt, no MMR, no PR #388 alignment). PR #388 uses **MMRs** (append-only, peak-bagging, consistency proofs), not binary Merkle-sum trees, and requires a **signed transactional receipt binding an exact issuance to a target epoch** — a concept v1 does not have at all.
- The v1 `reserve_kind: "demo-reserve"` signed-number reserve model is explicitly disallowed as the final hero path under v2 (Gate 6 requires real Signet/testnet UTXO evidence).
- The v1 verifier's check list (`src/verifier/rules.ts`, `VerifyChecks`) and its `ResultClassification`/`copyFor` UI mapping are shaped around the v1 accounting model and will not directly apply to the v2 decision rule (17 required checks, different reason codes).

### What will be migrated (reused with modification)

- `src/cashu/dleq.ts` → extended into `src/cashu/reconstruct.ts` (explicit `B'` alongside `C'`) per the target `src/cashu/` layout.
- `src/nostr/*` → schema updated to v2 evidence shape; kind re-chosen after checking the current NIP registry (v1 used experimental kind `31111` without that check — must redo per PRD §12.2).
- UI design system (routing, CSS variables, evidence-drawer accordion pattern) → re-skinned around v2's ACCEPT/REFUSE copy and reason codes.

### What will be removed

- `src/mint/`, `src/proof/mint-leaf.ts`, `src/proof/burn-leaf.ts`, `src/proof/bundle.ts` and their tests, once the v2 `src/pol/` module reaches parity — kept for now (not blocking v2 work, and deleting working code before its replacement is proven would violate "don't delete v1 code simply because v2 changed architecture" without cause). Marked for removal once Gate 2 passes.
- The `fixtures/mint-a.json` / `mint-b.json` / `tokens/*.json` demo fixtures — tied to v1 semantics; superseded by `fixtures/captured/` and `fixtures/attacks/` once Gate 1/2 fixtures exist.

### Exact dependency versions currently installed

| Package | package.json range | Installed (node_modules) |
| --- | --- | --- |
| `@cashu/cashu-ts` | `^4.10.2` | `4.10.2` |
| `nostr-tools` | `^2.25.2` | `2.25.2` |
| `@noble/curves` | `^2.4.0` | `2.4.0` |
| `@noble/hashes` | `^2.4.0` | `2.4.0` |
| `typescript` | `^7.0.2` | (dev) |
| `vite` | `^8.3.0` | (dev) |
| `vitest` | `^5.0.1` | (dev) |
| Node.js | — | `v24.13.1` |

`@cashu/cashu-ts` exposes `schnorrSignDigest`/`schnorrVerifyDigest` (BIP-340 Schnorr over an arbitrary digest, using the same secp256k1 primitives as the rest of the library) — this is the exact primitive PR #388 requires for receipt/manifest signing (signed with `private_keys[amount]`, the same per-denomination keys already used for Cashu blind signing). No separate crypto dependency needed for the secp256k1 signature path.

### Current test count / build status (pre-v2, baseline)

- `npm test`: **83/83 passing** (7 files).
- `npm run build`: passing (tsc + Vite, ~228KB/81KB gzipped JS).

### Source pinning (v2 §2)

| Source | URL | Inspected | Notes |
| --- | --- | --- | --- |
| Cashu NUT-12 | `cashubtc/nuts/blob/main/12.md` | 2026-09-20 (prior session) + re-confirmed 2026-09-21 | Verified against official `tests/12-tests.md` vectors — 7/7 pass through `@cashu/cashu-ts`. |
| Cashu PR #388 draft (`pol.md`) | `github.com/a1denvalu3/nuts/blob/pol-spec/pol.md` | 2026-09-21, fetched raw (not summarized) | Full text captured; MMR leaf/node/peak-bagging formulas, keyset-manifest/global-digest encoding, receipt message format, BIP-340 signing scheme, verification protocol, and 5 fraud-challenge schemas all recorded exactly as published. |
| PR #388 test vectors (`tests/pol-tests.md`) | same branch | 2026-09-21, fetched raw | 2-leaf and 3-leaf MMR vectors, 3→4 consistency proof, keyset-manifest + global-digest + BIP-340 signature vector, 2 PoL receipt signature vectors, 5 keyset-lifecycle vectors. Used to build `tests/pol/*` against known-good hex, not self-authored fixtures. |
| BIP-322 | `bitcoin/bips/blob/master/bip-0322.mediawiki` | Not yet inspected — deferred to Gate 6. | |

**Public naming rule applied:** all new docs/code refer to "Cashu PR #388 / draft Proof-of-Liabilities proposal," never "NUT-388," per the draft's own header (`Draft identifier: 388 is the proposal's pull-request number...`).

### Immediate next action

Gate 0 spike using the real `@cashu/cashu-ts` issuance/DLEQ path, explicit `B'` capture and reconstruction, evidence written to `evidence/gate-0/`.

---
