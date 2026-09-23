// Signed transactional Proof-of-Liability receipts (Cashu PR #388 / draft
// "Signed Transactional Proof of Liability Receipts" section).
//
// SOLVENT implements only the secp256k1 (version 00/01) signature path —
// BIP-340 Schnorr over SHA256(message), verified against the SAME
// per-amount public key already used for Cashu blind signing
// (`public_keys[amount]`). This is a deliberate bounded slice of the
// draft: no BLS12-381 (version 02) path. See docs/draft-alignment.md.
//
// Message formats are byte-exact to the pinned draft
// (github.com/a1denvalu3/nuts/blob/pol-spec/pol.md, "Message Formats and
// Cryptography") and cross-checked against its official test vectors in
// tests/pol/receipt.test.ts.
import { computeMessageDigest, schnorrSignDigest, schnorrVerifyDigest } from '@cashu/cashu-ts';

export const RECEIPT_ISSUED_PREFIX = 'Cashu_PoL_Receipt_Issued:';
export const RECEIPT_SPENT_PREFIX = 'Cashu_PoL_Receipt_Spent:';

export interface PolReceipt {
  target_epoch: number;
  signature: string;
}

function epochDecimal(targetEpoch: number): string {
  if (!Number.isSafeInteger(targetEpoch) || targetEpoch < 0) {
    throw new RangeError(`target_epoch must be a non-negative safe integer, got ${targetEpoch}`);
  }
  return String(targetEpoch);
}

export function issuedReceiptMessage(bPrimeHex: string, targetEpoch: number): string {
  return `${RECEIPT_ISSUED_PREFIX}${bPrimeHex}:${epochDecimal(targetEpoch)}`;
}

export function spentReceiptMessage(yHex: string, targetEpoch: number): string {
  return `${RECEIPT_SPENT_PREFIX}${yHex}:${epochDecimal(targetEpoch)}`;
}

/** Mint side: sign a receipt promising `bPrimeHex` will appear in `targetEpoch`, using the keyset's per-amount private key. */
export function signIssuedReceipt(bPrimeHex: string, targetEpoch: number, amountPrivateKeyHex: string): PolReceipt {
  const digest = computeMessageDigest(issuedReceiptMessage(bPrimeHex, targetEpoch), true);
  return { target_epoch: targetEpoch, signature: schnorrSignDigest(digest, amountPrivateKeyHex) };
}

export function signSpentReceipt(yHex: string, targetEpoch: number, amountPrivateKeyHex: string): PolReceipt {
  const digest = computeMessageDigest(spentReceiptMessage(yHex, targetEpoch), true);
  return { target_epoch: targetEpoch, signature: schnorrSignDigest(digest, amountPrivateKeyHex) };
}

/**
 * Holder side: verify a receipt actually promises the EXACT `bPrimeHex` the
 * holder independently reconstructed (Gate 0), for the claimed target
 * epoch, against the mint's real per-amount public key. The verifier must
 * not trust `target_epoch` until this returns true (PRD §10.3).
 */
export function verifyIssuedReceipt(receipt: PolReceipt, bPrimeHex: string, amountPublicKeyHex: string): boolean {
  try {
    const digest = computeMessageDigest(issuedReceiptMessage(bPrimeHex, receipt.target_epoch), true);
    return schnorrVerifyDigest(receipt.signature, digest, amountPublicKeyHex);
  } catch {
    return false;
  }
}

export function verifySpentReceipt(receipt: PolReceipt, yHex: string, amountPublicKeyHex: string): boolean {
  try {
    const digest = computeMessageDigest(spentReceiptMessage(yHex, receipt.target_epoch), true);
    return schnorrVerifyDigest(receipt.signature, digest, amountPublicKeyHex);
  } catch {
    return false;
  }
}
