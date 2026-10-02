# Start here — judge SOLVENT in 3 minutes

No terminal, no JSON, no account. Everything below runs on the public app, <https://solvent-ashen.vercel.app/>.

## 1. Mint an honest issuance → `ACCEPT_VERIFIED`

Open **[Live mint](#/mint)** and click **Mint & verify an honest issuance**.

- A real, patched CDK Cashu mint (hosted on Railway) issues 64 sats. Its Lightning backend is a labelled demo (**fakewallet**): the invoice settles by itself.
- The mint signs a **receipt**: a promise to count your issuance in accounting epoch *N*.
- The operation card shows the wait: epoch *N* closes about every 30 seconds, then its evidence is published to public Nostr relays (you see which relays acknowledged it).
- SOLVENT then checks the promise in your browser: the closed epoch, the Nostr event fetched back from the relays, and the Bitcoin reserve re-queried on chain.
- Result: **ACCEPT_VERIFIED**. The **Enforcement** card shows the real acceptance side effect: accept function called **once**.

## 2. Break the promise → `REFUSE_ISSUANCE_OMITTED`

Click **Start again**, then **Break the promise**.

- Before minting, the page asks the evidence service to have the mint's real epoch closer leave **exactly this issuance** out of the epoch it promises.
- Every signature is still valid, the evidence is public and the reserve covers what was reported. Only the promise is broken.
- Result: **REFUSE — BROKEN PROMISE** (`REFUSE_ISSUANCE_OMITTED`). Accept function calls: **0**.

## 3. Inspect the evidence

On each result, **Open Nostr event** and **Open reserve transaction** show the exact public evidence on independent explorers. **Download public evidence** saves it as JSON. **The checks** lists the eight verification checks, grouped under four questions (receipt, closed accounting state, public evidence, reserve coverage), and then the decision. Every record SOLVENT relies on is on the [Evidence page](#/publish).

## 4. See it on real Lightning

The live mint uses demo Lightning. The same pipeline runs over **real LND** in CI, and the results are committed to the repository and shown on the [Evidence page](#/publish):

- [Phase 3A/3B run 36614823173](https://github.com/TheWeirdDee/solvent/actions/runs/36614823173): honest `ACCEPT_VERIFIED`, broken promise `REFUSE_ISSUANCE_OMITTED`.
- [NUT-05 run 36619816959](https://github.com/TheWeirdDee/solvent/actions/runs/36619816959): melt with change accounted for.

## If something is slow or fails

- **"Could not complete"** (amber) means a relay or the reserve API could not be reached. Nothing was accepted. Click **Retry verification**: it re-checks the **same** issuance without minting again.
- **REFUSE** (red) means the evidence was checked and the mint failed it.
- **Input error** (grey, on Verify) means the pasted input could not be verified at all. It says nothing about any mint.

Next: [Getting started](#/docs?doc=getting-started) · [Trust boundaries](#/docs?doc=trust-boundaries) · [Protocol](#/protocol)
