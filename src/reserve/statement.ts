// Gate 6 — the canonical reserve statement (PRD §11.2's "acceptable bounded
// implementation", chosen over full BIP-322 — see DECISIONS.md for why).
//
// Two separate signatures, both plain BIP-340 Schnorr over a sha256 digest
// (the same primitive already used for PoL receipts/manifests):
//   1. the reserve statement is signed by the Taproot key-path secret that
//      actually controls the on-chain output (§11.2 item 2 — "a standard
//      message-signing mechanism supported for the script type": for a
//      P2TR key-path output, that mechanism IS a BIP-340 Schnorr signature
//      from the tweaked output key, per BIP-341);
//   2. the mint's manifest master key separately signs a binding message
//      over (reserve_pubkey, statement digest) (§11.2 item 3), so the
//      reserve key and the mint's already-established Cashu identity are
//      cryptographically linked, not just asserted.
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrSignDigest, schnorrVerifyDigest } from '@cashu/cashu-ts';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function sha256Hex(s: string): string {
  return Array.from(sha256(utf8(s)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface ReserveOutpoint {
  txid: string; // 64-hex, big-endian display order (as returned by esplora)
  vout: number;
  value_sats: number;
  script_pubkey_hex: string;
}

export interface ReserveStatement {
  network: string; // human-readable + precise, e.g. "bitcoin-signet-mutinynet" — see docs/reserve-attestation.md
  reserve_pubkey: string; // x-only tweaked Taproot output pubkey, 64-hex
  outpoints: ReserveOutpoint[];
  timestamp: string; // RFC 3339 UTC
  block_height: number; // chain tip height at attestation time
}

function sortOutpoints(outpoints: ReserveOutpoint[]): ReserveOutpoint[] {
  return [...outpoints].sort((a, b) => (a.txid === b.txid ? a.vout - b.vout : a.txid < b.txid ? -1 : 1));
}

/** The exact message the reserve key signs. Domain-separated, deterministic outpoint ordering. */
export function reserveStatementMessage(s: ReserveStatement): string {
  const outpointsPart = sortOutpoints(s.outpoints)
    .map((o) => `${o.txid}:${o.vout}:${o.value_sats}:${o.script_pubkey_hex}`)
    .join(',');
  return ['Solvent_Reserve_Statement_v1', s.network, s.reserve_pubkey, s.timestamp, String(s.block_height), outpointsPart].join(':');
}

export function reserveStatementDigestHex(s: ReserveStatement): string {
  return sha256Hex(reserveStatementMessage(s));
}

/** Signed with the TAPROOT-TWEAKED private key (see src/reserve/taproot.ts) — the key that actually authorizes spending the declared outputs. */
export function signReserveStatement(s: ReserveStatement, tweakedPrivateKeyHex: string): string {
  return schnorrSignDigest(reserveStatementDigestHex(s), tweakedPrivateKeyHex);
}

export function verifyReserveStatementSignature(s: ReserveStatement, signature: string): boolean {
  try {
    return schnorrVerifyDigest(signature, reserveStatementDigestHex(s), s.reserve_pubkey);
  } catch {
    return false;
  }
}

/** The exact message the mint's manifest master key signs, binding the reserve public key to a specific statement. */
export function reserveBindingMessage(reservePubkeyHex: string, statementDigestHex: string): string {
  return ['Solvent_Reserve_Binding_v1', reservePubkeyHex, statementDigestHex].join(':');
}

export function signReserveBinding(reservePubkeyHex: string, statementDigestHex: string, masterPrivateKeyHex: string): string {
  const digestHex = sha256Hex(reserveBindingMessage(reservePubkeyHex, statementDigestHex));
  return schnorrSignDigest(digestHex, masterPrivateKeyHex);
}

export function verifyReserveBinding(reservePubkeyHex: string, statementDigestHex: string, signature: string, masterPublicKeyHex: string): boolean {
  try {
    const digestHex = sha256Hex(reserveBindingMessage(reservePubkeyHex, statementDigestHex));
    return schnorrVerifyDigest(signature, digestHex, masterPublicKeyHex);
  } catch {
    return false;
  }
}
