// Mint-proof leaf: the holder-verifiable identifier for an issued blind
// signature. Tied to the real C' the holder reconstructs from NUT-12 DLEQ
// data — never an opaque mint-assigned token ID (PRD 10.1, system prompt
// section 6).
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, field, fieldStr, hexToBytes, u64BEFromSats } from '../encode/canonical.js';

const MINT_LEAF_DOMAIN = 'SOLVENT_LEAF_MINT_V1';

export interface MintLeafInput {
  keysetId: string;
  amount: number;
  /** Compressed secp256k1 point, hex — the reconstructed/original blind signature C'. */
  cPrimeHex: string;
}

export function mintLeafHash(input: MintLeafInput): Uint8Array {
  return sha256(
    concatBytes(
      fieldStr(MINT_LEAF_DOMAIN),
      fieldStr(input.keysetId),
      u64BEFromSats(input.amount),
      field(hexToBytes(input.cPrimeHex)),
    ),
  );
}

export function mintLeafSum(amount: number): bigint {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError(`mintLeafSum: ${amount} is not a valid non-negative sats amount`);
  }
  return BigInt(amount);
}
