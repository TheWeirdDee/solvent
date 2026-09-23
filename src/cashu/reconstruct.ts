// Canonical holder-side NUT-12 reconstruction (Gate 0's mechanism,
// promoted to a reusable module for the verifier and the attack corpus).
// Given ONLY a received proof and the mint's public per-amount key — never
// a mint-supplied opaque identifier — independently reconstruct the exact
// B' and C' the mint signed at issuance, and verify the DLEQ proof.
import { hasValidDleq, hashToCurve, pointFromHex, type Proof } from '@cashu/cashu-ts';
import { SECP256K1_G_HEX } from './gate0.js';

export interface ReconstructResult {
  valid: boolean;
  bPrimeHex?: string;
  cPrimeHex?: string;
  reason?: string;
}

/**
 * @param proof A received Cashu proof, carrying NUT-12 `dleq.e/s/r`.
 * @param keysetId The keyset the proof claims to belong to (checked against `proof.id`).
 * @param amountPublicKeyHex The mint's real per-amount public key for `proof.amount`.
 */
export function reconstruct(proof: Proof, keysetId: string, amountPublicKeyHex: string): ReconstructResult {
  if (proof.id !== keysetId) {
    return { valid: false, reason: `proof keyset "${proof.id}" does not match expected keyset "${keysetId}"` };
  }
  if (!proof.dleq) {
    return { valid: false, reason: 'proof carries no DLEQ data (NUT-12 unsupported)' };
  }
  if (proof.dleq.r === undefined) {
    return { valid: false, reason: 'proof DLEQ data has no blinding factor r; holder cannot verify offline' };
  }

  let dleqOk: boolean;
  try {
    dleqOk = hasValidDleq(proof, { id: keysetId, keys: { [String(proof.amount)]: amountPublicKeyHex } }, { require: true });
  } catch (err) {
    return { valid: false, reason: `DLEQ verification threw: ${(err as Error).message}` };
  }
  if (!dleqOk) {
    return { valid: false, reason: 'DLEQ proof did not verify against the mint keyset' };
  }

  try {
    const A = pointFromHex(amountPublicKeyHex);
    const Y = hashToCurve(new TextEncoder().encode(proof.secret));
    const G = pointFromHex(SECP256K1_G_HEX);
    const r = BigInt('0x' + proof.dleq.r);
    const bPrimeHex = Y.add(G.multiply(r)).toHex(true);
    const cPrimeHex = pointFromHex(proof.C).add(A.multiply(r)).toHex(true);
    return { valid: true, bPrimeHex, cPrimeHex };
  } catch (err) {
    return { valid: false, reason: `reconstruction failed: ${(err as Error).message}` };
  }
}

/** Y = hash_to_curve(secret), the leaf identity used for the SPENT sum-MMR (PR #388). */
export function spentY(secret: string): string {
  return hashToCurve(new TextEncoder().encode(secret)).toHex(true);
}
