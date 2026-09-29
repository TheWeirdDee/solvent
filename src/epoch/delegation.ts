// SOLVENT Phase 3B — mint identity -> manifest key delegation (verifier side).
//
// A Cashu mint's identity is the public key it advertises in NUT-06
// (`/v1/info` `pubkey`): the BIP32 master key of its signatory seed. Patch
// patches/cdk/0008 lets the mint's signatory sign exactly one kind of
// statement with that key — a delegation authorizing a SOLVENT manifest
// key. This module rebuilds the delegation's signed bytes identically to
// the Rust encoder (`manifest_key_delegation_message`) and verifies the
// chain:
//
//   NUT-06 compressed identity -> x-only BIP-340 key -> delegation
//   signature -> authorized manifest key -> epoch manifest signature
//
// A manifest is never accepted merely because its own signature is valid.
// Encoding and audit: docs/manifest-key-delegation.md.
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorr, secp256k1 } from '@noble/curves/secp256k1.js';
import { verifyManifest, type ManifestFields } from '../pol/manifest.js';

export const MANIFEST_KEY_DELEGATION_SCHEMA = 'solvent/manifest-key-delegation/v1';

export interface ManifestKeyDelegation {
  schema: string;
  mint_url: string;
  /** 33-byte compressed SEC1 hex — must equal the mint's NUT-06 `pubkey`. */
  mint_identity_pubkey: string;
  /** Optional convenience copy; when present it must equal the x-only form of mint_identity_pubkey. */
  mint_identity_xonly_pubkey?: string;
  /** 33-byte compressed SEC1 hex. */
  manifest_pubkey: string;
  valid_from_epoch: number;
  created_at: number;
  /** 64-byte BIP-340 signature hex over SHA256(delegationMessage). */
  signature: string;
}

export type DelegationFailure =
  | 'DELEGATION_MALFORMED'
  | 'DELEGATION_SCHEMA'
  | 'DELEGATION_BAD_IDENTITY_KEY'
  | 'DELEGATION_BAD_MANIFEST_KEY'
  | 'DELEGATION_MINT_MISMATCH'
  | 'DELEGATION_IDENTITY_MISMATCH'
  | 'DELEGATION_XONLY_MISMATCH'
  | 'DELEGATION_SIGNATURE_INVALID'
  | 'DELEGATION_MANIFEST_KEY_MISMATCH'
  | 'DELEGATION_EPOCH_OUT_OF_SCOPE'
  | 'MANIFEST_SIGNATURE_INVALID';

export type DelegationResult = { ok: true } | { ok: false; reason: DelegationFailure; detail: string };

const HEX = /^[0-9a-f]*$/;

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Strict: 33-byte compressed SEC1 on the curve, lowercase hex. Returns the bytes or null. */
export function parseCompressedPubkey(hex: unknown): Uint8Array | null {
  if (typeof hex !== 'string' || hex.length !== 66 || !HEX.test(hex) || !(hex.startsWith('02') || hex.startsWith('03'))) return null;
  const bytes = hexBytes(hex);
  try {
    secp256k1.Point.fromBytes(bytes);
    return bytes;
  } catch {
    return null;
  }
}

/** The BIP-340 authority for a NUT-06 compressed identity: its 32-byte x coordinate. */
export function xOnlyFromCompressed(compressedHex: string): string {
  const bytes = parseCompressedPubkey(compressedHex);
  if (!bytes) throw new Error('not a compressed secp256k1 public key');
  return toHex(bytes.slice(1));
}

function u16(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff]);
}

function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`not a u64-safe integer: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

/**
 * The exact bytes the mint identity signs — byte-identical to patch 0008's
 * `manifest_key_delegation_message`:
 *   u16be(len schema) || schema || u16be(len mint_url) || mint_url ||
 *   identity (33) || manifest (33) || u64be(valid_from_epoch) || u64be(created_at)
 */
export function delegationMessage(d: Pick<ManifestKeyDelegation, 'mint_url' | 'mint_identity_pubkey' | 'manifest_pubkey' | 'valid_from_epoch' | 'created_at'>): Uint8Array {
  const identity = parseCompressedPubkey(d.mint_identity_pubkey);
  const manifest = parseCompressedPubkey(d.manifest_pubkey);
  if (!identity || !manifest) throw new Error('delegation keys must be compressed secp256k1 public keys');
  const schema = new TextEncoder().encode(MANIFEST_KEY_DELEGATION_SCHEMA);
  const url = new TextEncoder().encode(d.mint_url);
  if (url.length === 0 || url.length > 0xffff) throw new Error('mint_url length out of range');
  const parts = [u16(schema.length), schema, u16(url.length), url, identity, manifest, u64(d.valid_from_epoch), u64(d.created_at)];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/**
 * The delegation's public reference: SHA256 of exactly the canonical bytes
 * the mint identity signed (delegationMessage) — the same digest BIP-340
 * signs, so it names the authorization itself without a second encoding.
 * A closed epoch's public evidence commits to it.
 */
export function delegationDigestHex(d: Pick<ManifestKeyDelegation, 'mint_url' | 'mint_identity_pubkey' | 'manifest_pubkey' | 'valid_from_epoch' | 'created_at'>): string {
  return toHex(sha256(delegationMessage(d)));
}

const fail = (reason: DelegationFailure, detail: string): DelegationResult => ({ ok: false, reason, detail });

export interface DelegationExpectations {
  /** The mint URL the wallet is talking to. */
  mintUrl: string;
  /** The compressed `pubkey` from that mint's own NUT-06 `/v1/info`. */
  mintIdentityPubkey: string;
  /** The key that signed the manifest being checked. */
  manifestPubkey: string;
  /** The epoch of the manifest being checked. */
  epochIndex: number;
}

/**
 * Verifies that `d` is a delegation, signed by the mint's NUT-06 identity,
 * authorizing `expect.manifestPubkey` for `expect.epochIndex`.
 */
export function verifyManifestKeyDelegation(d: ManifestKeyDelegation, expect: DelegationExpectations): DelegationResult {
  if (!d || typeof d !== 'object') return fail('DELEGATION_MALFORMED', 'not an object');
  if (d.schema !== MANIFEST_KEY_DELEGATION_SCHEMA) return fail('DELEGATION_SCHEMA', `unexpected schema ${String(d.schema)}`);
  if (typeof d.mint_url !== 'string' || !/^https?:\/\//.test(d.mint_url)) return fail('DELEGATION_MALFORMED', 'mint_url must be an http(s) URL');
  if (!Number.isSafeInteger(d.valid_from_epoch) || d.valid_from_epoch < 1) return fail('DELEGATION_MALFORMED', 'valid_from_epoch must be an integer >= 1');
  if (!Number.isSafeInteger(d.created_at) || d.created_at < 1) return fail('DELEGATION_MALFORMED', 'created_at must be a positive integer');
  if (typeof d.signature !== 'string' || d.signature.length !== 128 || !HEX.test(d.signature)) return fail('DELEGATION_MALFORMED', 'signature must be 64 bytes of lowercase hex');

  const identity = parseCompressedPubkey(d.mint_identity_pubkey);
  if (!identity) return fail('DELEGATION_BAD_IDENTITY_KEY', 'mint_identity_pubkey is not a compressed secp256k1 key');
  if (!parseCompressedPubkey(d.manifest_pubkey)) return fail('DELEGATION_BAD_MANIFEST_KEY', 'manifest_pubkey is not a compressed secp256k1 key');
  if (!parseCompressedPubkey(expect.mintIdentityPubkey)) return fail('DELEGATION_BAD_IDENTITY_KEY', 'the NUT-06 pubkey is not a compressed secp256k1 key');
  if (d.manifest_pubkey === d.mint_identity_pubkey) return fail('DELEGATION_BAD_MANIFEST_KEY', 'the manifest key must differ from the mint identity key');

  if (d.mint_url !== expect.mintUrl) return fail('DELEGATION_MINT_MISMATCH', `delegation is for ${d.mint_url}, not ${expect.mintUrl}`);
  if (d.mint_identity_pubkey !== expect.mintIdentityPubkey) {
    return fail('DELEGATION_IDENTITY_MISMATCH', 'delegation identity is not the mint\'s NUT-06 pubkey');
  }
  const xonly = toHex(identity.slice(1));
  if (d.mint_identity_xonly_pubkey !== undefined && d.mint_identity_xonly_pubkey !== xonly) {
    return fail('DELEGATION_XONLY_MISMATCH', 'mint_identity_xonly_pubkey is not derived from mint_identity_pubkey');
  }

  let valid = false;
  try {
    valid = schnorr.verify(hexBytes(d.signature), sha256(delegationMessage(d)), hexBytes(xonly));
  } catch {
    valid = false;
  }
  if (!valid) return fail('DELEGATION_SIGNATURE_INVALID', 'signature does not verify under the mint identity');

  if (d.manifest_pubkey !== expect.manifestPubkey) return fail('DELEGATION_MANIFEST_KEY_MISMATCH', 'the manifest was signed by a key this delegation does not authorize');
  if (expect.epochIndex < d.valid_from_epoch) return fail('DELEGATION_EPOCH_OUT_OF_SCOPE', `epoch ${expect.epochIndex} precedes valid_from_epoch ${d.valid_from_epoch}`);
  return { ok: true };
}

/** The full authority chain for one epoch manifest: delegation first, then the manifest signature under the delegated key. */
export function verifyDelegatedManifest(
  manifest: ManifestFields,
  manifestSignature: string,
  manifestPubkey: string,
  delegation: ManifestKeyDelegation,
  mint: { mintUrl: string; mintIdentityPubkey: string },
): DelegationResult {
  const d = verifyManifestKeyDelegation(delegation, { ...mint, manifestPubkey, epochIndex: manifest.epoch_index });
  if (!d.ok) return d;
  if (!verifyManifest(manifest, manifestSignature, manifestPubkey)) return fail('MANIFEST_SIGNATURE_INVALID', 'manifest signature does not verify under the delegated key');
  return { ok: true };
}
