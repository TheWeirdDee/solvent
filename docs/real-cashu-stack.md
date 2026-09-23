# The real Cashu stack (Phase 1)

## Topology

```
Bitcoin Core (regtest)
   │
   ├── LND-1 ("Lightning source node" — the CDK mint's real payment backend)
   │       │
   │       └── cdk-mintd (backend = "lnd", pointed at LND-1)
   │
   └── LND-2 ("Lightning destination node" — sender + melt destination)

Sender wallet (@cashu/cashu-ts Wallet, own proof store)
   ↓ real NUT-04 mint (paid via LND-2 -> LND-1 -> mint)
cdk-mintd
   ↓ real NUT-03 swap
Receiver wallet (@cashu/cashu-ts Wallet, own proof store)
   ↓ real NUT-05 melt (paid via mint -> LND-1 -> LND-2)
LND-2 (destination invoice, independently created and independently confirmed settled)
```

One real mint, two real Lightning nodes, one real Bitcoin regtest chain — the smallest stack that still proves every required real transition (see `docs/REALITY-MAP.md`). See `docs/dependencies.md` for exactly why LND (not CLN) was chosen for both Lightning nodes, and why direct binary downloads (not Docker, not Nix) drive this specific workflow.

## Why this environment could not run directly on this project's own development machine

The development machine this phase was built on has `cargo`/Rust, but no Docker, no `bitcoind`, no `lnd`, no `cln` installed, and no WSL2 distribution set up (`wsl --status` reports WSL2 is available but zero distributions are installed). Rather than lower the engineering target to something that machine happens to already have (i.e. CDK's `fakewallet` backend), this phase built the real stack as a **reproducible GitHub Actions workflow** (`.github/workflows/real-cashu-integration.yml`) targeting a standard `ubuntu-latest` runner, where every one of Bitcoin Core, LND, and CDK publishes ready-to-run prebuilt Linux x86_64 binaries — no compilation, no Docker, no Nix required. See `docs/reproduce-real-stack.md` for running the exact same sequence yourself, including on a Linux machine or inside WSL2.

## What the workflow actually does, step by step

1. **Download + checksum-verify** `bitcoind`/`bitcoin-cli` (from bitcoincore.org's own published `SHA256SUMS`), `lnd`/`lncli` (from LND's own published release manifest), and `cdk-mintd`/`cdk-cli` (from CDK's own published `SHA256SUMS`). Exact pinned versions: `docs/dependencies.md`.
2. **Start Bitcoin Core regtest**, create a wallet, mine 110 blocks to a fresh address (enough for one coinbase output to mature, with headroom).
3. **Start LND-1 and LND-2**, each pointed at the same regtest `bitcoind` via RPC + ZMQ block/tx notifications, each with its own `lnddir`/RPC/REST/P2P ports. `--noseedbackup` is used deliberately — this is throwaway regtest key material controlling zero real-world value, and the interactive seed-backup confirmation flow has no purpose in an automated, disposable CI run.
4. **Fund LND-2 and open a real channel LND-2 → LND-1**: mine coins to LND-2's own regtest wallet address, mature the coinbase (100 confirmations), connect the two nodes as Lightning peers, open a channel, mine 6 confirmations, poll until the channel reports `active: true` on both sides.
5. **Start `cdk-mintd`** with `[payment_backend] backend = "lnd"` pointed at LND-1's real gRPC address, TLS cert, and macaroon (see `crates/cdk-mintd/example.config.toml` in the pinned CDK release for the exact config shape) — explicitly **not** `fakewallet`. Poll `/v1/info` until the mint reports healthy.
6. **Run `npm run verify:cashu-real`** (`src/cli/real-cashu/real-cashu-foundation.ts`) against the now-live mint URL and both LND nodes' REST APIs — checks R1-R11: a real Lightning payment, real NUT-04 issuance, real NUT-03 swap, real NUT-07 state transitions, real double-spend rejection, and a real NUT-05 melt to an independently-confirmed destination invoice.
7. **Kill and restart the `cdk-mintd` process** against the SAME `--work-dir`/on-disk SQLite database, then **run `npm run verify:cashu-real:restart`** (`src/cli/real-cashu/real-cashu-restart-check.ts`) — checks R12/R13: the already-spent proofs from step 6 are re-queried in a fresh process and must still report SPENT, and a fresh double-spend attempt against them must still be refused. This is what actually distinguishes durable on-disk state from an in-memory artifact a restart would silently reset.
8. **Collect logs and evidence** (`evidence/real-cashu/<run-id>/` and `evidence/real-cashu/<run-id>-restart/`, plus each process's own log file) and **upload them as a workflow artifact**, `if: always()` — evidence is captured whether the run passed or failed, so a failure is debuggable from the artifact alone.

Nothing in this sequence has a fallback that reports success without the real stack actually running — a failure at any step stops the job before the steps after it (GitHub Actions' default behavior; no step uses `continue-on-error`). Confirmed by real execution: [run 35853398175](https://github.com/TheWeirdDee/solvent/actions/runs/35853398175) (2026-09-23) ran every step above for real and passed.

## The one thing this phase deliberately does NOT do

Connect any of this to SOLVENT's own PoL protocol (signed receipts, epoch manifests, Nostr publication, reserve attestation). See `DECISIONS.md`'s "Why SOLVENT is not yet connected" and `docs/REALITY-MAP.md`. That is Phase 2's explicit, separately-reviewed scope.
