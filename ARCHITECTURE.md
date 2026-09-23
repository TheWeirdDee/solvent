# Architecture

SOLVENT is two things that now run side by side, not yet connected to each other (that connection is Phase 2's job — see `DECISIONS.md`):

## 1. The verifier (all prior work — unchanged by Phase 1)

```
raw signed evidence (SubmissionBundle)
        │
        ▼
src/app/submission.ts — verifySubmission()
  ├── real live Bitcoin Signet/Mutinynet reserve re-query  (src/reserve/)
  ├── real live public Nostr relay fetch + re-verification (src/nostr/)
  └── real Cashu DLEQ / BIP-340 signature verification     (src/cashu/, src/pol/)
        │
        ▼
src/verifier/verify.ts — verify()   (locked, pure, synchronous, no network)
        │
        ▼
ACCEPT_VERIFIED / REFUSE_<reason>
        │
        ▼
src/enforcement/accept-gate.ts — runAcceptGate()
  real observable state mutation iff ACCEPT, never on REFUSE
```

This is the browser app (`npm run dev`), the CLI gates (`npm run gate0`..`gate6`), the attack corpus (`npm run attacks`), and the Live Public Demo (`npm run live-demo`, `.github/workflows/refresh-live-demo.yml`). See `docs/trust-boundaries.md` for exactly what's real here (it all is, except the mint that PRODUCES the evidence the verifier consumes — see below).

## 2. The real Cashu foundation (Phase 1 — new)

```
Bitcoin Core regtest → LND-1 → cdk-mintd (real, external, backend=lnd)
                          ↑
Bitcoin Core regtest → LND-2 (sender + melt destination)

src/cli/real-cashu/real-cashu-foundation.ts
  real NUT-04 mint → real NUT-03 swap → real NUT-07 state →
  real double-spend rejection → real NUT-05 melt
```

This proves the underlying Cashu economic lifecycle is genuinely real, using CDK — an independent, external mint implementation — rather than SOLVENT's own fixture keys. See `docs/real-cashu-stack.md`, `docs/reproduce-real-stack.md`, `docs/dependencies.md`, and `docs/REALITY-MAP.md`.

## Where these two meet (Phase 2, not yet built)

Today, `verifySubmission()` accepts a `SubmissionBundle` — raw proof + signed receipt + signed manifest + reserve attestation + Nostr event — from **any** source; nothing in it assumes SOLVENT's own fixture mint produced it. Phase 1 proves the *base Cashu layer* (issue/swap/melt) can be real. Phase 2's job is to make the *SOLVENT-specific layer* (signed PoL receipts, epoch manifests, sum-MMR inclusion, reserve attestation, Nostr publication) also originate from real mint-side activity — i.e. modify the actual mint transaction boundary so a real CDK mint's real issue/swap/melt events create durable PoL accounting, rather than SOLVENT computing that layer itself from a freshly-generated identity. That is explicitly out of scope for Phase 1 — see `DECISIONS.md`.

## Directory map (Phase 1 additions in bold)

```
src/
  app/        the browser client + submission/verification orchestration (unchanged)
  cashu/      SOLVENT's own fixture mint crypto — real @cashu/cashu-ts primitives, Lane A only
  cli/        gate0..gate6, attacks, live-demo, verify-submission, verify-deployed(*)
    **real-cashu/**   **Phase 1: real-cashu-foundation.ts, lnd-client.ts, proof-store.ts, evidence.ts**
  enforcement/ Gate 4's real accept-function spy boundary (unchanged)
  nostr/      Nostr event schema/signing/relay I/O (unchanged)
  pol/        Proof-of-Liabilities primitives: manifest/receipt/sum-MMR (unchanged — not yet connected to Phase 1)
  reserve/    Bitcoin Signet/Mutinynet reserve attestation + live Esplora queries (unchanged)
  verifier/   the locked, pure central verify() decision function (unchanged)
evidence/
  ...(existing gate/attack/live-demo evidence, unchanged)
  **real-cashu/<run-id>/**   **Phase 1's real-stack evidence package — see docs/real-cashu-stack.md**
.github/workflows/
  refresh-live-demo.yml            the existing verifier's Live Public Demo refresh (unchanged)
  **real-cashu-integration.yml**   **Phase 1's real regtest stack + integration test**
```
