# SOLVENT evidence

This directory holds the machine-readable records behind SOLVENT's claims. The packages fall into four kinds. Each section says what the package proves, where it came from, and how to check it yourself.

Scope throughout: Lightning is **real LND** only where the package says `lightning_backend: lnd`. The Bitcoin network is always a **test network** (Mutinynet / Bitcoin Signet; regtest inside CI); test coins have no monetary value.

---

## 1. Real-LND CI evidence (strongest)

Produced by the **Real Cashu + SOLVENT Integration** workflow (`.github/workflows/real-cashu-integration.yml`). It runs a real patched CDK `cdk-mintd` built from source (`patches/cdk/0001-0009`) over **real regtest LND**, then publishes to real public Nostr relays and binds a real Mutinynet reserve.

These folders are curated copies of the runs' `real-cashu-evidence` artifacts. GitHub deletes those artifacts in December 2026; **the committed copies here do not expire**.

### Phase 3B: public evidence, honest ACCEPT and broken-promise REFUSE

| | |
|---|---|
| **Folder** | [`real-pol/ci-36614823173-lnd/phase3b/`](real-pol/ci-36614823173-lnd/phase3b/) (18 files) |
| **CI run** | [36614823173](https://github.com/TheWeirdDee/solvent/actions/runs/36614823173), source commit `7bf996a`, 2026-09-29 |
| **Backend** | `lightning_backend: lnd` |
| **Honest issuance** | [`phase3-accept.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-accept.json) → **`ACCEPT_VERIFIED`**, every check true |
| **Broken promise** | [`phase3-omission-refuse.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-omission-refuse.json) → **`REFUSE_ISSUANCE_OMITTED`**; every check true except `inclusionValid` |
| **Also proves** | NUT-06 identity → manifest-key delegation ([`phase3-delegation.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-delegation.json)); signed manifests; the reserve and its epoch-scoped binding ([`phase3-reserve.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-reserve.json), [`phase3-reserve-binding.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-reserve-binding.json)); Nostr publication with ACK and exact fetch-back; refusal when evidence is missing or unavailable; real LND settlement ([`phase3-lightning-settlement.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-lightning-settlement.json)) |
| **Nostr events (kind 8181)** | honest [`31bdacb7…9434`](https://njump.me/31bdacb7ec783c982e9e63fcc8fab0a1be1d80bbbe3112f7f487035149109434); broken promise [`03420fa2…e657`](https://njump.me/03420fa28cc2005c05db6cf76cd41de2d57fe8539b449ca0fdc84965b1c1e657) |
| **Reserve outpoint** | [`598bfed2…58fb:0`](https://mutinynet.com/tx/598bfed24044ea8b37bf79d0719afcebb87a8767f91c73dc37a36f17214c58fb) (Mutinynet) |
| **Offline replayable** | **Yes.** It contains Cashu proof secrets, and every one is recorded as spent by the mint in [`phase3-proofs-spent.json`](real-pol/ci-36614823173-lnd/phase3b/phase3-proofs-spent.json) |
| **Verify** | `npm run verify:phase3b-evidence -- evidence/real-pol/ci-36614823173-lnd/phase3b` |

The same Phase 3B suite passed again in run [36619816959](https://github.com/TheWeirdDee/solvent/actions/runs/36619816959).

### NUT-05: melt with change, accounted

| | |
|---|---|
| **File** | [`real-pol/ci-36619816959-lnd/nut05/nut05-melt.json`](real-pol/ci-36619816959-lnd/nut05/nut05-melt.json) |
| **CI run** | [36619816959](https://github.com/TheWeirdDee/solvent/actions/runs/36619816959), source commit `08b2037`, 2026-09-29 |
| **Backend** | `lightning_backend: lnd` |
| **Proves** | A real Lightning payment made by melting ecash. The 6 inputs (1,000 sats) become *consumed* liabilities in CDK's first transaction, and their proofs are SPENT. The 6 change outputs (700 sats) become *issued* liabilities with signed receipts, in CDK's second transaction. Both land in epoch 7's accounting (`docs/nut05-melt-accounting.md`) |
| **Offline replayable** | It is an inspectable record, not a replay bundle; it contains no proof secrets |

### Phase 3A and Phase 2: the epoch lifecycle and mint-native accounting

| | |
|---|---|
| **Folder** | [`real-pol/ci-36614823173-lnd/phase3a/`](real-pol/ci-36614823173-lnd/phase3a/) (43 files) |
| **CI run** | [36614823173](https://github.com/TheWeirdDee/solvent/actions/runs/36614823173), source commit `7bf996a`, 2026-09-29 |
| **Backend** | `lightning: lnd` |
| **Proves** | NUT-04/NUT-03 accounting written inside CDK's own transactions (`nut03-*.json`, `accounting-atomicity.json`); receipts signed and verified (`receipt-*.json`); the epoch lifecycle (`phase3-epoch.json`, `phase3-mmr.json`, `phase3-receipt.json`); crash rollback and restart audits (`phase3-crash-rollback.json`, `phase3-restart-audit.json`); honest verification (`phase3-honest-verify.json`) and the broken promise (`phase3-omission-refuse.json`) |
| **Offline replayable** | **PUBLIC AUDIT RECORD — NOT OFFLINE-REPLAY COMPLETE.** The two `phase3-*-verify-input.json` files were omitted: their Cashu proof secrets were never spent before the CI runner (and its regtest mint) was destroyed. The verdict files are the original, unmodified output |
| **Verify** | Inspect the JSON; the full run is reproducible with the workflow |

NUT-03 swap accounting is recorded in run [36150315347](https://github.com/TheWeirdDee/solvent/actions/runs/36150315347) (source commit `4a802bc`, 2026-09-25): `npm run verify:nut03-evidence -- 36150315347`.

---

## 2. Public Railway evidence (live)

The public demo mint is a real patched CDK `cdk-mintd` on Railway with **fakewallet Lightning**, which is labelled as such everywhere. It produces this evidence live, outside this directory:

- mint: `https://solvent-production-2029.up.railway.app/v1/info`
- evidence service: `https://solvent-production-9c92.up.railway.app/v1/solvent/status`, which gives the latest epoch, its Nostr event and its publication time
- reserve: [`809e5190…08c2:1`](https://mutinynet.com/tx/809e5190a63ea454d35fbb0b86919d6799fa65a6fe4385baa63eb180711308c2) (Mutinynet, 1,000,000 sats)

Each issuance on <https://solvent-ashen.vercel.app/#/mint> is verified in the browser, and its evidence can be downloaded from the result.

---

## 3. Local fakewallet reproductions

Real patched mint, **fakewallet Lightning**, run on a developer machine. These show that the pipeline reproduces outside CI.

| Folder | Proves | Verify |
|---|---|---|
| [`real-pol/phase3b-local-fakewallet/`](real-pol/phase3b-local-fakewallet/) | The Phase 3B suite with `lightning_backend: fakewallet`; its proofs are recorded as spent | `npm run verify:phase3b-evidence -- evidence/real-pol/phase3b-local-fakewallet` |
| [`real-pol/nut05-local-fakewallet/`](real-pol/nut05-local-fakewallet/) | NUT-05 melt accounting, fakewallet | Inspect `nut05-melt.json` |

---

## 4. Captured reference evidence

Earlier, deterministic records of the mechanism. These are real cryptography and real publications, but **snapshots, not current status**.

| Folder | What it is | Captured |
|---|---|---|
| [`nostr/live-demo.json`](nostr/live-demo.json) | The published reference case behind *Re-check published evidence*. It is refreshed twice a day by `.github/workflows/refresh-live-demo.yml`, so its event id changes; see the file | see `publishedAt` |
| [`nostr/`](nostr/) (the other files) | Gate 5: a kind 8181 publish and fetch-back | 2026-09-22 |
| [`reserves/`](reserves/) | Gate 6: a signed reserve attestation. `reserve-key.json` is a **published test key**, used for the reference case only | 2026-09-22 |
| [`gate-0/`](gate-0/), [`gate-1/`](gate-1/), [`gate-2/`](gate-2/), [`gate-4/`](gate-4/), [`hero/`](hero/) | NUT-12 reconstruction, receipts, sum-MMR and manifest, acceptance enforcement, and the hero omission contradiction | `npm run gate0` … `gate6` |
| [`attacks/`](attacks/) | 25 adversarial cases with expected outcomes | `npm run attacks` (25/25) |

---

## What is never committed here

- mnemonics, private keys, LND macaroons or TLS keys, and API or GitHub tokens;
- Cashu proof secrets that were never spent;
- CI runner logs;
- local generated output (`real-pol/local-*`, `real-pol/*-local-20*`, `railway-shots/`). These are ignored by `.gitignore`.
