// Burn-proof leaf: a record of ecash the fixture mint accepted as
// spent/redeemed. Produced by the mint from proofs it actually saw — never
// publishes plaintext user ownership, only a hash of the spent secret
// (PRD 10.1, "Burn-proof leaf").
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, field, fieldStr, hexToBytes, u64BEFromSats } from '../encode/canonical.js';

const BURN_LEAF_DOMAIN = 'SOLVENT_LEAF_BURN_V1';

export interface BurnLeafInput {
  keysetId: string;
  amount: number;
  /** SHA-256 of the spent secret, hex. */
  secretHashHex: string;
}

export function burnLeafHash(input: BurnLeafInput): Uint8Array {
  return sha256(
    concatBytes(
      fieldStr(BURN_LEAF_DOMAIN),
      fieldStr(input.keysetId),
      u64BEFromSats(input.amount),
      field(hexToBytes(input.secretHashHex)),
    ),
  );
}

export function burnLeafSum(amount: number): bigint {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`burnLeafSum: ${amount} is not a valid non-negative sats amount`);
  }
  return BigInt(amount);
}

export function hashSecret(secret: string): string {
  const hex = Array.from(sha256(new TextEncoder().encode(secret)))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return hex;
}
