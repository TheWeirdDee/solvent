# SOLVENT — Product Requirements

**BOSS Battle 2026**  
**Track:** Freedom Stack (Nostr + Ecash)  
**Official board problem:** Auditable Ecash — mint proof-of-reserves and proof-of-liabilities  
**Product object:** solvency protocol plus a thin accept-gate client  
**Licence:** MIT  
**Window:** ship a working Phase 1 by 28 Sep, feature freeze 03 Oct, submit 05 Oct 23:59 IST

This file tells you what to build. `SOLVENT-HANDOFF.md` tells you how to enter and submit.

## 1. One sentence

Before a wallet accepts Cashu ecash, SOLVENT verifies that the token really came from the mint, checks that the token's mint issuance is included in the mint's published liabilities commitment, then checks a fresh signed Nostr solvency event before returning GREEN or RED.

## 2. Why this product exists

Cashu and Fedimint mints are custodial. Outstanding ecash is an IOU against the mint's Lightning or on-chain balance. Users have no simple cryptographic view of whether the mint has issued more ecash than its reserves can cover.

A mint can become insolvent slowly by issuing more claims than it can redeem. Users may only discover this when withdrawals fail.

SOLVENT does not make the mint non-custodial. It makes part of that custodial risk visible at the moment a wallet would accept ecash.

This is an official Freedom Stack problem statement. Own ideas are allowed; this one is directly on the board.

## 3. Track fit

Theme: Nostr + Ecash. Identity, communication, auditable money. Make trust assumptions visible, or remove them.

SOLVENT uses:

- Cashu mint proofs: issued blind signatures (`C'` / `C_prime`)
- Cashu burn records: redeemed/spent token records
- NUT-12 DLEQ data so a holder can verify mint origin and reconstruct the original blinded signature
- a mint signing key
- Nostr as the publication layer for solvency state
- a wallet-side verifier as the accept gate

Out of this track:

- Bitcoin privacy scanners (Cypherpunk)
- AI agents, sat-metered inference, educational chatbots (Machine Money)
- PeerTube incentive layers and Lightning swap-making (other Freedom Stack board items)

Do not dual-track. A Lightning fixture used only as a reserve attestation does not make this a Machine Money entry.

## 4. Product object test

The product is the solvency protocol:

- mint-proof commitment
- burn-proof commitment
- outstanding-liability calculation
- reserve attestation
- signed Nostr solvency event
- holder-side NUT-12 / DLEQ verification
- inclusion proof for the token's actual mint issuance
- verify-before-accept rule

The web page is a client of that protocol. It is not the product.

If another wallet can fetch the same event, verify the same commitments, and implement the same GREEN/RED rule, the product still exists.

Do not disguise this as "a Nostr app" or "a Cashu wallet."

## 5. Actors

| Role | Who | Notes |
| --- | --- | --- |
| Flow originator | Mint operator | Publishes proofs and solvency state |
| Beneficiary | Wallet user about to accept ecash | First customer of the verifier |
| Installer | You, then later a real wallet | Phase 1 installer is the demo client |
| Operator | Mint process | Can be a stub/fixture mint you control |
| Payer | Nobody in Phase 1 | No protocol fee |
| Distribution owner | Cashu wallets, if they integrate later | Do not wait on them |
| Counterparty | The mint as custodian | Still trusted for redemption |

The person clicking the demo is not automatically a mint operator. Demo both roles.

## 6. Value return

User puts in:

- a mint public key / mint identity
- a Cashu proof carrying NUT-12 DLEQ data
- attention for one check

SOLVENT derives or verifies:

- the token's keyset and amount
- the mint's signature on the token
- the original blinded signature `C'` (`C_prime`) from the token's DLEQ data
- the holder-verifiable mint-proof identifier used in the commitment

User gets back:

- a go / no-go
- whether this real mint issuance is in the published mint-proof commitment
- the signed Nostr solvency event
- minted total, burned total, outstanding liabilities, reserve figure, ratio, and freshness

A ratio-only dashboard is not enough. A mint can omit issued liabilities and still show a healthy ratio. The holder-side inclusion check is the thing the user can actually use.

## 7. Success for this hackathon

A judge who has never seen the repo can:

1. run the publisher against mint A (solvent fixture)
2. run the publisher against mint B (short fixture)
3. open the verifier
4. give it a real Cashu-shaped proof with NUT-12 DLEQ data from mint A and see GREEN
5. give it a valid proof whose issuance was deliberately omitted from mint A's published mint-proof commitment and see RED
6. give it a valid included proof from mint B and see RED because reserves are short
7. expand the event and understand exactly why each result happened

The omitted-issuance RED case is the hero demo beat.

If that path does not work, the project is not complete, no matter how good the write-up is.

## 8. Non-goals

- Not a Cashu wallet
- Not a Nutshell fork in Phase 1
- Not Fedimint
- Not live Lightning channels as a blocker
- Not nutzap send/claim/reclaim as the headline
- Not a marketplace of mints
- Not an AI layer
- Not a social client
- Not a claim of perfect proof-of-liabilities completeness
- Not full fake-burn detection in Phase 1

## 9. Trust assumptions and honest limits

Print these in the README.

- The mint remains a custodian. SOLVENT does not change that.
- NUT-12 is optional in Cashu. Phase 1 holder verification requires a proof carrying usable DLEQ data. No usable DLEQ data means SOLVENT cannot independently tie the received proof to the original mint issuance; treat that as unsupported / RED in the demo client.
- Phase 1 reserves may be a signed fixture labelled `demo-reserve`. That is not live proof-of-reserves.
- Phase 1 uses a controlled fixture/stub mint for issuance and burn records, but the DLEQ verification, Merkle-sum verification, Nostr signature verification, and accept/reject rule must be real code.
- A holder inclusion check proves that this checked issuance was or was not in the published commitment. It does not prove that every issuance in existence was included.
- The mint can also try to manipulate liabilities by inflating burn reports. Full epoch-based fake-burn detection and user challenges are later work.
- Relays can drop or delay events. Missing or stale events are RED.
- The verifier trusts the mint's published key binding. Key substitution is out of scope for Phase 1.
- Individual token owners must not be published. The commitment is over cryptographic issuance/burn records, not an owner balance list.

## 10. Mechanism

### 10.1 Cashu liability accounting

Do **not** model the mint as having a neat list of final wallet tokens. Cashu uses blind signatures: the mint signs a blinded message and the wallet later unblinds it into the spendable proof.

SOLVENT follows the Cashu proof-of-liabilities shape instead:

```text
outstanding liabilities = issued ecash - burned/redeemed ecash
```

For each keyset/epoch, the mint maintains two auditable record sets:

1. **Mint proofs** — issued blind signatures (`C'` / `C_prime`)
2. **Burn proofs** — records of ecash that came back to the mint and was redeemed/spent

Phase 1 commits to both sets with Merkle-sum trees.

#### Mint-proof leaf

A mint-proof leaf must be tied to the actual blind signature, not an opaque mint-assigned token ID.

Canonical Phase 1 leaf data:

```text
kind       = "mint"
keyset_id  = Cashu keyset id
amount     = integer sats
C_prime    = original Cashu BlindSignature point C'
```

Leaf commitment:

```text
leaf_hash = SHA256("mint" || keyset_id || amount || C_prime)
leaf_sum  = amount
```

The exact byte encoding must be documented and deterministic. Never hash ambiguous string concatenations without length-prefixing or a canonical encoding.

Why `C_prime` matters: with NUT-12 DLEQ data, a receiving holder can verify the mint's signature and reconstruct the original blinded signature from the received Cashu proof. That lets the holder derive the same value the mint should have committed.

#### Burn-proof leaf

Phase 1 burn records are produced by the controlled fixture mint from proofs it has actually accepted as spent.

Use a deterministic record such as:

```text
kind        = "burn"
keyset_id   = Cashu keyset id
amount      = integer sats
secret_hash = SHA256(secret)
```

Leaf commitment:

```text
leaf_hash = SHA256("burn" || keyset_id || amount || secret_hash)
leaf_sum  = amount
```

Do not claim that this Phase 1 burn commitment by itself solves fake-burn fraud globally. Full fake-burn contestability needs the broader epoch/user-checking scheme and is later work.

#### Tree

Use two Merkle-sum trees:

- `mint_root` — commits to issued blind signatures; root sum = total issued in the report
- `burn_root` — commits to burn records; root sum = total burned/redeemed in the report

Then:

```text
liabilities_sats = mint_root.sum_sats - burn_root.sum_sats
```

`burn_root.sum_sats` must never exceed `mint_root.sum_sats` for the same reporting scope.

Published proof bundle contains:

- mint root hash + sum
- burn root hash + sum
- inclusion path for the presented mint proof
- reporting keyset/epoch metadata
- canonical leaf encoding specification

The raw owner list does not exist and must not be invented.

If Merkle-sum slips the calendar, a documented accumulator/hash commitment is acceptable only if the holder can still verify inclusion and the totals are bound to the commitment. A screenshot of numbers is not proof.

### 10.1.1 Completeness hole — do not hide this

A Merkle-sum proves the committed set adds up. It does not prove the mint included every issuance.

Example:

```text
real issued liabilities: 120k
reported mint proofs:      70k
reserves:                  80k
```

The mint can look healthy if it omits 50k of issued ecash.

Nostr proves who signed the report and that the event bytes were not altered. It does not prove the mint told the whole truth.

**Phase 1 mitigation: holder-side mint-proof inclusion check.**

The holder presents a Cashu proof with NUT-12 DLEQ data. SOLVENT:

1. verifies the DLEQ proof against the mint/keyset public key
2. reconstructs the original `B'` and `C'`
3. derives the canonical mint-proof leaf from `keyset_id + amount + C'`
4. verifies the Merkle-sum inclusion path into `mint_root`
5. returns RED if the issuance is missing, even when the reported ratio looks healthy

This catches an omitted liability when a holder of that issuance checks it.

**Later:** keyset epochs, report finalization, wider client vigilance, burn challenges, and stronger mint-side/accounting constraints.

Do not claim full completeness in the README or demo.

### 10.1.2 NUT-12 requirement for the accept gate

NUT-12 allows a receiver to validate the mint's signature offline with a DLEQ proof. A received proof can carry `e`, `s`, and the blinding factor `r`; using `r`, the receiver can reconstruct the original blinded message and blind signature.

For Phase 1:

- token with valid NUT-12 data → continue
- token with invalid NUT-12 data → RED
- token without the required DLEQ data → unsupported / RED in the demo client

Do not silently fall back to trusting an opaque ID supplied by the mint.

### 10.2 Reserves (PoR)

Preferred later target: an attestation that binds on-chain UTXOs or other auditable reserves to the mint identity.

Phase 1 fallback, required to be labelled:

```text
reserve_kind = demo-reserve
```

The amount is signed/published as part of the mint's solvency event.

README must say clearly:

> Phase 1 uses a demo reserve fixture. It is not live proof-of-reserves.

Never present the fallback as a chain proof.

### 10.3 Solvency event (Nostr)

Publish a signed event the verifier can fetch.

Required content shape:

```json
{
  "schema": "solvent/v1",
  "mint_pubkey": "<hex>",
  "keyset_id": "<cashu-keyset-id>",
  "epoch": 1,
  "mint_root": {
    "hash": "<hex>",
    "sum_sats": 0
  },
  "burn_root": {
    "hash": "<hex>",
    "sum_sats": 0
  },
  "liabilities_sats": 0,
  "reserve_sats": 0,
  "reserve_kind": "demo-reserve",
  "ratio": 0,
  "issued_at": 0,
  "valid_until": 0,
  "proof_uri": "https://...",
  "notes": "Phase 1 fixture mint"
}
```

Rules:

- event is signed by the mint's Nostr signing key / documented identity key
- use a documented replaceable kind in the 30000s so clients can take the latest state
- put the exact kind number and schema in the README
- publish to at least two public relays for the demo
- `liabilities_sats = mint_root.sum_sats - burn_root.sum_sats`
- `burn_root.sum_sats <= mint_root.sum_sats`
- `ratio = reserve_sats / liabilities_sats`
- if liabilities are 0, define and test the behaviour explicitly
- `valid_until` is required; stale events are RED
- the proof bundle referenced by `proof_uri` must use the same roots as the signed event

### 10.4 Verifier rule

GREEN only if all required checks pass:

1. Nostr event signature is valid for the documented mint identity
2. event is not past `valid_until`
3. event is the latest accepted replaceable event for that mint/reporting scope
4. proof bundle roots match the roots signed in the event
5. `liabilities_sats = mint_root.sum_sats - burn_root.sum_sats`
6. burn sum does not exceed mint sum
7. `reserve_sats >= liabilities_sats`
8. presented Cashu proof contains the Phase 1-required NUT-12 DLEQ data
9. DLEQ verification succeeds against the correct Cashu keyset public key for the proof amount
10. verifier reconstructs `C'` from the real Cashu proof rather than trusting an opaque mint-supplied ID
11. derived mint-proof leaf has a valid Merkle-sum inclusion path to `mint_root`
12. committed leaf amount matches the Cashu proof amount

Anything else is RED or explicitly unsupported. The demo client must fail closed.

Defined behaviour:

- solvent mint + valid DLEQ + issuance in mint tree → GREEN, Accept enabled
- short mint + valid included issuance → RED
- valid mint-issued token omitted from a "healthy" report → RED; this is the hero demo beat
- invalid DLEQ → RED
- required DLEQ missing → unsupported / RED
- stale event → RED
- missing event → RED
- bad Nostr signature → RED
- commitment/event mismatch → RED

Phase 1 does not need a real token swap. Enable or disable an **Accept** button. Say so in the UI and README.

## 11. Interface

One page. One flow.

Screen:

- input: mint identity / mint pubkey
- input: encoded Cashu token or fixture Cashu proof
- button: **Check before accepting**
- status: **GREEN** or **RED**, large
- line: mint signature / DLEQ: `valid` or `invalid`
- line: issuance commitment: `included` or `missing`
- line: `issued - burned = liabilities`
- line: `reserve / liabilities = ratio`
- line: freshness (`valid_until`)
- line: `reserve_kind`
- expandable: raw Nostr event, reconstructed `C'`, leaf hash, Merkle path, roots, relay used

Copy for omitted issuance:

> This mint issued this ecash but did not include the issuance in its published liabilities. Do not accept.

Copy for short mint:

> Reserve does not cover the mint's committed outstanding liabilities. Do not accept.

Copy for GREEN:

> This ecash verifies as mint-issued, its issuance is included in the published commitment, and reported reserve covers the committed outstanding liabilities. The mint is still a custodian, and full completeness of all liabilities is not proven.

No feed. No profile. No dashboard maze.

Freedom Stack judging weights UI/UX heavily. Make this one flow pleasant: high contrast, immediate result, plain-language explanation.

## 12. Tech stack (Phase 1)

Keep it boring. You just started. This stack is enough.

- Language: TypeScript
- Runtime: Node.js 20+
- Verifier UI: Vite + vanilla TS or React
- Cashu parsing / primitives: `@cashu/cashu-ts` where it gives us correct current Cashu types/verification; do not rewrite standard Cashu parsing just for novelty
- Nostr: `nostr-tools`
- Hashing: `@noble/hashes` (SHA-256)
- secp256k1 helpers: use Cashu library helpers where exposed; otherwise `@noble/curves`
- Merkle-sum: write the small commitment layer in `src/proof/` so we can explain and test it
- Publisher: Node CLI `npm run publish -- --mint ./fixtures/mint-a.json`
- Verifier: static page `npm run dev`
- Fixtures: JSON in `fixtures/`
- Tests: Vitest or Node test runner
- Hosting: local is enough; optional static deployment later

Do not add:

- Python plus TS unless required
- Docker-compose of Bitcoin Core + LND
- a database
- an indexer
- an agent SDK
- a full Cashu wallet

## 13. Repo layout

```text
solvent/
  README.md
  LICENSE
  package.json
  fixtures/
    mint-a.solvent.json
    mint-a.omitted.json
    mint-b.short.json
    tokens/
      t1.valid.json
      t-hidden.valid.json
  docs/
    trust-assumptions.md
    event-schema.md
    design-writeup.md
  src/
    cashu/
      token.ts
      dleq.ts
      identifier.ts
    mint/
      load.ts
      reports.ts
    proof/
      merkle-sum.ts
      merkle-sum.test.ts
      mint-leaf.ts
      burn-leaf.ts
    nostr/
      event.ts
      publish.ts
    verifier/
      rules.ts
      rules.test.ts
    app/
      main.ts
```

## 14. Phases

### Phase 1 — this week, required

- two fixture mints plus omitted-liability variant
- real Cashu-shaped proof fixture carrying NUT-12 DLEQ data
- real DLEQ verification
- reconstruct `C'` from the presented proof
- mint-proof Merkle-sum commitment keyed on `keyset_id + amount + C'`
- burn-proof Merkle-sum commitment for fixture spend records
- signed solvency event on two public Nostr relays
- verifier GREEN / RED including omitted-issuance case
- README run steps
- trust assumptions and completeness/fake-burn limits written down

Done when a stranger follows the README and sees:

1. GREEN on mint A + valid token + issuance in mint tree
2. RED on mint A + valid token whose issuance was omitted
3. RED on mint B + valid included token + insufficient reserve

### Phase 2 — next week, only if Phase 1 is done

- stale event fixture
- invalid DLEQ fixture
- invalid Nostr signature fixture
- proof bundle download
- better visual design
- event schema doc another wallet could implement
- keyset/epoch handling beyond one active demo epoch
- burn-report challenge notes / prototype if time allows

### Phase 3 — 03–05 Oct

- feature freeze
- demo video 3–5 min
- design write-up
- clean-machine test
- Devfolio card updated
- stop coding

### Explicitly later, not this hackathon

- Nutshell plugin that exports live mint/burn reports
- live on-chain PoR
- full fake-burn challenge protocol across epochs
- wallet integrations (Cashu.me, Minibits)
- nutzap accept-gate on top of solvency
- Fedimint

## 15. Demo script

Length: 3–5 minutes. Record before 05 Oct. Link it at the top of the README.

1. State the problem in 20 seconds: a Cashu mint can be custodial and a pretty reserve ratio is meaningless if it quietly leaves liabilities out.
2. Show mint A fixture publishing a real signed Nostr solvency event. Show the event ID on a public relay.
3. Open the verifier and give it token T1.
4. Show that SOLVENT verifies NUT-12/DLEQ, reconstructs `C'`, proves the issuance is in `mint_root`, checks reserve coverage, then returns GREEN.
5. Use the same mint A but token `T_hidden`, whose valid issuance was deliberately omitted from the mint report.
6. Show: DLEQ valid, mint origin valid, but mint-proof inclusion fails → RED. Read the omitted-liability copy out loud. **This is the beat.**
7. Show mint B: token is valid and included, but reserve is below liabilities → RED.
8. Expand the raw event and point at `mint_root`, `burn_root`, outstanding liabilities, reserve, ratio, `valid_until`, reconstructed `C'`, and inclusion path.
9. Say the limitations plainly: the mint is still a custodian; reserve is a fixture in Phase 1; one holder inclusion check does not prove every issuance was reported; full fake-burn detection is later work.
10. Stop. Do not tour the codebase.

## 16. README requirements

Judges often read only this.

Include:

- team names
- problem
- one-sentence approach
- what is genuinely working
- what is unfinished
- setup on a clean machine
- happy-path commands
- demo video at the top
- Nostr event kind + schema
- canonical mint/burn leaf encoding
- NUT-12 requirement
- trust assumptions
- completeness limitation
- fake-burn limitation
- `demo-reserve` warning

Write it as if the reader has never seen the project.

## 17. Design write-up

Cover:

- why Cashu liabilities are modeled as issued mint proofs minus burn proofs
- why the mint-proof leaf is tied to `C'` rather than an opaque ID
- how NUT-12 lets the receiver validate origin and reconstruct `C'`
- why Merkle-sum
- why Nostr instead of mint HTTP only
- why RED on missing/stale/invalid rather than yellow
- why a stub mint instead of a Nutshell patch
- why Phase 1 does not claim full liability completeness
- why fake-burn resistance is not fully solved in Phase 1
- what you would do after 05 Oct

Honest scope reads as maturity.

## 18. Test cases you must have

- mint A solvent + valid DLEQ + issuance in mint tree → GREEN
- mint A + valid DLEQ + omitted issuance → RED
- mint B short + valid included issuance → RED
- modified DLEQ → RED
- token amount does not match committed mint-proof leaf → RED
- reconstructed `C'` differs from committed leaf → RED
- invalid Merkle path → RED
- proof bundle root differs from Nostr event root → RED
- flipped Nostr signature → RED
- expired `valid_until` → RED
- empty relay response → RED
- burn sum greater than mint sum → RED
- wrong liability arithmetic → RED
- liabilities 0 → documented behaviour with a test

## 19. Risks

| Risk | Move |
| --- | --- |
| DLEQ integration takes too long | Use official NUT-12-compatible fixtures/test vectors first; keep the accept-gate interface unchanged |
| Merkle-sum takes too long | Simplify the tree implementation, not the holder-verifiable identifier; no fake inclusion result |
| Cashu library API friction | Isolate all Cashu code in `src/cashu/`; do not let it spread through the app |
| Relays drop events | Publish to two relays; treat missing as RED |
| Scope creep into a wallet | Reject it |
| Reserve looks like live PoR | Label `demo-reserve` in UI and README |
| Judge asks about omitted liabilities | Show the holder inclusion attack and state the completeness limit |
| Judge asks about fake burns | State that Phase 1 commits burn records but full epoch-based fake-burn challenge is later work |
| Late start | Prioritize the three demo cases over extra features |

## 20. Positioning vs other entries

Do not pitch this as "a mint dashboard" or generic "mint auditor."

Pitch the combined object:

> **A holder-verifiable, Nostr-published solvency gate that can refuse Cashu ecash before acceptance.**

The differentiating demo is not just "reserve < liabilities." It is:

> **The mint's ratio looks healthy, but this valid mint-issued token was omitted from the liabilities commitment, so SOLVENT refuses it.**

If a later wallet wants to refuse tokens from a RED mint, it implements the same event schema and verification rule. That is application scope.

## 21. Copy you can reuse

### Devfolio short

**SOLVENT. Verify a Cashu mint's signed solvency state — and that your ecash was actually counted — before accepting it.**

### Devfolio longer

Cashu mints are custodial, and a healthy reserve ratio means little if a mint can quietly omit liabilities. SOLVENT commits mint and burn records, publishes outstanding liabilities and reserves as a signed Nostr event, and lets a receiver verify that their real Cashu issuance is included before accepting it. Missing issuance or insufficient reserves returns RED. Phase 1 uses a labelled reserve fixture; the holder verification, commitment checks, Nostr signature, and accept gate are real.

### Discord claim

See `SOLVENT-HANDOFF.md`.

## 22. Definition of done

Phase 1 is done only when all of these are true:

- public repo with MIT licence
- two fixture mints plus omitted-issuance case
- at least one Cashu proof fixture with usable NUT-12 DLEQ data
- verifier performs real DLEQ validation
- verifier reconstructs the holder-derived `C'`
- Merkle-sum mint inclusion is real and fails when the issuance is omitted
- burn commitment and outstanding-liability arithmetic are implemented for the fixture scope
- publisher CLI writes a real signed event to public Nostr relay(s)
- verifier implements the rule in Section 10.4
- tests exist for GREEN, omitted-liability RED, and insufficient-reserve RED
- README runs on a clean machine
- trust assumptions and limitations are written
- you can record the demo script without claiming live PoR or full global liability completeness

## 23. Technical basis

The Phase 1 design is intentionally shaped around existing Cashu mechanisms rather than inventing a fake token identifier:

- Cashu NUT-12 defines offline DLEQ validation for a received proof and allows a receiver with the included blinding factor to reconstruct the original blinded message `B'` and blind signature `C'`.
- Calle's Cashu proof-of-liabilities proposal models liabilities using publicly auditable mint proofs (issued blind signatures) and burn proofs (redeemed secrets), with outstanding liabilities equal to issued value minus burned value. It also explicitly relies on users checking their own records and does not claim perfect global accountability.

These are the design anchors. SOLVENT's contribution is the Nostr publication schema plus the verify-before-accept action gate and a compact holder-side verifier.
