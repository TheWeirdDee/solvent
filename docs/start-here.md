# Start here — check ecash with SOLVENT in 2 minutes

This is the fastest way to see SOLVENT decide something, entirely in your browser — no terminal, no manual JSON, no account.

## Part 1 — run the live check

1. Go to **[Verify](#/verify)**. You land on **Live check**.
2. Before running anything, look at **Reference case**: when the published case was published, how long its Nostr event is valid, and until when its reserve attestation stays fresh.
3. Click **Run live check** and watch the nine checks: token format, mint origin / NUT-12, PoL receipt, promised epoch, signed epoch manifest, liability inclusion, public Nostr retrieval, live reserve, decision.
4. Steps 7 and 8 happen now, not ahead of time. SOLVENT fetches the reference case's accounting event from real public Nostr relays and re-queries its reserve UTXO on Bitcoin Signet (Mutinynet). The status strip shows what it found — **Nostr: LIVE / NOT FOUND / UNAVAILABLE**, **Reserve: LIVE / SPENT / UNAVAILABLE** — and when.
5. The result leads with the decision. When everything checks out you get **ACCEPT** / **ACCEPT VERIFIED**, with the exact Nostr event id and reserve txid:vout that were checked, each linked to a public explorer.
6. Click **Accept ecash**. This calls SOLVENT's real acceptance function — a genuine, observable state change, not a UI animation — exactly once.
7. Click **Run the live check again**. Everything is re-fetched and **Last checked** updates.

If a relay or the reserve can't be reached, or the reference case has aged past its freshness window, the live check says so as a **REFUSE** with the exact reason. It never fills in a result from bundled data.

## Part 2 — verify evidence yourself

8. Switch to **Verify evidence**. Paste a SOLVENT verification bundle, drop a `.json` file onto the box, or click **Load live example** to load the same published reference case.
9. Click **Verify bundle**. The same nine checks run on whatever you supplied.
10. A bundle whose signatures are valid but whose accounting event isn't on any public relay is refused as **PUBLIC EVIDENCE NOT FOUND** — its valid local cryptography appears as a secondary fact under the REFUSE, never as the headline. A plain Cashu token with no liability evidence is refused as **UNSUPPORTED MINT**.

## Product, reference lab, and the real CDK mint

- **The product** is the verifier on `/verify`: the live reference case and SOLVENT-compatible bundles you supply.
- **The reference mint lab** (`#/lab`, developers only) generates local SOLVENT-compatible proofs for protocol inspection. It is not a production mint and its evidence is never published, so its primary action is **Check local cryptography**, not verification.
- **The real CDK mint integration** — SOLVENT's accounting running inside a real Cashu Development Kit mint for NUT-04 minting and NUT-03 swaps — is proven in CI. It is not yet the backend behind this web page.

See [Trust boundaries](#/docs?doc=trust-boundaries) for the full breakdown.

## Where does a bundle come from?

A SOLVENT-compatible mint exports it with the ecash: a signed receipt, a closed epoch manifest, an inclusion proof, a signed Bitcoin reserve attestation and a signed Nostr event. The bundle is never a claim about its own validity — SOLVENT independently re-derives the reserve and Nostr results live before it decides. See [the verification bundle schema](#/docs?doc=verification-bundle) for the full structure.

## Where to go next

- **[Protocol](#/protocol)** — the full technical decision chain, gate by gate.
- **[Trust boundaries](#/docs?doc=trust-boundaries)** — what this build proves, what it does not change, and the exact published reference case.
- **[Attack corpus](#/docs?doc=attack-corpus)** — 25 adversarial cases, each run for real.
