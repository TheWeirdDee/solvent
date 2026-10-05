# Demo runbook

The recording sequence for the demo video, on the canonical app <https://solvent-ashen.vercel.app/>. It takes about 6 minutes, including paying two test invoices. Everything shown is live.

Say plainly, once, that everything runs on **Mutinynet**, a Bitcoin test network: the Lightning payments are real, the sats have no monetary value, and this is not mainnet.

## Before recording

```sh
curl -s https://solvent-production-2029.up.railway.app/v1/info | head -c 120   # real CDK mint: cdk-mintd/0.18.1, pubkey 0294d5b0…
curl -s https://solvent-production-9c92.up.railway.app/v1/solvent/status       # "lightning_backend":"ldk-node", "demo_faucet_invoices":true
npm run verify:submission    # expect: ENGINEERING READY / SUBMISSION BLOCKED: DEMO VIDEO URL (until this video's URL is added)
npm run verify:deployed-revision   # the site serves the commit you expect
```

- Use a fresh browser profile, so no earlier issuance is restored.
- Open <https://faucet.mutinynet.com/> in a second tab and sign in with GitHub, so paying an invoice is one paste.

## The sequence

| # | Time | Show | Say |
|---|---|---|---|
| 1 | 0:00 | <https://solvent-ashen.vercel.app/> | "SOLVENT checks whether an ecash mint kept its promise, before you accept its ecash." |
| 2 | 0:10 | The hero and the "In plain words" primer | "A valid Cashu token proves the mint signed it — not that the mint counted it in its books." |
| 3 | 0:25 | **Mint & verify ecash** → `#/mint` | "This is a real, patched CDK Cashu mint on Railway, with its own Lightning node on Mutinynet." |
| 4 | 0:35 | The lifecycle bar 1 Mint · 2 Verify · 3 Accept · 4 Swap · 5 Pay, and **About this mint** (NUT-06 identity, "Real Lightning (LDK node) on Mutinynet") | "Five steps: get ecash, verify it, accept it, then use it twice." |
| 5 | 0:45 | **Mint 64 test sats** → the PAY 64 TEST SATS box | "A real Lightning invoice. I pay it from the Mutinynet faucet." |
| 6 | 0:55 | Faucet tab: paste the invoice, pay; back to the app: status "paid" | "The mint issues ecash only after its own Lightning node sees the payment." |
| 7 | 1:15 | THE MINT'S PROMISE: receipt SIGNED, promised epoch N, "WAITING FOR EPOCH N TO CLOSE" | "The mint signed a promise to count this issuance in accounting epoch N." |
| 8 | 1:35 | "EPOCH N CLOSED · PUBLISHED TO NOSTR", then the six checks, all VALID | "Epoch N closed, was published to public relays, and the reserve was re-queried on chain." |
| 9 | 1:50 | **✓ ACCEPT** — "The mint kept its accounting promise for this ecash", `accept() called exactly once`; YOUR ECASH: ACCEPTED ✓ | "Only now is the ecash accepted — once." |
| 10 | 2:00 | **Swap ecash** | "Spend it at the mint: one proof in, four new proofs out." |
| 11 | 2:40 | SWAP COMPLETE: original SPENT, replacements UNSPENT, 64 → 64, Liability CONSERVED ✓, Spent accounting COMMITTED ✓ | "The mint's own signed books show the old proof spent and the liability unchanged." |
| 12 | 2:50 | **Pay with ecash** | "Now pay a real Lightning invoice with the ecash." |
| 13 | 3:30 | PAYMENT COMPLETE: Lightning PAID ✓, inputs SPENT, change RETURNED, Accounting UPDATED ✓; YOUR ECASH: "24 test sats remaining"; all five steps complete | "The mint paid the invoice — the preimage proves it — returned the change, and its liabilities fell by exactly what was paid." |
| 14 | 3:45 | TEST THE ATTACK — deliberate demo fault: **Break the promise** | "Now make the mint break its promise. This is a deliberate, labelled demo fault." |
| 15 | 3:55 | Pay the second invoice from the faucet | "Another real payment; the mint signs the same kind of promise." |
| 16 | 4:30 | Epoch N closed and published — without the issuance | "The epoch closes, signed and published, without it." |
| 17 | 4:45 | **✕ REFUSE — BROKEN PROMISE** (`REFUSE_ISSUANCE_OMITTED`): five checks VALID, "Your issuance included" MISSING; `accept() NOT CALLED` | "Every signature is valid, the reserve covers the books. The promise was broken, so SOLVENT refuses." |
| 18 | 5:00 | **Open Nostr event** / **Download public evidence** | "The public record, for anyone to check." |
| 19 | 5:15 | Header → **Evidence** (`#/publish`) | "Every record is here, including the earlier real-LND CI runs." |
| 20 | 5:30 | Landing → attack corpus, `npm run attacks:check` | "25 cases produce their expected outcomes: attacks are refused for the right reason, and the honest controls are accepted." |
| 21 | 5:45 | Landing → "What SOLVENT proves / does not change" | "The mint is still custodial; this is a test network; the PoL semantics follow a draft proposal." |

## If something goes wrong while recording

| Symptom | Meaning | What to do |
|---|---|---|
| The pay box keeps "waiting for payment" | The invoice has not been paid yet | Pay it from the faucet tab; it expires after the countdown, and nothing is minted unpaid |
| Pay step: "The Lightning payment is still in flight" | A real payment can take a minute or two | Wait; the page follows the mint's melt quote until it settles |
| Amber **"could not complete"** | A relay or the reserve API was unreachable; nothing was accepted | Click **Retry verification (same issuance)** |
| "Waiting for epoch N to close" for a long time | Epochs close about every 30 s once they hold an issuance | Wait; the promise card shows the state |
| An external explorer (njump) errors | A third-party viewer is down; SOLVENT does not depend on it | Use **Alternate viewer**, or the raw signed event in the result |
| `REFUSE_NOSTR_STALE` on *Re-check published evidence* | The reference case is past its freshness window | Run the *Refresh Live Evidence* workflow |

## Self-hosting (optional, not part of the video)

The same mint and evidence service run locally or on any host: see [`DEPLOY-REAL-MINT.md`](DEPLOY-REAL-MINT.md) (Docker Compose) or [`DEPLOY-RAILWAY.md`](DEPLOY-RAILWAY.md). The headless version of the whole sequence, paying each invoice through the Mutinynet faucet's API with a faucet token:

```sh
npm run verify:real-mint:browser -- https://solvent-ashen.vercel.app/ - - --swap --melt --pay-faucet <token file>
```
