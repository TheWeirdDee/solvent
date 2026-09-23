// Thin wrapper around @cashu/cashu-ts's real NUT-12 implementation.
//
// We do NOT reimplement elliptic-curve math. All DLEQ verification goes
// through cashu-ts's audited functions (which use @noble/curves internally).
// The only thing SOLVENT adds here is:
//   1. a typed, fail-closed wrapper (never throws past this boundary — a
//      malformed proof is DLEQ-invalid, not a crash), and
//   2. holder-side reconstruction of C' (the original blind signature
//      point) using the same C' = C + r*A formula cashu-ts uses internally
//      in verifyDLEQProof_reblind, so we can bind it into our own mint-leaf
//      commitment.
//
// Reference: NUT-12 (https://github.com/cashubtc/nuts/blob/main/12.md) and
// tests/12-tests.md. Verified against the official test vectors in
// dleq.test.ts.
import { hasValidDleq, pointFromHex, type Keys, type Proof } from '@cashu/cashu-ts';
import { bytesToHex } from '../encode/canonical.js';

export interface DleqCheckResult {
  /** True only if the proof carries usable NUT-12 data AND it verifies. */
  valid: boolean;
  /** Reconstructed original blind signature point C', compressed hex — only present when valid. */
  cPrimeHex?: string;
  reason?: string;
}

/**
 * Holder-side NUT-12 check: verifies the proof's DLEQ data against the
 * mint's per-amount public key, then reconstructs C' = C + r*A.
 *
 * Per PRD 10.1.2 / trust-assumptions: a proof without usable DLEQ data
 * (missing dleq, or missing dleq.r) cannot be independently tied to its
 * mint issuance, so it is treated as unsupported / invalid here. Callers
 * must turn `valid: false` into RED.
 */
export function checkDleqAndReconstructCPrime(proof: Proof, keys: Keys): DleqCheckResult {
  if (!proof.dleq) {
    return { valid: false, reason: 'proof carries no DLEQ data (NUT-12 unsupported)' };
  }
  if (proof.dleq.r === undefined) {
    return { valid: false, reason: 'proof DLEQ data has no blinding factor r; holder cannot verify offline' };
  }

  const keyset = { id: proof.id, keys };

  let dleqOk: boolean;
  try {
    dleqOk = hasValidDleq(proof, keyset, { require: true });
  } catch (err) {
    return { valid: false, reason: `DLEQ verification threw: ${(err as Error).message}` };
  }
  if (!dleqOk) {
    return { valid: false, reason: 'DLEQ proof did not verify against the mint keyset' };
  }

  const amountKeyHex = keys[String(proof.amount)];
  if (!amountKeyHex) {
    return { valid: false, reason: `no mint key for amount ${proof.amount} in keyset ${proof.id}` };
  }

  try {
    const A = pointFromHex(amountKeyHex);
    const C = pointFromHex(proof.C);
    const r = BigInt('0x' + proof.dleq.r);
    const cPrime = C.add(A.multiply(r));
    return { valid: true, cPrimeHex: cPrime.toHex(true) };
  } catch (err) {
    return { valid: false, reason: `C' reconstruction failed: ${(err as Error).message}` };
  }
}
