// Epoch manifests (Cashu PR #388 draft, "Epoch Manifests & On-Chain
// Commitments"). Byte-exact to the pinned draft; validated against its
// official test vectors in tests/pol/manifest.test.ts.
//
// Deliberate Phase-1 cut (documented in docs/draft-alignment.md): no
// OpenTimestamps anchoring. The manifest signature/digest chain is fully
// implemented; OTS-receipt validation (draft "Validate OpenTimestamps
// Attestation") is out of scope for the hero mechanism.
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrSignDigest, schnorrVerifyDigest } from '@cashu/cashu-ts';

function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesN(n: number | bigint, byteLen: number): Uint8Array {
  const big = typeof n === 'bigint' ? n : BigInt(n);
  const max = (1n << BigInt(byteLen * 8)) - 1n;
  if (big < 0n || big > max) throw new RangeError(`bytesN: ${big} does not fit in ${byteLen} bytes`);
  const out = new Uint8Array(byteLen);
  let rem = big;
  for (let i = byteLen - 1; i >= 0; i--) {
    out[i] = Number(rem & 0xffn);
    rem >>= 8n;
  }
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

export interface KeysetManifestEntry {
  keyset_id: string;
  unit: string;
  issued_mmr_size: number;
  issued_mmr_root_hash: string; // 64-hex
  issued_mmr_root_sum: number;
  spent_mmr_size: number;
  spent_mmr_root_hash: string; // 64-hex
  spent_mmr_root_sum: number;
  active: boolean;
  deactivation_epoch: number;
}

/** Keyset leaf hash: "Cashu_PoL_Keyset_Leaf_v1" domain + length-prefixed id/unit + MMR state + active + deactivation_epoch. */
export function keysetLeafHash(entry: KeysetManifestEntry): Uint8Array {
  const idBytes = utf8(entry.keyset_id);
  const unitBytes = utf8(entry.unit);
  return sha256(
    concat(
      utf8('Cashu_PoL_Keyset_Leaf_v1'),
      bytesN(idBytes.length, 2),
      idBytes,
      bytesN(unitBytes.length, 2),
      unitBytes,
      bytesN(entry.issued_mmr_size, 8),
      hexToBytes(entry.issued_mmr_root_hash),
      bytesN(entry.issued_mmr_root_sum, 8),
      bytesN(entry.spent_mmr_size, 8),
      hexToBytes(entry.spent_mmr_root_hash),
      bytesN(entry.spent_mmr_root_sum, 8),
      bytesN(entry.active ? 1 : 0, 1),
      bytesN(entry.deactivation_epoch, 8),
    ),
  );
}

function keysetNodeHash(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concat(utf8('Cashu_PoL_Keyset_Node_v1'), left, right));
}

export function emptyKeysetMerkleRoot(): Uint8Array {
  return sha256(utf8('Cashu_PoL_Keyset_Empty_v1'));
}

/**
 * Canonical keyset ordering: lowercase unit (lexicographic by encoded
 * bytes), then lowercase hex keyset_id.
 */
export function sortKeysets(entries: KeysetManifestEntry[]): KeysetManifestEntry[] {
  return [...entries].sort((a, b) => {
    const unitCmp = compareBytes(utf8(a.unit), utf8(b.unit));
    if (unitCmp !== 0) return unitCmp;
    return compareBytes(utf8(a.keyset_id), utf8(b.keyset_id));
  });
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    if (a[i]! !== b[i]!) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** Binary Merkle tree over sorted keyset leaf hashes; odd levels duplicate the final hash. A single leaf is its own root. */
export function keysetMerkleRoot(sortedEntries: KeysetManifestEntry[]): Uint8Array {
  if (sortedEntries.length === 0) return emptyKeysetMerkleRoot();
  let level = sortedEntries.map(keysetLeafHash);
  while (level.length > 1) {
    if (level.length % 2 === 1) level = [...level, level[level.length - 1]!];
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(keysetNodeHash(level[i]!, level[i + 1]!));
    level = next;
  }
  return level[0]!;
}

/** Global digest: "Cashu_PoL_Epoch_v1" domain + previous_global_digest + epoch_index + keyset_count + keyset_merkle_root. */
export function globalDigest(previousGlobalDigestHex: string, epochIndex: number, keysetCount: number, keysetMerkleRootBytes: Uint8Array): Uint8Array {
  return sha256(
    concat(
      utf8('Cashu_PoL_Epoch_v1'),
      hexToBytes(previousGlobalDigestHex),
      bytesN(epochIndex, 8),
      bytesN(keysetCount, 2),
      keysetMerkleRootBytes,
    ),
  );
}

/** The first epoch's previous_global_digest: 32 zero bytes, per the draft's own wording ("32 zero bytes for the first epoch"). */
export const ZERO_DIGEST_HEX = '00'.repeat(32);

export interface ManifestFields {
  keyset_id: string;
  unit: string;
  epoch_index: number;
  timestamp: string; // RFC 3339 UTC, second precision, uppercase Z
  previous_global_digest: string; // hex
  issued_mmr_size: number;
  issued_mmr_root_hash: string;
  issued_mmr_root_sum: number;
  spent_mmr_size: number;
  spent_mmr_root_hash: string;
  spent_mmr_root_sum: number;
  outstanding_balance: number;
  active: boolean;
  deactivation_epoch: number;
}

/** The exact colon-separated UTF-8 string the mint signs (excludes ots_receipt). */
export function manifestMessage(m: ManifestFields): string {
  return [
    m.keyset_id,
    m.unit,
    String(m.epoch_index),
    m.timestamp,
    m.previous_global_digest,
    String(m.issued_mmr_size),
    m.issued_mmr_root_hash,
    String(m.issued_mmr_root_sum),
    String(m.spent_mmr_size),
    m.spent_mmr_root_hash,
    String(m.spent_mmr_root_sum),
    String(m.outstanding_balance),
    m.active ? 'true' : 'false',
    String(m.deactivation_epoch),
  ].join(':');
}

export function signManifest(m: ManifestFields, masterPrivateKeyHex: string): string {
  const digestHex = sha256Hex(manifestMessage(m));
  return schnorrSignDigest(digestHex, masterPrivateKeyHex);
}

export function verifyManifest(m: ManifestFields, signature: string, masterPublicKeyHex: string): boolean {
  try {
    const digestHex = sha256Hex(manifestMessage(m));
    return schnorrVerifyDigest(signature, digestHex, masterPublicKeyHex);
  } catch {
    return false;
  }
}

/** The exact digest that gets Schnorr-signed for a manifest — the canonical "manifest digest" published as Nostr evidence (PRD §12.1). */
export function manifestDigestHex(m: ManifestFields): string {
  return sha256Hex(manifestMessage(m));
}

function sha256Hex(message: string): string {
  return bytesToHex(sha256(utf8(message)));
}
