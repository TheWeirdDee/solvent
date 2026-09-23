# SOLVENT — Product Requirements v2 (LOCKED)

**BOSS Battle 2026**  
**Track:** Freedom Stack — Nostr + Ecash  
**Official problem:** Auditable Ecash — Mint Proof-of-Reserves & Proof-of-Liabilities  
**Status:** Locked mechanism; evidence may correct implementation details, not silently change the mechanism  
**Version date:** 2026-09-21  
**Submission deadline:** 2026-10-05, 11:59 PM IST  
**Licence:** MIT

This file replaces the earlier SOLVENT PRD as the build source of truth.

The lesson taken from Precedence is **coherence, not volume**. SOLVENT must implement one cryptographic-economic chain to working depth. Do not turn this document into permission to build many impressive but disconnected subsystems.

---

## 1. Locked one-sentence product

> **SOLVENT lets the ecash you are receiving challenge its mint's own signed accounting before your wallet accepts it.**

Expanded:

> A Cashu mint cryptographically promises that a specific issuance will appear in a target liability epoch. A later holder independently reconstructs that exact issuance from the received ecash, checks the signed epoch, verifies reserves and public Nostr evidence, and refuses the ecash if the mint's own signed promises contradict its accounting.

---

## 2. The one chain everything must serve

```text
MINT PROMISES
    ↓
HOLDER RECONSTRUCTS THE EXACT ISSUANCE
    ↓
HOLDER CHECKS THE PROMISED EPOCH
    ↓
CONTRADICTION BECOMES VERIFIABLE EVIDENCE
    ↓
WALLET REFUSES THE ECASH
```

This is SOLVENT's equivalent of a single load-bearing primitive.

If a feature cannot answer **how it strengthens this chain**, cut it.

The product is not:

- a mint analytics dashboard;
- a generic mint reputation score;
- a full Cashu wallet;
- a complete implementation of every idea in Cashu PR #388;
- a Proof-of-Reserves research project by itself;
- a Nostr social client;
- an AI product.

---

## 3. Why this is the correct BOSS problem

The official Freedom Stack brief names **Cashu and Fedimint mints** as custodial systems whose outstanding ecash is an IOU against Lightning or on-chain reserves. It asks a strong submission to ship:

1. a privacy-preserving Proof-of-Liabilities commitment;
2. a Proof-of-Reserves attestation bound to the mint identity;
3. a public independently verifiable solvency ratio published as signed Nostr events;
4. a wallet-side red/green verifier before accepting ecash.

The brief explicitly says judging for this problem includes:

- soundness;
- privacy;
- practicality on mobile;
- defined behavior on partial reserves or stale proofs.

SOLVENT implements that official stack but adds an adversarial hero case:

> **A mint can publish a healthy-looking aggregate ratio while omitting a real issuance. SOLVENT lets the holder use the ecash itself to expose that contradiction before acceptance.**

---

## 4. What changed from SOLVENT v1

### v1

SOLVENT invented its own `C'`-based issued/burned Merkle-sum accounting and then verified a holder's issuance against that custom structure.

### v2

SOLVENT aligns its liability semantics to **Cashu PR #388 / draft Proof-of-Liabilities proposal** and implements only the slice needed for the BOSS mechanism:

```text
real Cashu issuance artifact
→ signed transactional PoL receipt
→ target epoch
→ issued/spent sum-MMR state
→ signed manifest
→ holder reconstructs B'
→ inclusion or omission check
→ accept/refuse
```

Do not call PR #388 “NUT-388” in public copy. It is currently a draft NUT-XX proposal; 388 is the pull-request number.

### v1 reserve behavior

`demo-reserve` fixture.

### v2 reserve behavior

A **real signet/testnet reserve attestation** over real UTXO state, clearly labelled by network. No claim of mainnet reserves.

### v1 UI behavior

Thin verifier page; desktop-first risk.

### v2 UI behavior

Mobile-first accept gate plus a clear landing page and progressive disclosure of cryptographic evidence.

---

# 5. Gate 0 — load-bearing Cashu invariant

**Nothing else is allowed to become the main implementation until Gate 0 passes.**

The entire hero mechanism depends on a receiver being able to reconstruct the same blinded message `B'` that the mint signed.

For the supported Phase-1 path, the received Cashu `Proof` must contain NUT-12 DLEQ data:

```json
{
  "id": "<keyset id>",
  "amount": 1000,
  "secret": "<secret>",
  "C": "<unblinded signature>",
  "dleq": {
    "e": "<challenge>",
    "s": "<response>",
    "r": "<sender blinding factor>"
  }
}
```

NUT-12 explicitly defines the user-to-user path with `r` included. The receiver reconstructs:

```text
Y  = hash_to_curve(secret)
B' = Y + rG
C' = C + rA
```

Then verifies the mint's DLEQ proof against the correct denomination key `A`.

## Gate-0 executable spike

Using the real Cashu library path selected for the build:

1. create or obtain a real secp256k1 Cashu issuance;
2. create the transferable token/proof using the library, not handcrafted JSON;
3. serialize the token exactly as it would move wallet-to-wallet;
4. assert the received proof contains `dleq.e`, `dleq.s`, and `dleq.r`;
5. reconstruct `Y`, `B'`, and `C'` from the received proof;
6. verify the DLEQ against the correct mint key;
7. compare reconstructed `B'` to the original issuance-side `B'` captured before transfer;
8. write the result to `evidence/gate-0/`.

Required evidence:

```text
evidence/gate-0/token-received.json
evidence/gate-0/original-issuance.json
evidence/gate-0/reconstruction.json
evidence/gate-0/verify.txt
```

`reconstruction.json` must show:

```json
{
  "original_b_prime": "...",
  "reconstructed_b_prime": "...",
  "equal": true,
  "dleq_valid": true
}
```

## Gate-0 failure rule

If the actual library transfer path strips `r`, fails to preserve the needed DLEQ information, or cannot reconstruct the exact issuance under realistic transfer semantics:

**STOP. Do not quietly replace the mechanism with a mint-supplied token ID.**

Investigate whether the library needs an explicit “include DLEQ” option or another conforming path. Record the result in `DECISIONS.md`.

Phase-1 product behavior for ecash without usable NUT-12 reconstruction data:

```text
UNSUPPORTED / REFUSE
```

NUT-12 is optional. SOLVENT must never pretend unsupported ecash has been independently verified.

---

# 6. Supported protocol scope

Phase 1 deliberately supports one narrow cryptographic path deeply:

- Cashu;
- sats unit;
- secp256k1 / BDHKE Cashu keyset compatible with the NUT-12 reconstruction path;
- proofs carrying usable `e`, `s`, `r` DLEQ data;
- one controlled demo keyset sufficient to prove the full mechanism;
- draft-PR-#388-shaped issued/spent accounting and transactional receipts;
- Nostr distribution;
- signet/testnet reserve evidence;
- one actual accept/refuse integration path.

Out of scope for the hero path:

- BLS12-381/v3 Cashu support;
- Fedimint;
- all possible Cashu keyset lifecycle states;
- production-scale multi-mint aggregation;
- every optional component of PR #388;
- bonded/slashable PoL extension;
- mainnet reserve claims;
- complete Lightning-channel reserve accounting.

Do not add another cryptographic family before the secp256k1 hero path is finished, attacked, evidenced, and usable on mobile.

---

# 7. Actors

| Role | Actor | What they do |
| --- | --- | --- |
| Mint operator | Controlled Cashu-compatible issuer | Issues ecash, receipts, closes PoL epochs, publishes state |
| Sender | Alice | Transfers NUT-12-capable ecash |
| Receiver | Bob | Is about to accept ecash and invokes SOLVENT |
| Wallet gate | SOLVENT verifier/adapter | Independently checks the proof and allows/blocks acceptance |
| Reserve controller | Signet/testnet Bitcoin key | Controls the reserve UTXO(s) used in PoR evidence |
| Nostr relays | At least two public relays | Carry signed public evidence/state |
| Auditor/judge | Anyone | Recomputes the hero evidence without trusting the UI |

The first economic actor is the **receiver about to accept ecash**.

---

# 8. Value return

User puts in:

- received Cashu ecash;
- mint identity / discoverable mint metadata;
- one tap: **Check before accepting**.

SOLVENT derives or verifies:

- mint/keyset identity;
- proof amount;
- NUT-12 DLEQ validity;
- reconstructed `B'` and `C'`;
- signed PoL receipt for the issuance;
- receipt target epoch;
- signed epoch manifest;
- issued sum-MMR inclusion or omission;
- spent sum-MMR state and liability arithmetic;
- signed Nostr publication/freshness/conflict status;
- real signet/testnet reserve state and mint binding;
- final acceptance policy.

User gets back:

```text
ACCEPT
```

or

```text
REFUSE
```

plus one plain-language reason.

Technical evidence is available behind an expandable evidence drawer; it is not the default user experience.

---

# 9. Hero contradiction

This is the center of the project.

## Honest case

Mint issues a 1,000-sat output with blinded message:

```text
B' = 02abc...
```

The mint signs a PoL receipt that commits this issuance to epoch 12:

```text
Cashu_PoL_Receipt_Issued:<B'_hex>:12
```

Epoch 12 closes and contains the issuance.

Receiver reconstructs the same `B'`, verifies the receipt, verifies inclusion, checks reserve coverage.

Result:

```text
ACCEPT
```

## Hero fraud case

The mint signs the same issuance receipt:

```text
B' = 02abc...
target_epoch = 12
```

but closes signed epoch 12 **without that issuance** while publishing an apparently healthy aggregate reserve/liability state.

Receiver independently reconstructs:

```text
B' = 02abc...
```

from the received token.

The receipt verifies.

The target epoch is closed and signed.

The mint cannot produce a valid issued-tree inclusion proof for the promised item/value.

Result:

```text
REFUSE
```

Primary result copy:

> **This mint signed a promise to account for this liability in epoch 12, but its signed epoch-12 accounting omits it. Do not accept this ecash.**

This is not a risk score. It is a contradiction between cryptographically verifiable claims.

---

# 10. Mechanism

## 10.1 Real Cashu issuance artifacts

The controlled mint path must produce real cryptographic artifacts using current Cashu-compatible primitives/libraries:

- keyset id;
- denomination key;
- blinded message `B'`;
- blind signature `C'`;
- resulting proof `(secret, C)`;
- NUT-12 `(e, s, r)` for transfer;
- amount.

Fixtures may freeze these real outputs for deterministic tests, but the artifacts must first be generated by real code.

Do not hand-author a “valid” proof object and then test your own parser against it.

---

## 10.2 Holder-independent reconstruction

Given a received proof:

```text
secret, C, e, s, r, amount, keyset_id
```

SOLVENT:

1. fetches/resolves the correct public denomination key `A`;
2. derives `Y = hash_to_curve(secret)`;
3. computes `B' = Y + rG`;
4. computes `C' = C + rA`;
5. verifies the NUT-12 DLEQ;
6. rejects on any mismatch;
7. uses reconstructed `B'` — not a mint-supplied opaque identifier — for the liability check.

This is non-negotiable.

---

## 10.3 Minimal Cashu PR #388 receipt slice

PR #388 is a **draft**. SOLVENT does not claim it is a finalized Cashu NUT.

Implement the minimum interoperable shape needed for this project.

For an issued output, the mint generates a receipt:

```json
{
  "target_epoch": 12,
  "signature": "<hex>"
}
```

Receipt message for the supported secp256k1 path:

```text
"Cashu_PoL_Receipt_Issued:" || B'_hex || ":" || target_epoch_decimal
```

The receipt must be verified against the appropriate keyset/amount public key according to the draft's current secp256k1 rules.

The verifier must not trust `target_epoch` until the signature verifies.

The omission challenge is valid only when:

- the receipt signature verifies;
- the receipt commits the exact reconstructed `B'` and amount/key context;
- `target_epoch` has closed;
- the applicable signed manifest verifies;
- the mint fails to prove correct inclusion/value for the item in target epoch or later according to the implemented scope.

---

## 10.4 Liability accounting

SOLVENT v2 aligns to the draft's **issued** and **spent** append-only sum-MMR shape.

For the supported keyset:

### Issued leaf

```text
hash = SHA256(compressed_bytes(B'))
sum  = amount_sats
```

### Spent leaf

```text
Y    = hash_to_curve(secret)
hash = SHA256(compressed_bytes(Y))
sum  = amount_sats
```

### Outstanding liability

```text
outstanding_balance = issued_root_sum - spent_root_sum
```

Required properties for Phase 1:

- deterministic node hashing with sum bound into parent calculation;
- append-only behavior;
- inclusion proof generation;
- inclusion proof verification;
- correct root sums;
- no uint64 sum overflow;
- signed epoch manifest;
- hero omission challenge;
- liability equation verification.

### Deliberate cut

Do **not** block the hero mechanism on implementing every PR-#388 feature.

Not required before the spine works:

- OpenTimestamps anchoring;
- multi-keyset global Merkle commitment;
- complete lifecycle/rotation fraud suite;
- bonded/slashing extension;
- BLS receipt scheme;
- production HTTP API compatibility.

If these become low-cost after the spine is complete, add them only behind new gates.

---

## 10.5 Epoch manifest

For the Phase-1 supported keyset, close an epoch with a canonical manifest containing at minimum:

```json
{
  "schema": "solvent/pol-v1",
  "keyset_id": "...",
  "unit": "sat",
  "epoch_index": 12,
  "timestamp": "2026-09-21T00:00:00Z",
  "previous_epoch_digest": "...",
  "issued_mmr_size": 0,
  "issued_mmr_root_hash": "...",
  "issued_mmr_root_sum": 0,
  "spent_mmr_size": 0,
  "spent_mmr_root_hash": "...",
  "spent_mmr_root_sum": 0,
  "outstanding_balance": 0,
  "mint_signing_pubkey": "...",
  "mint_signature": "..."
}
```

The exact canonical serialization must be written in `docs/protocol.md` and covered by test vectors.

Where practical, use the current PR-#388 canonical field semantics. If the implementation intentionally simplifies the draft, name the divergence in `docs/draft-alignment.md`.

Never silently claim draft compatibility beyond what is actually implemented.

---

## 10.6 Fraud evidence object

For the hero case produce a self-contained evidence file:

```json
{
  "type": "leaf_omission_or_mismatch",
  "mint": "...",
  "keyset_id": "...",
  "amount": 1000,
  "reconstructed_b_prime": "...",
  "pol_receipt": {
    "target_epoch": 12,
    "signature": "..."
  },
  "manifest": { "...": "complete signed manifest" },
  "inclusion_status": "missing",
  "decision": "REFUSE"
}
```

The verifier CLI must be able to recompute the decision from this object plus public mint/keyset/reserve inputs.

---

# 11. Proof of Reserves — bounded but real

The official BOSS problem explicitly asks for PoR. `demo-reserve` is not acceptable as the final headline path.

Phase 1 target:

> **real signet/testnet UTXO reserve evidence, cryptographically bound to the mint identity, independently queried by the verifier.**

## 11.1 Required reserve properties

At least one reserve UTXO must:

- really exist on the named Bitcoin test network;
- be unspent when the published evidence is generated;
- have a real txid/vout/value/scriptPubKey;
- be controlled by a key for which SOLVENT can produce a valid ownership/control proof;
- be bound to the mint identity in a signed reserve statement;
- be independently re-queried by the verifier;
- have the network visibly labelled in UI and evidence.

No screenshot-only PoR.

## 11.2 Preferred proof form

Preferred, if current libraries make it reliable within the build window:

- **BIP-322** message/proof-of-funds-compatible proof for the reserve script/UTXO set.

Acceptable bounded implementation if full proof-of-funds support becomes a scope trap:

1. canonical reserve statement includes network, outpoints, values, scriptPubKeys, timestamp/height and reserve public key;
2. controlling reserve key signs the statement using a standard message-signing mechanism supported for the script type;
3. mint master identity key separately signs/binds the reserve public key + statement digest;
4. verifier independently queries the named signet/testnet network and confirms every declared outpoint is still unspent with the claimed value/script;
5. verifier checks both signatures/bindings.

Do not label a custom scheme “BIP-322” unless it actually conforms to BIP-322.

## 11.3 Reserve amount

```text
reserve_sats = sum(verified_unspent_reserve_utxos)
```

Phase-1 coverage decision:

```text
reserve_sats >= outstanding_balance  → reserve coverage PASS
reserve_sats <  outstanding_balance  → REFUSE
```

## 11.4 Honest UI wording

Examples:

```text
Reserve network: Bitcoin Signet
Verified UTXOs: 2
Verified reserve: 80,000 sats
Committed liabilities: 70,000 sats
Coverage: 1.14×
```

Never show “mainnet reserves” unless mainnet is actually used.

Lightning channel balances are an explicit later extension unless a real, verifiable channel attestation becomes low-cost after the spine is complete.

---

# 12. Nostr — public evidence transport

Nostr is load-bearing as the public distribution layer, not the source of truth for the underlying cryptography.

## 12.1 Publish

Publish signed SOLVENT evidence/state to **at least two public Nostr relays**.

At minimum publish:

- mint identity reference;
- epoch index;
- manifest digest;
- issued/spent root hashes + sums or a digest that deterministically commits them;
- outstanding liability amount;
- reserve-attestation digest;
- reserve amount/network;
- freshness/expiry metadata;
- URL or content-addressed location of full proof bundle when too large for the event;
- schema/version.

Do not publish token owners or raw owner mappings.

## 12.2 Event retention model

The audit record must not depend solely on an addressable event that relays may replace/discard.

Use:

- an immutable/regular event for historical evidence/state;
- optionally a separate “latest state” pointer for convenient discovery.

Before hard-coding an event kind, check the current NIP registry for collisions and record the chosen experimental/custom kind in `DECISIONS.md`.

## 12.3 Fetch

Verifier must:

- query at least two relays;
- accept one-relay failure if valid state is available from the other;
- verify the Nostr event signature;
- verify the event commits the same manifest/reserve evidence used for the decision;
- reject stale evidence;
- detect conflicting valid signed state for the same logical epoch/reporting scope and fail closed.

Missing state behavior:

```text
REFUSE / UNVERIFIABLE
```

Do not turn relay failure into GREEN.

---

# 13. Actual enforcement

The proof must change an action, not merely produce a badge.

Required:

```text
received token
→ SOLVENT.verify(token)
→ decision
→ ACCEPT invokes the real acceptance/import/claim side effect
→ REFUSE never invokes it
```

Preferred implementation:

Wrap the actual `cashu-ts` receive/import/swap path discovered during Gate 0.

Pseudo-interface only; do not invent library method names:

```ts
const result = await solvent.verify(receivedToken)

if (result.decision !== 'ACCEPT') {
  return blocked(result.reason)
}

return cashuWalletActualReceiveMethod(receivedToken)
```

The test suite must spy/observe the real acceptance function:

- GREEN → function called exactly once;
- RED → function called zero times.

If a live mint/network is needed for the post-ACCEPT side effect, use a controlled local/test mint. Do not operate a production Lightning mint merely to satisfy the demo.

---

# 14. Decision rule

`ACCEPT` only if **every required check** for the supported path passes.

Required checks:

1. token parses as supported Cashu proof(s);
2. supported keyset/curve path;
3. NUT-12 DLEQ information exists, including `r`;
4. DLEQ verifies;
5. reconstructed `B'` is derived locally from the received proof;
6. issuance PoL receipt verifies for that exact `B'` and amount/key context;
7. target epoch is closed and signed;
8. manifest signature verifies;
9. issued-tree inclusion/value proof verifies for the reconstructed `B'`;
10. liability arithmetic verifies;
11. reserve attestation signature/binding verifies;
12. reserve UTXOs independently verify as unspent on the declared network;
13. verified reserves cover committed outstanding liabilities;
14. Nostr evidence signature verifies;
15. Nostr evidence commits the same manifest/reserve digests;
16. evidence is fresh;
17. no valid conflicting state has been detected for the same epoch/scope.

Anything else is:

```text
REFUSE
```

or, for unsupported cryptographic paths:

```text
UNSUPPORTED / REFUSE
```

The product fails closed.

---

# 15. Attack battery — first-class deliverable

These are not decorative unit tests. They are the depth evidence.

| ID | Attack / condition | Expected |
| --- | --- | --- |
| A01 | valid token + valid receipt + included issuance + covered reserve | ACCEPT |
| A02 | receipt promises issuance but target epoch omits it | REFUSE |
| A03 | issuance included with wrong value | REFUSE |
| A04 | forged receipt signature | REFUSE |
| A05 | receipt target epoch modified after signing | REFUSE |
| A06 | reconstructed `B'` changed/tampered | REFUSE |
| A07 | invalid DLEQ | REFUSE |
| A08 | missing `r` | UNSUPPORTED / REFUSE |
| A09 | wrong mint/keyset public key | REFUSE |
| A10 | tampered MMR sibling hash | REFUSE |
| A11 | tampered sibling sum | REFUSE |
| A12 | reordered/wrong positional proof | REFUSE |
| A13 | manifest signature flipped | REFUSE |
| A14 | manifest liability arithmetic inconsistent | REFUSE |
| A15 | conflicting signed manifests for same epoch | REFUSE + evidence |
| A16 | stale Nostr state | REFUSE |
| A17 | one relay unavailable, second has valid state | deterministic success path |
| A18 | both relays unavailable | REFUSE / UNVERIFIABLE |
| A19 | Nostr event digest differs from proof bundle | REFUSE |
| A20 | reserve signature invalid | REFUSE |
| A21 | reserve outpoint spent after attestation | REFUSE / STALE RESERVE |
| A22 | reserve outpoint value/script mismatch | REFUSE |
| A23 | valid liabilities but reserve below liabilities | REFUSE |
| A24 | RED token attempts acceptance side effect | acceptance function called zero times |

Every attack must produce a machine-readable result under:

```text
evidence/attacks/Axx-*/
```

At minimum:

```text
input.json
result.json
verify.txt
```

`result.json` must contain a stable reason code.

---

# 16. Evidence-first repository

Required public evidence surfaces:

```text
evidence/
  gate-0/
  hero/
  reserves/
  nostr/
  attacks/
  live/
```

Required documents:

```text
README.md
VERIFY_IN_5_MINUTES.md
PROTOCOL.md
docs/draft-alignment.md
docs/trust-boundaries.md
docs/reserve-attestation.md
docs/nostr-schema.md
ATTACKS.md
DECISIONS.md
```

## Five-minute verifier requirement

A judge on a clean machine must be able to:

1. install dependencies;
2. run one command;
3. verify the GREEN fixture;
4. verify the hero omission contradiction;
5. verify the short-reserve case;
6. see PASS/FAIL reasons and evidence file paths.

Target shape:

```bash
npm ci
npm run verify:submission
```

Output should be concise and deterministic.

---

# 17. Interface — mobile first

The official problem explicitly values **practicality on mobile**, and BOSS scores UI/UX separately.

This is a protocol-heavy product whose default screen must feel simpler than the architecture underneath it.

## 17.1 Supported viewport acceptance tests

Hard QA targets:

```text
390 × 844   primary mobile
768 × 1024  tablet
1440 × 900  desktop
```

No horizontal scrolling on product surfaces.

No clipped evidence drawer.

Touch targets must be comfortably tappable.

Primary result must remain visible without zoom.

---

## 17.2 Landing page

Purpose: explain the mechanism before the judge opens the verifier.

### Hero

Headline:

> **Don't trust a mint's solvency report. Make your ecash check it.**

Subcopy:

> SOLVENT verifies the mint's signed liability promise, checks that the ecash in your hand was actually counted, verifies reserve coverage, and blocks acceptance when the evidence contradicts the mint.

Primary CTA:

```text
Try the accept gate
```

Secondary CTA:

```text
Verify the evidence
```

Visual mechanism:

```text
MINT PROMISE → HOLDER PROOF → ACCOUNTING CHECK → ACCEPT / REFUSE
```

### Required landing sections

1. The broken trust assumption
2. How the four-step mechanism works
3. Hero contradiction example
4. What is independently verified
5. What SOLVENT does **not** prove
6. Signet reserve disclosure
7. Reproducible evidence / GitHub
8. CTA into the live verifier

No giant marketing page.

No invented user metrics.

No vague “AI-powered” style language.

---

## 17.3 Accept-gate flow

Default mobile flow:

```text
[ Paste / scan Cashu ecash ]
            ↓
[ Check before accepting ]
            ↓
     ACCEPT  /  REFUSE
            ↓
   one-sentence reason
            ↓
[ View cryptographic evidence ]
```

### ACCEPT state

Large result:

```text
ACCEPT
```

Plain language:

> The mint's receipt verifies, this issuance is present in the promised liability epoch, the published evidence is fresh, and verified reserves cover committed liabilities.

Do not say “safe.” The mint remains a custodian.

### Hero REFUSE state

Large result:

```text
REFUSE
```

Plain language:

> This mint signed a promise to account for this liability in epoch 12, but its signed epoch-12 accounting omits it.

### Short-reserve REFUSE

> Verified reserves do not cover the mint's committed outstanding liabilities.

### Unsupported state

> This ecash does not include the NUT-12 data SOLVENT needs for independent holder verification. It has not been accepted.

---

## 17.4 Progressive disclosure

Default result shows only:

- decision;
- reason;
- mint;
- amount;
- evidence freshness;
- reserve coverage summary.

Evidence drawer may show:

- reconstructed `B'`;
- reconstructed `C'`;
- DLEQ status;
- receipt signature;
- target epoch;
- issued MMR proof;
- issued/spent root sums;
- manifest digest/signature;
- reserve outpoints/network;
- reserve proof/signatures;
- Nostr event ids/relays;
- reason code;
- downloadable evidence bundle.

Do not make a normal user read hashes to understand the result.

---

## 17.5 Visual implementation rules

- mobile-first CSS/layout from first UI commit;
- semantic HTML and keyboard accessibility;
- visible focus states;
- adequate contrast;
- concise status copy;
- skeleton/loading states where network work occurs;
- explicit stale/unavailable/error states;
- never rely on color alone for ACCEPT/REFUSE;
- use icon components from the selected icon library;
- **never use literal emoji as product UI icons**;
- no fake terminal aesthetic as a substitute for usable product design;
- evidence views may be technical, but primary interaction must remain plain-language.

---

# 18. Repo layout

Target structure; agent may make minor naming changes but not merge away the conceptual boundaries.

```text
solvent/
  README.md
  LICENSE
  package.json
  DECISIONS.md
  PROTOCOL.md
  ATTACKS.md
  VERIFY_IN_5_MINUTES.md

  docs/
    draft-alignment.md
    trust-boundaries.md
    reserve-attestation.md
    nostr-schema.md
    ui-states.md

  src/
    cashu/
      parse.ts
      dleq.ts
      reconstruct.ts
      keys.ts
      gate0.ts

    pol/
      receipt.ts
      mmr.ts
      issued.ts
      spent.ts
      manifest.ts
      inclusion.ts
      fraud.ts

    reserve/
      statement.ts
      sign.ts
      verify.ts
      network.ts

    nostr/
      schema.ts
      publish.ts
      fetch.ts
      conflicts.ts

    verifier/
      verify.ts
      reasons.ts
      types.ts

    enforcement/
      accept-gate.ts

    cli/
      verify.ts
      verify-submission.ts
      generate-evidence.ts

    web/
      landing/
      verifier/
      components/
      evidence/

  fixtures/
    captured/
    attacks/

  evidence/
    gate-0/
    hero/
    reserves/
    nostr/
    attacks/
    live/

  tests/
    cashu/
    pol/
    reserve/
    nostr/
    verifier/
    enforcement/
    ui/
```

Do not add a database unless a gate proves one is necessary.

---

# 19. Technical stack

Prefer one language/toolchain unless a verified dependency forces otherwise.

Default:

- TypeScript;
- Node.js 20+;
- React + Vite or equivalent small web stack;
- current compatible `@cashu/cashu-ts` for Cashu primitives/path discovery;
- `nostr-tools` or current maintained equivalent;
- noble secp256k1/hash primitives where the Cashu library does not expose required operations;
- Vitest or Node test runner;
- Playwright for responsive/end-to-end web checks;
- Bitcoin signet/testnet RPC or a public explorer/API only if evidence is independently reproducible and rate-limit-safe.

Rules:

- pin exact dependency versions once Gate 0 passes;
- record the version/commit of PR #388 used for semantic alignment;
- do not copy draft code without understanding/licence attribution;
- do not invent library API names in docs before the agent confirms them.

---

# 20. Build gates

The gates are the build order. Do not jump ahead because a later screen is easier.

## Gate 0 — NUT-12 transfer invariant

**Goal:** Prove a transferred real Cashu proof reaches the receiver with usable `e,s,r` and reconstructs the original `B'`.

Pass:

```text
original_B' == reconstructed_B'
DLEQ == valid
real serialized received proof contains r
```

Artifact: `evidence/gate-0/`.

Failure: stop mechanism work and resolve. No opaque-ID fallback.

---

## Gate 1 — real issuance + signed PoL receipt

**Goal:** Produce real Cashu issuance artifacts and a draft-PR-#388-shaped signed receipt binding exact `B'` to a target epoch.

Pass:

- signature verifies against correct key;
- bit flip in `B'`, amount context or epoch makes it fail;
- evidence saved.

---

## Gate 2 — issued/spent sum-MMR + signed epoch

**Goal:** Close one real deterministic epoch.

Pass:

- real issued records appended;
- real spent records appended where used;
- sums correct;
- inclusion proof verifies;
- manifest signature verifies;
- liabilities equation recomputes independently.

---

## Gate 3 — hero contradiction

**Goal:** Mint signs an issuance receipt but target epoch omits that issuance.

Pass:

- holder reconstructs exact `B'`;
- receipt verifies;
- epoch verifies;
- omission is demonstrated without trusting a mint-supplied identifier;
- verifier returns stable `REFUSE_ISSUANCE_OMITTED`;
- evidence bundle reproduces.

This is the most important gate after Gate 0.

---

## Gate 4 — enforced accept/refuse

**Goal:** Decision changes a real acceptance side effect.

Pass:

- GREEN invokes actual acceptance/import/claim function once;
- RED invokes it zero times;
- automated test proves both.

---

## Gate 5 — Nostr public evidence

**Goal:** Publish and independently retrieve the state/evidence.

Pass:

- publish to two public relays;
- event signatures verify;
- one relay can fail without losing valid evidence;
- stale/conflicting state produces fail-closed behavior;
- event ids captured under `evidence/nostr/`.

---

## Gate 6 — real signet/testnet reserve attestation

**Goal:** Remove `demo-reserve` from the hero path.

Pass:

- real UTXO(s) exist;
- ownership/control proof verifies;
- mint-to-reserve identity binding verifies;
- verifier independently checks unspent status/value;
- reserve amount recomputes;
- short-reserve fixture returns REFUSE;
- network labelled correctly everywhere.

Do not escalate to mainnet merely for optics.

---

## Gate 7 — attack battery + evidence harvesting

**Goal:** Run A01–A24 and produce reproducible artifacts.

Pass:

- all expected outcomes match;
- no attack is represented only by prose;
- `npm run verify:submission` verifies core evidence.

---

## Gate 8 — mobile accept gate

**Goal:** Product flow usable on phone before desktop polish.

Pass at 390×844:

- paste/scan input usable;
- CTA visible;
- ACCEPT/REFUSE unambiguous;
- reason readable;
- evidence drawer usable;
- no horizontal scroll;
- loading/error/stale/unsupported states work;
- keyboard and basic accessibility pass.

---

## Gate 9 — landing page + responsive QA

**Goal:** Judge understands product before running it.

Pass:

- hero explains mechanism in one screen;
- CTA enters verifier;
- mobile/tablet/desktop screenshots captured;
- no literal emoji UI icons;
- no unsupported claims;
- trust limits visible.

---

## Gate 10 — submission freeze

**Goal:** Turn working system into a verifiable submission.

Required:

- public repo;
- clean install;
- README;
- 3–5 minute demo video linked near top;
- design decisions/trade-offs write-up;
- weekly progress logs up to date;
- `VERIFY_IN_5_MINUTES.md`;
- evidence folder committed;
- known limitations explicit;
- no new mechanism after freeze.

---

# 21. Demo script

Target: **3–5 minutes**, understandable without prior Cashu knowledge.

## 0:00–0:20 — problem

> Ecash mints are custodians. A mint can publish a healthy-looking liability number while quietly leaving a real issuance out. SOLVENT lets the ecash in your hand challenge the mint's own signed accounting before your wallet accepts it.

Do not begin with MMRs, DLEQ or NUT numbers.

## 0:20–0:45 — the mint promise

Show a real issued proof and the signed receipt:

```text
amount: 1,000 sats
target epoch: 12
receipt: valid
```

Say:

> The mint cryptographically promised that this issuance belongs in epoch 12.

## 0:45–1:10 — independent holder reconstruction

Show received ecash.

Click **Check before accepting**.

Evidence step visibly shows:

```text
NUT-12 proof: valid
B' reconstructed from received ecash: PASS
```

Say:

> The receiver doesn't trust an ID from the mint. The token itself lets SOLVENT reconstruct the exact blinded issuance the mint signed.

## 1:10–1:45 — hero contradiction

Show epoch 12 signed state.

Then:

```text
Receipt promise: VALID
Epoch signature: VALID
Promised issuance in epoch: MISSING
```

Large UI:

```text
REFUSE
```

Reason displayed in plain language.

This is the winning screenshot.

## 1:45–2:15 — contrast with honest case

Run honest token:

```text
receipt valid
issuance included
liability math valid
reserve covered
state fresh
```

Result:

```text
ACCEPT
```

Actual acceptance side effect executes.

## 2:15–2:40 — real reserves

Show:

- Bitcoin Signet label;
- real reserve outpoint(s);
- independent unspent/value verification;
- coverage result.

Then show short-reserve case returning REFUSE.

## 2:40–3:10 — Nostr

Show signed evidence event ids on two relays.

Briefly demonstrate one-relay failure or show captured automated evidence.

## 3:10–3:35 — attacks

Show compact attack results:

```text
forged receipt       BLOCKED
invalid DLEQ         BLOCKED
manifest conflict    BLOCKED
stale evidence       BLOCKED
spent reserve UTXO   BLOCKED
```

## 3:35–4:00 — honest boundary

Say clearly:

> Phase 1 supports the secp256k1 NUT-12 path and proves reserves against Bitcoin Signet, not mainnet. Cashu PR #388 is still a draft; SOLVENT implements the documented slice used by this verifier rather than claiming final-NUT compatibility.

End on:

> The mint made the promise. The holder checked it. The contradiction blocked the money.

---

# 22. Winning screenshot specification

One mobile-sized frame should make the project understandable without narration.

Required visible content:

```text
REFUSE

Mint promise            ✓ Valid
Promised epoch           12
Holder reconstructed B'  ✓ Match
Epoch 12 signature       ✓ Valid
Issuance in epoch         ✕ Missing
Reserve coverage          ✓ 1.14×

This mint promised to account for this liability in epoch 12,
but its signed epoch-12 accounting omits it.

[ View evidence ]
```

Use icons/components rather than literal checkmark/cross emoji in the actual UI. The symbols above are only specification shorthand.

---

# 23. README order

The README is a judging surface, not just installation notes.

Required order:

1. one-line outcome;
2. demo video;
3. winning screenshot;
4. 30-second mechanism;
5. what is genuinely working;
6. verify in five minutes;
7. hero evidence ids/artifacts;
8. architecture diagram;
9. Cashu PR #388 draft-alignment statement;
10. reserve-attestation design and Signet disclosure;
11. Nostr evidence schema;
12. attack matrix;
13. mobile screenshots;
14. trust assumptions / known limits;
15. setup/run instructions;
16. repo structure;
17. next work.

Lead with the mechanism and evidence, not a dependency list.

---

# 24. Trust assumptions and honest limits

These must appear in both README and UI where relevant.

- Cashu mint remains a custodian. SOLVENT does not make ecash non-custodial.
- Phase 1 supports the secp256k1 NUT-12 path where the received proof includes usable DLEQ data including `r`.
- A token without the required NUT-12 data is unsupported/refused; SOLVENT does not silently trust a mint-supplied identifier.
- Cashu PR #388 is a draft proposal, not a finalized assigned NUT.
- SOLVENT implements/aligned-to a bounded slice of the draft. Divergences must be documented.
- The hero omission proof shows that a specific signed issuance promise was not honored. It does not magically prove every mint liability in existence is complete.
- Phase-1 reserve evidence is against Bitcoin Signet/testnet unless explicitly upgraded. It is not mainnet PoR.
- Phase 1 may prove on-chain reserve UTXOs without proving every private Lightning channel balance.
- Nostr relays can drop events. SOLVENT uses multiple relays and fails closed when required state cannot be verified.
- A proof of current UTXO control/state becomes stale; freshness and re-query rules are required.
- ACCEPT means the configured checks passed. It does not mean the mint can never fail later.

---

# 25. Non-goals / hard cuts

Do not build these before submission unless all gates are already complete:

- full Cashu wallet;
- Fedimint;
- AI assistant;
- mint marketplace;
- generic reputation score;
- mainnet requirement;
- production Lightning mint deployment;
- complete Cashu PR #388 implementation;
- bonded/slashable PoL;
- BLS/v3 Cashu hero path;
- multi-currency support;
- social feed;
- dashboard maze;
- chain analytics unrelated to reserve verification;
- another protocol mechanism.

---

# 26. Risks and moves

| Risk | Required move |
| --- | --- |
| actual transfer path does not preserve `r` | Gate 0 stops project until resolved; no fake ID fallback |
| cashu-ts API/version differs from assumptions | inspect actual source/API, pin version in DECISIONS.md |
| PR #388 changes during build | pin commit/date used for alignment; do not chase every new commit after mechanism freeze |
| MMR implementation eats schedule | implement only issued/spent operations required by hero + liability sum; test vectors first |
| reserve PoR becomes second project | use real bounded Signet/testnet UTXO attestation; do not chase mainnet/Lightning breadth |
| public relay unreliable | two relays + captured event ids + local evidence replay |
| judge mistakes Signet for mainnet | network label on every reserve surface |
| judge thinks draft is finalized standard | say “Cashu PR #388 / draft PoL proposal” everywhere |
| unsupported token gets accepted | fail closed on missing DLEQ/`r` |
| UI becomes crypto console | progressive disclosure; decision/reason first |
| mobile left until final day | Gate 8 before landing-page polish |
| evidence exists only as screenshots | machine-readable evidence + verifier command |
| scope creep | every addition must strengthen the locked chain |

---

# 27. Mapping to BOSS judging

## Innovation

Not “we made a mint dashboard.”

Distinctive angle:

> A transferred ecash proof independently reconstructs the exact issuance the mint promised to account for; contradictory signed accounting becomes actionable wallet refusal.

## Completeness

One end-to-end path must be fully real:

```text
issue → receipt → transfer → reconstruct → epoch → reserve → Nostr → decision → enforced accept/refuse
```

## Use Case

A receiver needs a decision **before accepting custodial ecash**, not after withdrawals fail.

## Application Scope

The verifier rule must be separable from the demo UI so another Cashu wallet can integrate it later.

## UI / UX

Mobile-first accept gate. Technical detail behind progressive disclosure. Clear stale/unsupported/refuse states.

## Presentation & Demo

Judge sees one contradiction in seconds and can reproduce it from public evidence in under five minutes.

---

# 28. Definition of done

SOLVENT is submission-ready only when all statements below are true.

### Cryptographic spine

- [ ] Gate 0 passes on a real library-produced transferred proof.
- [ ] Receiver reconstructs exact original `B'` from received NUT-12 proof.
- [ ] DLEQ verifies against the correct keyset/amount key.
- [ ] Signed issued PoL receipt commits exact `B'` to a target epoch.
- [ ] Receipt mutation fails verification.
- [ ] Issued/spent sum-MMR roots and sums are real code, not screenshots.
- [ ] Signed epoch manifest verifies.
- [ ] Liability equation recomputes.
- [ ] Honest issuance inclusion verifies.
- [ ] Hero promised issuance omission returns stable REFUSE reason.

### Reserves

- [ ] Real Signet/testnet UTXO(s) exist.
- [ ] Control/ownership proof verifies.
- [ ] Mint-reserve binding verifies.
- [ ] Verifier independently confirms unspent/value state.
- [ ] Reserve total recomputes.
- [ ] Short-reserve case returns REFUSE.
- [ ] Network is labelled correctly everywhere.

### Nostr

- [ ] Real signed event published to two public relays.
- [ ] Event fetched back independently.
- [ ] One-relay failure path tested.
- [ ] stale event tested.
- [ ] conflicting state tested.
- [ ] event/proof-bundle digest mismatch tested.

### Enforcement

- [ ] ACCEPT executes one real acceptance/import/claim side effect.
- [ ] REFUSE executes zero such side effects.
- [ ] automated test proves both.

### Attack depth

- [ ] A01–A24 implemented or explicitly marked N/A with justification.
- [ ] every implemented attack emits machine-readable evidence.
- [ ] no known failing security test hidden from README.

### UX

- [ ] landing page exists.
- [ ] primary verifier flow works at 390×844.
- [ ] works at tablet and desktop targets.
- [ ] no horizontal scrolling.
- [ ] ACCEPT/REFUSE does not rely on color alone.
- [ ] evidence is progressively disclosed.
- [ ] no literal emoji used as interface icons.
- [ ] loading, stale, relay-down, invalid, unsupported and conflict states are designed.

### Submission

- [ ] public repo current through build window.
- [ ] MIT licence.
- [ ] clean `npm ci` / documented install.
- [ ] `npm run verify:submission` works.
- [ ] `VERIFY_IN_5_MINUTES.md` works.
- [ ] README has demo near top.
- [ ] 3–5 minute demo recorded before final night.
- [ ] design trade-offs documented.
- [ ] weekly progress logs current.
- [ ] every public claim maps to evidence or an explicit limitation.

---

# 29. Technical basis / source pinning

The implementation agent must pin and record the exact versions/commits used.

Primary references at PRD lock time:

1. **BOSS Battle 2026 Participant Handbook** — Freedom Stack / Auditable Ecash problem and judging requirements.
2. **Cashu NUT-12: Offline ecash signature validation** — user-to-user proof includes DLEQ `e`, `s`, and sender blinding factor `r`; receiver reconstructs `B'` and `C'`.
   - https://github.com/cashubtc/nuts/blob/main/12.md
3. **Cashu PR #388: NUT-XX Proof of Liabilities (draft)** — epoch-based issued/spent sum-MMRs, signed manifests, transactional PoL receipts and fraud challenges.
   - https://github.com/cashubtc/nuts/pull/388
4. **PR #388 draft `pol.md` branch** — exact draft semantics used for alignment.
   - https://github.com/a1denvalu3/nuts/blob/pol-spec/pol.md
5. **BIP-322 Generic Signed Message Format** — reference option for Bitcoin reserve control/proof-of-funds evidence.
   - https://github.com/bitcoin/bips/blob/master/bip-0322.mediawiki

## Source naming rule

Public docs must say:

```text
Cashu PR #388 / draft Proof-of-Liabilities proposal
```

Do not present it as an assigned finalized NUT unless its status actually changes and the repo is deliberately updated.

---

# 30. Final mechanism lock

Do not reopen the product concept unless **Gate 0 or another cryptographic invariant falsifies it**.

The build is:

> **Mint promises → holder independently reconstructs → signed accounting contradicts the promise → public evidence proves the contradiction → wallet refuses the ecash.**

Deepen that line.

Do not dilute it.
