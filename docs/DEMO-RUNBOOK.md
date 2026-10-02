# Demo runbook

The recording sequence for the demo video, on the canonical app <https://solvent-ashen.vercel.app/>. It takes about 5 minutes. Everything shown is live, except the committed real-LND records in steps 20–21: those are recorded CI evidence, and should be introduced as such.

Say plainly, once, that the public mint's Lightning is **fakewallet** (a demo backend whose invoices settle by themselves), and that real Lightning is shown by the committed CI evidence.

## Before recording

```sh
curl -s https://solvent-production-2029.up.railway.app/v1/info | head -c 120   # real CDK mint: cdk-mintd/0.18.1, pubkey 0294d5b0…
curl -s https://solvent-production-9c92.up.railway.app/healthz                 # evidence service: {"ok":true,…}
npm run verify:submission    # expect: ENGINEERING READY / SUBMISSION BLOCKED: DEMO VIDEO URL (until this video's URL is added)
```

Use a fresh browser profile, so no earlier issuance is restored.

## The sequence

| # | Time | Show | Say |
|---|---|---|---|
| 1 | 0:00 | <https://solvent-ashen.vercel.app/> | "SOLVENT checks whether an ecash mint kept its promise." |
| 2 | 0:10 | The hero and the "In plain words" primer | "Ecash is digital cash a mint issues against bitcoin. A valid token proves the mint signed it — not that the mint counted it in its books." |
| 3 | 0:30 | **Try the live mint** → `#/mint` | "This is a real, patched CDK Cashu mint on Railway." |
| 4 | 0:40 | The mint card: NUT-06 identity, "Demo fakewallet", LIVE RAILWAY MINT line | "Its Lightning is a demo backend, and it says so. Everything SOLVENT checks is real." |
| 5 | 0:50 | **Mint & verify an honest issuance** | The operation card appears under the button. |
| 6 | 1:00 | Step 2 of the card | "The mint signed a receipt: a promise to count this issuance in accounting epoch N." |
| 7 | 1:10 | The countdown, then "ACK from …" relays | "Epoch N closes and is published to public Nostr relays." |
| 8 | 1:30 | The result's reserve row | "The reserve UTXO is re-queried on Mutinynet now." |
| 9 | 1:40 | **✓ ACCEPT** — `ACCEPT_VERIFIED` | "Receipt, closed epoch, public evidence and reserve all check out." |
| 10 | 1:50 | Enforcement card: accept function calls = 1 | "The verdict triggered a real acceptance side effect, once." |
| 11 | 2:00 | **Retry verification (same issuance)** | "Re-checking the same issuance; no new ecash is minted." |
| 12 | 2:15 | Enforcement card again: calls still 1, "already accepted" | "Never accepted twice." |
| 13 | 2:25 | **Start again** → **Break the promise** | "Now the mint's real closer is told to leave this exact issuance out." |
| 14 | 2:35 | Step 2: the receipt for epoch N | "The mint still signs the same kind of promise." |
| 15 | 2:50 | "Epoch N closed and published" | "The epoch closes, signed and published, without it." |
| 16 | 3:10 | **✕ REFUSE — BROKEN PROMISE** (`REFUSE_ISSUANCE_OMITTED`): receipt VALID, manifest VALID, evidence RETRIEVED, reserve COVERED, promised issuance MISSING | "Every signature is valid. The promise was broken." |
| 17 | 3:25 | Enforcement card: accept calls = 0, store changed: no | "Refused ecash never reaches acceptance." |
| 18 | 3:35 | **Open Nostr event** / **Download public evidence** | "The public record, and the evidence file, for anyone to check." |
| 19 | 3:50 | Header → **Evidence** (`#/publish`) | "Every record is here." |
| 20 | 4:00 | Real-LND Phase 3B card: `ACCEPT_VERIFIED` (13/13), `REFUSE_ISSUANCE_OMITTED` (only inclusion fails), the committed files, CI run 36614823173 | "The same pipeline over real Lightning, in CI. It's committed, and it replays offline." |
| 21 | 4:20 | Real-LND NUT-05 card | "A real Lightning payment by melting ecash, with the change accounted for." |
| 22 | 4:35 | Landing → attack corpus, `npm run attacks` | "25 adversarial cases, each refused for the right reason." |
| 23 | 4:45 | Landing → "What SOLVENT proves / does not change" | "The mint is still custodial; this is a test network; the PoL semantics follow a draft proposal." |

## If something goes wrong while recording

| Symptom | Meaning | What to do |
|---|---|---|
| Amber **"could not complete"** | A relay or the reserve API was unreachable; nothing was accepted | Click **Retry verification (same issuance)** |
| "Waiting for epoch N to close" for a long time | Epochs close about every 30 s once they hold an issuance | Wait; the card shows the countdown |
| An external explorer (njump) errors | A third-party viewer is down; SOLVENT does not depend on it | Use **Alternate viewer**, or the raw signed event in the result |
| `REFUSE_NOSTR_STALE` on *Re-check published evidence* | The reference case is past its freshness window | Run the *Refresh Live Evidence* workflow |

## Self-hosting (optional, not part of the video)

The same mint and evidence service run locally or on any host: see [`DEPLOY-REAL-MINT.md`](DEPLOY-REAL-MINT.md) (Docker Compose) or [`DEPLOY-RAILWAY.md`](DEPLOY-RAILWAY.md). The headless version of steps 5–17:

```sh
npm run verify:real-mint:browser -- https://solvent-ashen.vercel.app/ - -
```
