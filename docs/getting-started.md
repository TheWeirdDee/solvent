# Getting started

Five ways in, from quickest to deepest. The public app is <https://solvent-ashen.vercel.app/>.

## 1. Try the live mint

**[Live mint](#/mint)** creates a fresh issuance on SOLVENT's public mint and verifies it. That mint is a real patched CDK `cdk-mintd`, hosted on Railway with fakewallet (demo) Lightning. One run takes about 30–90 seconds, because the mint's accounting epoch has to close and be published first.

- **Mint & verify an honest issuance** → `ACCEPT_VERIFIED`
- **Break the promise** → `REFUSE_ISSUANCE_OMITTED`

A step-by-step judge walkthrough is in [Start here](#/docs?doc=start-here). Every record behind SOLVENT's claims (including the real-Lightning CI results) is on the [Evidence page](#/publish).

## 2. Re-check published evidence

**[Verify → Re-check published evidence](#/verify?mode=live)** re-verifies a *captured reference case* that was published earlier. Its Nostr event is fetched again from public relays and its reserve re-queried on chain, now. It mints nothing; its dates are shown before you run it.

## 3. Verify a bundle

**[Verify → Verify evidence](#/verify?mode=evidence)** checks a SOLVENT verification bundle you paste, upload or drop, with the same pipeline. The structure is in the [verification bundle schema](#/docs?doc=verification-bundle). A **Download full replay bundle** from a live-mint result is such a bundle.

Malformed or incomplete input is an **input error**, never a verdict about a mint.

## 4. Run it locally

```sh
git clone https://github.com/TheWeirdDee/solvent && cd solvent
npm ci
npm test                 # unit + integration tests
npm run attacks:check    # the 25-case attack corpus, compared with the committed records
npm run verify:submission
npm run dev              # the app on http://localhost:5173
```

To run the real mint yourself, see [Deploy a real mint](#/docs?doc=deploy-real-mint) (Docker Compose) or [Deploy on Railway](#/docs?doc=deploy-railway).

## 5. Understand the limitations

SOLVENT makes a mint's accounting **checkable**. It does not make a custodial mint trustless:

- The mint is still custodial, and the network is a test network (Mutinynet / Bitcoin Signet).
- An observed reserve covering the committed liabilities does not prove exclusive backing, the absence of liabilities outside the commitment, or future solvency.
- The public mint's Lightning is fakewallet; real LND is proven in CI.

The full list is in [Trust boundaries](#/docs?doc=trust-boundaries) and [Draft alignment](#/docs?doc=draft-alignment). The project README is [here](#/docs?doc=readme).
