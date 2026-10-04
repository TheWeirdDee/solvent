# Real Mutinynet Lightning — isolated stack, 2026-10-02

The full SOLVENT visitor flow on a mint whose Lightning is **real**: LDK node on the public Mutinynet test network (Bitcoin signet, 30-second blocks). Real channels, real invoices, real payment settlement observed by the mint's own Lightning backend. Test-network sats only — no monetary value.

This is an **isolated test stack run on a developer machine**, not the public Railway deployment. The public mint at `solvent-production-2029.up.railway.app` still uses fakewallet and was not changed. See "Production cutover" below.

## The stack

| Part | What it is |
|---|---|
| Mint | `cdk-mintd 0.18.1`, CDK commit `a056e0f0f69e94f431b1aeb90d883f18c61ea4c6` with SOLVENT patches `patches/cdk/0001`–`0009`, built with `--features sqlite,ldk-node,fakewallet`. Config: `[payment_backend] backend = "ldk-node"`, `[onchain] onchain_backend = "none"`. Its NUT-04/05 methods are bolt11/bolt12 only; the fakewallet code path is never configured and its log has no fakewallet line |
| Mint identity (NUT-06) | `021a2bacc78528fce971957e37bcd3f16a9d4f032fe4d315290a7bddc51e73e5ed` (a test identity for this stack, not the production one) |
| Mint's Lightning node (LDK) | `022f0c04bc05ba44f0ddd99980115a70b8166d78b1c02ae25ed698ed781cd79837` — announced channel to the faucet's node `02465ed5be53d04fde66c9418ff14a5f2267723810176c9212b722e542dc1afb1b` ("Faucet LND", 300,000 sats, opened by the mint with 150,000 pushed so it can receive) |
| Payer node (LDK) | `023ec681702726a474b07c8ae458f3bc482028f2e09ef59546088f1875218270db` — a separate Lightning node standing in for a visitor's wallet. It pays the invoice the page shows. Channel to Faucet LND (300,000 sats); the first payment was routed through Faucet LND (1 sat routing fee) |
| Chain source | `tcp://electrum.mutinynet.com:50001` (the Esplora API was too unreliable from this network for a wallet scan) |
| Evidence service | `src/sidecar` from this commit, `lightning_backend=ldk-node`, publishing kind 8181 to the current public relays |
| Reserve | the published test reserve `598bfed24044ea8b37bf79d0719afcebb87a8767f91c73dc37a36f17214c58fb:0` (1,000,000 sats, `evidence/reserves/reserve-key.json`) — not the production reserve |
| Funding | 900,000 Mutinynet test sats from the public faucet (`faucet.mutinynet.com`) |

## The runs

`npm run verify:real-mint:browser -- <local build> http://127.0.0.1:8095 http://127.0.0.1:8096 --swap [--melt] --pay-ldk http://127.0.0.1:8107 --evidence-out <file>`

| Run | Browser | Checks | What it shows |
|---|---|---|---|
| [run1](runs/run1-chromium-1363.json) | Chromium 1363×936 | 39/39 | paid NUT-04 → `ACCEPT_VERIFIED`, accept once; live NUT-03 swap verified; broken promise → `REFUSE_ISSUANCE_OMITTED`; relay outage → retry of the same issuance → ACCEPT |
| [run2](runs/run2-chromium-390.json) | Chromium 390×844 | 39/39 | the same |
| [run3](runs/run3-webkit-390.json) | WebKit 390×844 | 39/39 | the same |
| [run4](runs/run4-chromium-1363-after-restart.json) | Chromium 1363×936 | 39/39 | the same, **after a restart** of the mint and its evidence service |
| [run5](runs/run5-chromium-1363-swap-melt.json) | Chromium 1363×936 | 43/43 | plus a **real NUT-05 payment** with the swapped ecash |
| [run6](runs/run6-webkit-390-swap-melt.json) | WebKit 390×844 | 43/43 | plus a real NUT-05 payment |

Each run file records the invoices and their payment hashes, the decisions, the evidence rows the page showed (epoch, manifest digest, Nostr event id, relays, reserve), the acceptance counts, the swap (NUT-07 states, the operation's rows, liability before/after) and, for runs 5–6, the payment (invoice, preimage, inputs, change, fee, liability before/after). Logs are in [`logs/`](logs/).

### Real Lightning, every issuance

Every NUT-04 issuance (honest, broken promise and the outage case; 18 in all) was paid by the payer node over Mutinynet Lightning before the mint signed anything; the mint learned of each payment only from its own LDK node (`mint quote payment notification committed`). The harness fails a run if the payer node reports a payment error.

### The swap (NUT-03)

The browser sends the accepted 64-sat proof to the mint's `/v1/swap` with four outputs it built itself (32 + 16 + 8 + 8). Checked inside the browser and again from Node:

- NUT-07 from the mint: original `SPENT`, all four replacements `UNSPENT`;
- the old proof is in the epoch's signed **spent** sum-MMR (`GET /v1/solvent/spend/<Y>`), under the manifest key the NUT-06 identity delegated;
- the operation's rows consumed exactly that proof and issued exactly the four outputs; each has a signed receipt and is in the same epoch's **issued** sum-MMR;
- the operation conserves value (issued − consumed = 0), and the signed outstanding liability is unchanged (run 5: 576 → 576);
- one replacement proof then passes the full SOLVENT verification on its own (`ACCEPT_VERIFIED`).

### The payment (NUT-05), runs 5–6

The browser gets a 40-sat invoice from the public Mutinynet faucet (through the evidence service, which serves faucet invoices only on a real-Lightning mint) and melts the four swapped proofs (64 sats). Run 5:

- invoice payment hash `a269f9fbdf03233bf5c722030d14c68e10a128346731bce1a41c55f15b1c191e`; the mint returned preimage `8bef10f6ccee811f52356acdf034f9e0232bbc7583b84291765f2cd9496e8c99`, and sha256(preimage) equals that hash (recomputed outside the app);
- inputs 32 + 16 + 8 + 8 `SPENT`; change 16 + 8 `UNSPENT`;
- consumed 64 = paid 40 + fee 0 + change 24; the change rows are exactly the change received, each committed in the issued sum-MMR;
- signed outstanding liability 576 → 536: down by exactly what was paid.

### Restart

[`restart-before.json`](restart-before.json) and [`restart-after.json`](restart-after.json): after stopping and starting the mint and its evidence service, the NUT-06 identity, the LDK node id, both channels, the open epoch, the last publication and the earlier swap's spent-side evidence are all unchanged; run 4 then mints, swaps and refuses normally.

## What this does not show

- It is not the public deployment. Visitors to the public site still get fakewallet issuance until the production cutover below is done.
- The payer node pays on the visitor's behalf in these runs. On a real-Lightning public mint a judge would pay the invoice from their own Mutinynet wallet or the faucet's Lightning page.
- The mint ran behind NAT on a developer machine; it opened its channel outbound, so nothing had to connect to it.

## Production cutover (proposed, not done)

What would change on Railway, with nothing destructive:

1. **Image:** build `cdk-mintd` with `--features sqlite,lnd,ldk-node,fakewallet` (the same commit and patches).
2. **Config:** `[payment_backend] backend = "ldk-node"`, an `[ldk_node]` section (signet, Electrum `tcp://electrum.mutinynet.com:50001`, P2P gossip, storage under `/data/ldk-node`). The mint's own seed is unchanged, so its NUT-06 identity and keysets are unchanged.
3. **One new secret:** `CDK_MINTD_LDK_NODE_MNEMONIC` (the Lightning node's seed), backed up before first start.
4. **Evidence service:** this commit's sidecar (spend evidence, faucet invoices) with `SOLVENT_LIGHTNING_BACKEND=ldk-node`, `SOLVENT_DEMO_FAUCET_INVOICES=1`.
5. **Funding:** send Mutinynet test sats to the new node and open a channel to Faucet LND with some balance pushed, exactly as here.

Kept as they are: the `/data` volume and its database, the mint identity, the manifest and reserve keys, the reserve outpoint, the domains.
