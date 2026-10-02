# Verify in 5 minutes

What runs where, so you know what each check touches:

| | |
|---|---|
| **App** (canonical) | <https://solvent-ashen.vercel.app/>, a static build on Vercel. GitHub Pages hosts a mirror, not the canonical app |
| **Interactive mint** | A real patched CDK `cdk-mintd` (`patches/cdk/0001-0009`) on Railway, with persistent SQLite |
| **Evidence service** | The SOLVENT sidecar on Railway: epoch closer, Nostr publisher, evidence API |
| **Lightning on the public mint** | **fakewallet**: a demo backend whose invoices settle by themselves. It is labelled as such everywhere; no real payment happens |
| **Real Lightning** | Real LND, in CI; the results are committed under `evidence/real-pol/ci-*-lnd/` (see the Evidence page, `#/publish`) |
| **Reserve** | A real Mutinynet (Bitcoin Signet) UTXO. Test coins with no monetary value |

## 1. In the browser (no install)

Follow [Start here](#/docs?doc=start-here):
1. Open the **live mint** and run an honest issuance → `ACCEPT_VERIFIED`.
2. Break the promise → `REFUSE_ISSUANCE_OMITTED`.
3. Open the [Evidence page](#/publish).

## 2. In a terminal

```bash
npm ci
npm test                    # unit + integration + jsdom UI suites (official NUT-12 and PR #388 vectors included)
npm run attacks             # the 25-case attack corpus
npm run verify:submission   # the mechanism gates, the reference case checked live, and the submission materials
npm run verify:phase3b-evidence -- evidence/real-pol/ci-36614823173-lnd/phase3b   # offline replay of the real-LND Phase 3B record
```

`verify:submission` re-runs the gate mechanisms (not a canned transcript). It checks the reference case live, then the submission materials. Today it ends with:

```
ENGINEERING READY
SUBMISSION BLOCKED: DEMO VIDEO URL
```

This is correct: the engineering checks pass, and the submission is not complete until the demo video URL is in the README. Only then does it print `SUBMISSION READY`; `--strict` fails until then.

The line **"Canonical Live Public Demo"** in its output is a check performed right now. It verifies the published *reference* case (`evidence/nostr/live-demo.json`, refreshed twice a day) against public relays and the chain. That case is a captured reference, not the live Railway mint. The lines marked "historical" read recorded Gate 5/6 evidence.

## 3. The strongest records, without running anything

- **Real-LND Phase 3B:** honest [`phase3-accept.json`](evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-accept.json) (`ACCEPT_VERIFIED`) and broken promise [`phase3-omission-refuse.json`](evidence/real-pol/ci-36614823173-lnd/phase3b/phase3-omission-refuse.json) (`REFUSE_ISSUANCE_OMITTED`). Offline replayable.
- **Real-LND NUT-05:** [`nut05-melt.json`](evidence/real-pol/ci-36619816959-lnd/nut05/nut05-melt.json). An inspectable record.
- **Phase 3A:** [`phase3a/`](evidence/real-pol/ci-36614823173-lnd/phase3a/). A public audit record, not offline-replay complete (never-spent proof secrets were withheld).
- **Attacks:** `ATTACKS.md` and `evidence/attacks/`.

The full index is [`evidence/README.md`](evidence/README.md).

## Regenerating evidence (developers)

```bash
npm run gate0 … gate6     # the captured reference mechanism evidence (evidence/gate-*, nostr/, reserves/, hero/)
npm run attacks           # evidence/attacks/
npm run live-demo         # republish the reference case (evidence/nostr/live-demo.json)
npm run verify:live-demo  # re-check the reference case right now
```

The reference case is bundled into the static build. `.github/workflows/refresh-live-demo.yml` republishes it twice a day and commits it to `main`, which redeploys Vercel; the GitHub Pages mirror is redeployed by `deploy-site.yml`. Live-mint evidence comes from Railway at run time and needs no redeploy.

## What this does not verify

It does not make the custodial mint trustless, and it does not show that the reserve backs only this mint, that no liabilities exist outside the commitment, or future solvency. See [Trust boundaries](#/docs?doc=trust-boundaries).
