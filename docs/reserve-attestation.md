# Reserve attestation (Gate 6)

Source: `src/reserve/taproot.ts`, `src/reserve/statement.ts`, `src/reserve/evaluate.ts`, `src/reserve/esplora.ts`, `src/reserve/fetch-and-evaluate.ts`.

## Why not full BIP-322

PRD §11.2 prefers a BIP-322 message/proof-of-funds-compatible proof "if current libraries make it reliable within the build window," and explicitly sanctions a bounded alternative otherwise. Full BIP-322 support across arbitrary script types in the current JS ecosystem was judged, within this session's time budget, to be a real correctness risk to hand-verify from scratch — so this build uses the PRD's own bounded alternative (§11.2 items 1-5) instead, implemented in full. **Nothing in this codebase is labeled "BIP-322."**

## Network

**Bitcoin Signet via Mutinynet** (`https://mutinynet.com`), address-network label `bitcoin-signet-mutinynet` everywhere (address derivation, statement `network` field, evidence files, CLI output). Mutinynet is genuinely Signet — same consensus mechanism, a different signing challenge tuned for ~30 second blocks instead of the default public signet's ~10 minutes. It was chosen specifically because real on-chain confirmation (and, if pursued, a real "spent after attestation" negative case) needs to be achievable within a single working session; the default public signet's block time makes that impractical to reproduce on demand. This is never mainnet, and is never referred to as such.

## The reserve key and address

`generateSignetReserveKey()` (`src/reserve/taproot.ts`) generates a real secp256k1 keypair and derives a **P2TR (Taproot), key-path-only** address using `@scure/btc-signer` — an audited, purpose-built Bitcoin transaction library (added as a new dependency specifically for this gate), not hand-rolled elliptic-curve point arithmetic. The address's actual on-chain spending key is the **BIP-341-tweaked** private key (`taprootTweakPrivKey`), not the raw internal key — this matters because Taproot's output key is `Q = P + tagged_hash("TapTweak", P)·G`, and only the tweaked key can authorize spending the real output.

`npm run gate6` persists this key at `evidence/reserves/reserve-key.json` (marked with an explicit `_warning` field) so the same address survives across runs — a human can fund it once and re-run to pick up the result, rather than every run generating a throwaway address nobody could ever fund in time. **This is a Signet-only test key controlling zero-value coins; it must never be reused for anything of real value.**

## The reserve statement

```ts
{
  network: string;             // 'bitcoin-signet-mutinynet'
  reserve_pubkey: string;      // x-only TWEAKED output pubkey, 64-hex — this is what's actually on-chain
  outpoints: { txid, vout, value_sats, script_pubkey_hex }[];
  timestamp: string;           // RFC 3339 UTC
  block_height: number;        // chain tip height at attestation time
}
```

Matches PRD §11.2 item 1 exactly: network, outpoints, values, scriptPubKeys, timestamp/height, and the reserve public key.

## Two signatures (PRD §11.2 items 2-3)

1. **The reserve statement itself** is signed with the Taproot-tweaked private key — a real BIP-340 Schnorr signature from the key that actually controls the declared UTXO(s). For a P2TR key-path output, a Schnorr signature from that exact key *is* the standard authorization mechanism for that script type, which is what PRD §11.2 item 2 asks for ("a standard message-signing mechanism supported for the script type").
2. **A separate binding signature**, from the mint's own manifest master key, over `(reserve_pubkey, statement_digest)` — cryptographically linking the reserve key to the mint's already-established Cashu identity, so a reserve statement can't just be any Bitcoin UTXO someone happens to control.

Both use the same `schnorrSignDigest`/`schnorrVerifyDigest` primitive (`@cashu/cashu-ts`) used everywhere else in this codebase (PoL receipts, epoch manifests) — confirmed cross-library-compatible with `@scure/btc-signer`'s key derivation during development (signing with the tweaked key via either library's Schnorr implementation verifies against the real on-chain output pubkey).

## Independent verification (`evaluateReserveAttestation`, checks 11-13 of the PRD §14 decision rule)

Given a chain-state snapshot (real, from `fetchChainState()` querying a public Esplora API — never trusted from the statement's own claims):

1. **Structural validity** — non-empty outpoints, well-formed pubkey/height, or `REFUSE_RESERVE_ATTESTATION_INVALID`.
2. **Reserve-key signature** verifies over the statement digest, or `REFUSE_RESERVE_ATTESTATION_INVALID`.
3. **Master-key binding signature** verifies over `(reserve_pubkey, statement_digest)`, or `REFUSE_RESERVE_ATTESTATION_INVALID`.
4. **Staleness** — `current_tip_height - statement.block_height` must be within a **network-aware** generous bound (`maxAttestationAgeBlocks(network)` / `RESERVE_FRESHNESS_POLICY` in `src/reserve/evaluate.ts`), or `REFUSE_RESERVE_ATTESTATION_INVALID`. The underlying intent is a real ~1 week of wall-clock freshness (`targetSeconds = 7 * 24 * 3600`), sized to a block budget per network's real block cadence — 1008 blocks on mainnet/default-signet's ~10-minute blocks, ~19,830 blocks on Mutinynet's empirically-measured ~30.5s blocks. A flat 1008-block constant (this build's earlier implementation) silently enforced only ~8.5 hours on Mutinynet — a real bug, since block count isn't a portable unit across networks with different cadences — fixed by making the budget a function of `statement.network` rather than a magic number. See `docs/trust-boundaries.md`'s "Effective expiry" section for the full derivation and how this was caught.
5. **Per-outpoint independent re-query**: existence (`REFUSE_RESERVE_STATE_MISMATCH` if not found — the "wrong UTXO" case), spent status (`REFUSE_RESERVE_UTXO_SPENT`), and value/scriptPubKey exactly matching the statement's claim (`REFUSE_RESERVE_STATE_MISMATCH` — the "amount mismatch" case).
6. **Coverage** — the sum of independently-verified unspent outpoint values must be `>= outstanding_balance`, or `REFUSE_RESERVE_SHORT`.

This maps every one of PRD §11.1's required properties onto the four reserve reason codes already defined in `src/verifier/reasons.ts` — see `ATTACKS.md`'s notes section for the exact mapping and why there is no separate "stale reserve" code (freshness is subsumed by always live-re-querying current spent status, rather than trusting a snapshot).

## The funded UTXO

The entire mechanism above is real and fully tested end-to-end (`tests/reserve/evaluate.test.ts`, `tests/verifier/verify-reserve-integration.test.ts`), and the derived address is funded with a real Signet transaction — `npm run gate6` re-queries that real UTXO on every run, and `evidence/reserves/cases.json`'s `live_verified` is `true`. See the Gate 6 entries in `DECISIONS.md` for the funding history, and `docs/trust-boundaries.md` for what "real" means for this gate.
