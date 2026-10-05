# Start here — judge SOLVENT in minutes

No terminal, no JSON, no install. Everything below runs on the public app, <https://solvent-ashen.vercel.app/>, against a real patched CDK Cashu mint with its own Lightning node on **Mutinynet**, a Bitcoin test network. The Lightning payments are real; the sats have no monetary value.

You need Mutinynet test sats to pay two 64-sat invoices: open <https://faucet.mutinynet.com/>, sign in with GitHub, and paste each invoice there. Any Mutinynet (signet) Lightning wallet works too.

## 1. Mint → `ACCEPT_VERIFIED`

Open **[Mint ecash](#/mint)** and click **Mint 64 test sats**.

- The mint shows a real 64-sat Lightning invoice, with its expiry and payment status. Pay it. The mint issues Cashu ecash only after its own Lightning node sees the payment.
- **The mint's promise:** the mint signs a **receipt** promising to count your issuance in accounting epoch *N*. Epoch *N* closes about every 30 seconds and is published to public Nostr relays.
- **Verify:** your browser checks the promise: the mint's signature, the closed epoch, your issuance in it, the Nostr event fetched back from the relays, and the Bitcoin reserve re-queried on chain.
- **Accept:** `ACCEPT_VERIFIED` — "The mint kept its accounting promise for this ecash". The accept function is called **exactly once**.

## 2. Swap → liability conserved

Click **Swap ecash**. The accepted proof is exchanged at the mint (NUT-03) for four new proofs. SOLVENT then checks the mint's own signed books: the original proof is **SPENT** and in the signed spent commitment, the replacements are **UNSPENT** and in the issued commitment, and the outstanding liability is unchanged.

## 3. Pay → liability falls by what was paid

Click **Pay with ecash**. The mint pays a real 40-sat Mutinynet Lightning invoice from the public faucet with your ecash (NUT-05) and returns the change. The payment preimage proves the invoice was paid, the inputs are **SPENT**, the change is **UNSPENT**, and the mint's liability falls by exactly the amount paid plus the routing fee. YOUR ECASH shows what remains.

## 4. Break the promise → `REFUSE_ISSUANCE_OMITTED`

In **Test the attack**, click **Break the promise** and pay the second invoice. This is a **deliberate, labelled demo fault**: before minting, the page asks the evidence service to have the mint's real epoch closer leave **exactly this issuance** out of the epoch it promises.

- The receipt and the epoch manifest are validly signed, the evidence is on public relays and the reserve covers what was reported. Only the promised issuance is missing.
- Result: **REFUSE — BROKEN PROMISE** (`REFUSE_ISSUANCE_OMITTED`), and `accept()` is **not called**.

## 5. Inspect the evidence

On each result, **Open Nostr event** and **Open reserve transaction** show the exact public evidence on independent explorers, and **Download public evidence** saves it as JSON. The technical detail (the eight checks, the raw result) is in the collapsed sections. Every record SOLVENT relies on is on the [Evidence page](#/publish).

## If something is slow or fails

- **"Waiting for payment"** — the invoice has not been paid yet. It expires after the countdown; nothing is minted unpaid.
- **"The Lightning payment is still in flight"** — a real payment can take a minute or two; the page follows it until it settles.
- **"Could not complete"** (amber) — a relay or the reserve API could not be reached. Nothing was accepted. **Retry verification** re-checks the **same** issuance without minting again.
- **REFUSE** (red) — the evidence was checked and the mint failed it.
- **Input error** (grey, on Verify) — the pasted input could not be verified at all. It says nothing about any mint.

Next: [Getting started](#/docs?doc=getting-started) · [Trust boundaries](#/docs?doc=trust-boundaries) · [Protocol](#/protocol)
