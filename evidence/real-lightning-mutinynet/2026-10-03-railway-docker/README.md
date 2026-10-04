# Railway-shaped Linux container gate — real Mutinynet Lightning, 2026-10-03

The cutover gate for running SOLVENT's public mint on **real Mutinynet Lightning** (LDK node inside `cdk-mintd`). It uses the exact image Railway would build (`deploy/railway/Dockerfile`, from a Git-visible copy of this working tree), in a Linux container, with all state on one volume mounted at `/data` (as Railway's volume), started by the same `solvent-railway-start`. Test-network sats only — no monetary value. **Production was not touched.**

## The image

[`image-facts.txt`](image-facts.txt):

| | |
|---|---|
| Build | `docker build -f deploy/railway/Dockerfile` (Docker 29.1.3, WSL2 Ubuntu 24.04, x86_64) |
| Base images | `rust:1-bookworm@sha256:59037199…` (build), `node:24-bookworm-slim@sha256:0e0ff40c…` (runtime) |
| Rust | 1.97.1 (CDK's pinned toolchain), target `x86_64-unknown-linux-gnu` |
| CDK | `a056e0f0f69e94f431b1aeb90d883f18c61ea4c6` + `patches/cdk/0001`–`0009` |
| Features | `sqlite,lnd,ldk-node,fakewallet` |
| Binary | `cdk-mintd 0.18.1`, 70,184,784 bytes, linux/amd64 |
| Image | 789 MB, `sha256:d900bfb4…` |
| Build time | 3,555 s total (Rust compile 32 m 59 s) on an 8-vCPU / 3.8 GB WSL2 VM |

The binary validates `deploy/mint.ldk-node.toml` and `deploy/mint.fakewallet.toml`, and rejects a `cln` document (not compiled in) — so `ldk-node` is really in it.

## The state migrated into `/data`

The isolated stack's mint ([`../2026-10-02/`](../2026-10-02/)) was stopped and its files copied into the volume: the mint database (`cdk-mintd.sqlite` + `-wal`/`-shm`), `delegation.json`, the publication and omission stores, and the LDK node's single database `ldk-node/ldk_node_data.sqlite`. The first container start used `SOLVENT_APPLY_MINT_CONFIG=1` once, to switch the database-backed config to the Linux LDK document. Same NUT-06 identity (`021a2bac…`), same keyset, same LDK node (`022f0c04…`), both channels reconnected.

## Runs ([`runs/`](runs/), [`logs/`](logs/))

| Run | Browser | Checks | Honest NUT-04 → ACCEPT | Swap | Melt (liability) | Broken promise |
|---|---|---|---|---|---|---|
| cycle1 | Chromium 1363 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED | VERIFIED (752 → 712) | `REFUSE_ISSUANCE_OMITTED` |
| cycle2 | Chromium 390 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED | VERIFIED (840 → 800) | `REFUSE_ISSUANCE_OMITTED` |
| cycle3 | WebKit 390 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED | VERIFIED (952 → 912) | `REFUSE_ISSUANCE_OMITTED` |
| after-restart | Chromium 1363 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED | VERIFIED (1040 → 1000) | `REFUSE_ISSUANCE_OMITTED` |
| after-crash | Chromium 1363 | 40/40 (no outage case) | `ACCEPT_VERIFIED` | VERIFIED | VERIFIED (1128 → 1088) | `REFUSE_ISSUANCE_OMITTED` |
| cycle4-public-route | Chromium 1363 | 43/43 | `ACCEPT_VERIFIED` | VERIFIED | VERIFIED (1176 → 1136) | `REFUSE_ISSUANCE_OMITTED` |

Every run records `lightning_backend: ldk-node`; the container log has no fakewallet line. Every invoice was paid by a separate Lightning node (standing in for the visitor) and the mint issued only after its own node saw the payment settle. Every melt paid a real 40-sat Mutinynet faucet invoice; the liability fell by exactly 40 each time.

Read these honestly:

- **Route.** In cycles 1–3, after-restart and after-crash the payer reached the mint over a direct channel the two test nodes had (fee 0) — real Lightning settlement, but not across the public network. That channel was then closed cooperatively and **cycle4-public-route** paid all three invoices through the public node Faucet LND (fee 1 sat each), which is how a visitor's payment arrives.
- **cycle3** passed on its second attempt; the first attempt passed every gate step, then the harness timed out waiting for the invoice in the simulated-outage case (WebKit). The rerun passed 43/43.
- **cycle4** passed on its second attempt; the first failed one payment with `RouteNotFound` because the *test payer* kept dropping its connection to Faucet LND (it holds a stuck, never-funded duplicate channel). The harness now retries a no-route payment, as a wallet would.

## Restart and crash ([`state/`](state/))

| | Container exit | Mint/API ready | Both channels active | Identity, keyset, node, channels, epochs, publications, earlier spent evidence | Re-derivation audit |
|---|---|---|---|---|---|
| `docker stop` → new container from the volume | 0 (SIGTERM) | 10 s | 64 s | unchanged | 45/45 closed epochs re-derive, 0 failures |
| `docker kill -s KILL` → new container | 137 (SIGKILL) | 3 s | 51 s | unchanged | 50/50 closed epochs re-derive, 0 failures |

No force-close, no corruption lines. The after-restart and after-crash runs above then minted, swapped, melted and refused normally.

## Resources ([`resource-summary.txt`](resource-summary.txt), [`container-stats.txt`](container-stats.txt))

Whole container (cdk-mintd with its LDK node + the Node.js evidence service), sampled every ~3 s across all runs: **peak 237.6 MiB**, normal ~140–195 MiB, idle CPU ~0.8 %, CPU peaks 84–134 % of one core during start-up sync. `/data` grew from 4.9 MB to 5.9 MB (LDK directory 176 KB → 805 KB, mostly its log).

## Operational finding

Faucet LND (LND) marks its side of the channel **disabled** after the mint has been offline ~20 minutes, and re-enables it only after ~19 minutes of stable connection; while disabled, visitors' payments cannot reach the mint (observed: disabled 05:54:55Z after the migration downtime, re-enabled 06:48:02Z). Short restarts (seconds) do not trigger it.

## Judge pay box

[`paybox-390-waiting.jpg`](paybox-390-waiting.jpg): the invoice as a visitor sees it at 390 px — amount, expiry countdown, status, invoice with Copy, and the no-wallet instruction. No horizontal overflow.
