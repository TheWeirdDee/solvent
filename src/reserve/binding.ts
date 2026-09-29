// SOLVENT Phase 3B — the epoch-scoped reserve binding.
//
// A reserve statement (src/reserve/statement.ts) proves the reserve-control
// key controls some on-chain outputs. On its own it could be attached to any
// accounting state. This binding is signed by the mint's AUTHORIZED manifest
// key (authorized by the mint's NUT-06 identity through a manifest key
// delegation — src/epoch/delegation.ts) and ties one reserve statement to one
// exact closed epoch of one exact mint:
//
//   reserve-control key --signs--> reserve statement
//   manifest key        --signs--> binding(mint, identity, epoch, manifest
//                                  digest, global digest, statement digest,
//                                  reserve key, network, validity window)
//
// Canonical bytes follow the same length-prefixed, fixed-width convention as
// the delegation (docs/manifest-key-delegation.md):
//
//   u16be(len(schema))   || schema          "solvent/reserve-binding/v1"
//   u16be(len(mint_url)) || mint_url
//   mint_identity_pubkey                    33 bytes, compressed (NUT-06)
//   u64be(epoch_index)
//   manifest_digest                         32 bytes
//   global_digest                           32 bytes
//   reserve_statement_digest                32 bytes
//   reserve_pubkey                          32 bytes, x-only (Taproot output key)
//   u16be(len(reserve_network)) || reserve_network
//   u64be(created_at)
//   u64be(valid_until)
//
// Signature: BIP-340 over SHA256(message) by the manifest key.
import { sha256 } from '@noble/hashes/sha2.js';
import { schnorrSignDigest, schnorrVerifyDigest } from '@cashu/cashu-ts';
import { parseCompressedPubkey } from '../epoch/delegation.js';

export const RESERVE_BINDING_SCHEMA = 'solvent/reserve-binding/v1';

export interface ReserveBinding {
  schema: string;
  mint_url: string;
  mint_identity_pubkey: string;
  epoch_index: number;
  manifest_digest: string;
  global_digest: string;
  reserve_statement_digest: string;
  reserve_pubkey: string;
  reserve_network: string;
  created_at: number;
  valid_until: number;
  /** BIP-340 by the authorized manifest key over SHA256(reserveBindingMessage). */
  signature: string;
}

export type ReserveBindingFields = Omit<ReserveBinding, 'schema' | 'signature'>;

const HEX32 = /^[0-9a-f]{64}$/;

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

function lenPrefixed(s: string): Uint8Array[] {
  const bytes = new TextEncoder().encode(s);
  if (bytes.length === 0 || bytes.length > 0xffff) throw new Error('reserve binding: string field length out of range');
  return [new Uint8Array([(bytes.length >> 8) & 0xff, bytes.length & 0xff]), bytes];
}

function u64(n: number): Uint8Array {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError(`reserve binding: not a u64-safe integer: ${n}`);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(n), false);
  return out;
}

function fixed32(hex: string, name: string): Uint8Array {
  if (!HEX32.test(hex)) throw new Error(`reserve binding: ${name} must be 32 bytes of lowercase hex`);
  return hexBytes(hex);
}

/** The exact bytes the manifest key signs. Throws on any malformed field. */
export function reserveBindingMessage(b: ReserveBindingFields): Uint8Array {
  const identity = parseCompressedPubkey(b.mint_identity_pubkey);
  if (!identity) throw new Error('reserve binding: mint_identity_pubkey must be a compressed secp256k1 key');
  if (!/^https?:\/\//.test(b.mint_url)) throw new Error('reserve binding: mint_url must be an http(s) URL');
  if (b.valid_until <= b.created_at) throw new Error('reserve binding: valid_until must be after created_at');
  const parts = [
    ...lenPrefixed(RESERVE_BINDING_SCHEMA),
    ...lenPrefixed(b.mint_url),
    identity,
    u64(b.epoch_index),
    fixed32(b.manifest_digest, 'manifest_digest'),
    fixed32(b.global_digest, 'global_digest'),
    fixed32(b.reserve_statement_digest, 'reserve_statement_digest'),
    fixed32(b.reserve_pubkey, 'reserve_pubkey'),
    ...lenPrefixed(b.reserve_network),
    u64(b.created_at),
    u64(b.valid_until),
  ];
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** SHA256 of the canonical message — the digest that is signed, and the reference a Nostr event commits to. */
export function reserveBindingDigestHex(b: ReserveBindingFields): string {
  return toHex(sha256(reserveBindingMessage(b)));
}

export function signReserveBinding(fields: ReserveBindingFields, manifestPrivateKeyHex: string): ReserveBinding {
  const signature = schnorrSignDigest(reserveBindingDigestHex(fields), manifestPrivateKeyHex);
  return { schema: RESERVE_BINDING_SCHEMA, ...fields, signature };
}

export interface ReserveBindingExpectations {
  /** The AUTHORIZED manifest key (already checked against the mint's delegation). */
  manifestPubkey: string;
  mintUrl: string;
  mintIdentityPubkey: string;
  epochIndex: number;
  manifestDigest: string;
  globalDigest: string;
  reserveStatementDigest: string;
  reservePubkey: string;
  reserveNetwork: string;
  nowSeconds: number;
}

export type ReserveBindingResult = { ok: true } | { ok: false; detail: string };

/** Verifies the signature under the authorized manifest key, then that every bound field is exactly this decision's. */
export function verifyReserveBinding(b: ReserveBinding | null | undefined, expect: ReserveBindingExpectations): ReserveBindingResult {
  if (!b) return { ok: false, detail: 'no reserve binding was supplied' };
  if (b.schema !== RESERVE_BINDING_SCHEMA) return { ok: false, detail: `unexpected reserve binding schema ${String(b.schema)}` };
  let digest: string;
  try {
    digest = reserveBindingDigestHex(b);
  } catch (err) {
    return { ok: false, detail: (err as Error).message };
  }
  let signed = false;
  try {
    signed = schnorrVerifyDigest(b.signature, digest, expect.manifestPubkey);
  } catch {
    signed = false;
  }
  if (!signed) return { ok: false, detail: 'reserve binding is not signed by the authorized manifest key' };
  const mismatches: string[] = [];
  if (b.mint_url !== expect.mintUrl) mismatches.push('mint_url');
  if (b.mint_identity_pubkey !== expect.mintIdentityPubkey) mismatches.push('mint_identity_pubkey');
  if (b.epoch_index !== expect.epochIndex) mismatches.push('epoch_index');
  if (b.manifest_digest !== expect.manifestDigest) mismatches.push('manifest_digest');
  if (b.global_digest !== expect.globalDigest) mismatches.push('global_digest');
  if (b.reserve_statement_digest !== expect.reserveStatementDigest) mismatches.push('reserve_statement_digest');
  if (b.reserve_pubkey !== expect.reservePubkey) mismatches.push('reserve_pubkey');
  if (b.reserve_network !== expect.reserveNetwork) mismatches.push('reserve_network');
  if (mismatches.length > 0) return { ok: false, detail: `reserve binding is signed for a different ${mismatches.join(', ')}` };
  if (expect.nowSeconds < b.created_at || expect.nowSeconds > b.valid_until) {
    return { ok: false, detail: `reserve binding is outside its validity window (${b.created_at}..${b.valid_until}, now ${expect.nowSeconds})` };
  }
  return { ok: true };
}
