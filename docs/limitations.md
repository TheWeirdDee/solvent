# Limitations — Phase 1

Explicit, not implied. See `docs/REALITY-MAP.md` for the full real/simulated table.

## What Phase 1 does NOT prove

- **SOLVENT's PoL protocol is still not connected to any real mint.** Signed receipts, epoch manifests, sum-MMR inclusion proofs, reserve attestations, and Nostr publication are all still produced by SOLVENT's own code against SOLVENT's own freshly-generated identity — exactly as before Phase 1. CDK does not implement Cashu PR #388 (the draft this protocol is built on); no real mint does, today. Phase 2's explicit job.
- **Not evaluated by SOLVENT's verifier.** Phase 1's real proofs/swaps/melts are never passed through `verify()`/`verifySubmission()`. The two systems run side by side, not together, this phase.
- **Real execution is not yet confirmed in this specific run.** Everything in `src/cli/real-cashu/` typechecks cleanly against the real, installed `@cashu/cashu-ts` v4.10.2 types (strong evidence the API usage is shaped correctly), and every binary/version/config-key referenced in the workflow was independently looked up from the real upstream source (CDK's own `example.config.toml`, LND's and Bitcoin Core's own release pages) rather than guessed — but the development environment this phase was built in has no Docker, no `bitcoind`, no `lnd`, and no WSL2 distribution, so the full regtest stack could not be executed end-to-end locally. See `DECISIONS.md`'s Phase 1 entry and the final report for the exact, honest verdict this produced.
- **Regtest, not mainnet.** Every coin involved is worthless by construction. No real-world Bitcoin, no real-world Lightning liquidity, at any point.
- **Single mint, single Lightning topology.** One `cdk-mintd`, two `lnd` nodes. CDK's own regtest environment exercises a larger topology (2 CLN + 2 LND + 2 mints); Phase 1 deliberately used the smallest stack that still proves every required transition (see `docs/dependencies.md`).
- **No CLN.** LND was used for both Lightning nodes specifically because it publishes Windows binaries and CLN does not — a decision driven by this project's own development environment, not a statement that CLN is less real or less suitable.

## What carries over unchanged, and remains real

Everything documented in `docs/trust-boundaries.md` from before this phase: real DLEQ/BIP-340 verification, real live Bitcoin Signet reserve queries, real live public Nostr relay publish/fetch, the real Gate 4 acceptance-boundary spy, the full 25/25 attack corpus, 264/264 deterministic tests, and the automated GitHub Pages deployment refresh. None of it was touched, weakened, or gutted by this phase — see "Preserve the existing verifier" in the Phase 1 instructions this document was written to satisfy, and `DECISIONS.md`.
